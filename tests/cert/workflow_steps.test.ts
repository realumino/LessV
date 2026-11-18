/**
 * Issuance workflow steps tests, adapted from certworker's
 * workflow-steps.spec.ts: full staging issuance through the offline ACME +
 * DNS mocks, artifacts sealed with key_cipher, environment isolation, and
 * failure cleanup.
 */

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createScriptedFetch } from "./support/fake-fetch";
import {
  seedActiveDnsCredential,
  seedCertificate,
  seedCertDomain,
  seedIssueRun,
} from "./support/fixtures";
import { MockAcme, type MockAcmeOptions } from "./support/mock-acme";
import { MockCloudflareDns } from "./support/mock-dns";
import {
  acceptChallenges,
  checkAuthorizations,
  checkOrderReadiness,
  checkOrderValidity,
  checkTxtPropagation,
  cleanupFailedArtifacts,
  cleanupTxtRecords,
  createIssueDependencies,
  createLeafKeyAndCsr,
  createOrder,
  ensureAcmeAccount,
  finalizeOrder,
  issueErrorMessage,
  loadIssue,
  propagationWindow,
  publishTxtChallenges,
  purgePreviousCertificate,
  storeIssuedCertificate,
  type IssueDependencies,
} from "../../src/cert/issue/steps";
import {
  finishIssueRun,
  getCertificate,
  getCertificateArtifacts,
  getCurrentCertificate,
  getIssueRun,
  listPendingChallengeRecords,
} from "../../src/cert/store/d1";

describe("issuance workflow steps", () => {
  beforeAll(async () => {
    // WHY: every DNS call resolves the active sealed row, and there is no env
    // fallback left; without one these steps fail before reaching the mocks.
    await seedActiveDnsCredential(env.DB);
  });

  it("removes a key row when issuance fails before the certificate is committed in D1", async () => {
    const domain = await seedCertDomain(env.DB, { includeWildcard: false });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const { deps } = makeDependencies({});
    const loaded = await loadIssue(deps, runId, domain.id);
    const leaf = await createLeafKeyAndCsr(deps, runId, loaded.identifiers);

    expect(await getCertificateArtifacts(env.DB, leaf.certificateId)).toMatchObject({
      certificate_id: runId,
      cert_pem: null,
    });
    await expect(cleanupFailedArtifacts(deps, runId)).resolves.toEqual({ deleted: true });
    expect(await getCertificateArtifacts(env.DB, leaf.certificateId)).toBeNull();
  });

  it("issues, persists, activates, purges the previous artifacts, and cleans TXT records", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId } = await seedIssueRun(env.DB, domain.id, "manual", "staging");
    const oldCertId = crypto.randomUUID();
    await seedCertificate(env.DB, domain.id, {
      id: oldCertId,
      environment: "staging",
      current: true,
    });

    const { deps, dns, requests } = makeDependencies({});
    const loaded = await loadIssue(deps, runId, domain.id);
    expect(loaded.previousCertificate?.id).toBe(oldCertId);
    expect(loaded.identifiers.map(({ value }) => value)).toEqual([domain.name, `*.${domain.name}`]);

    await ensureAcmeAccount(deps);
    const order = await createOrder(deps, loaded.identifiers);
    const published = await publishTxtChallenges(
      deps,
      runId,
      loaded.domain,
      order.authorizations,
    );
    expect(published.targets).toHaveLength(1);
    expect(published.targets[0].values).toHaveLength(2);
    expect(dns.records).toHaveLength(2);

    await expect(checkTxtPropagation(deps, published)).resolves.toBe(true);
    await acceptChallenges(deps, published);
    await expect(checkAuthorizations(deps, published)).resolves.toBe(true);
    const leaf = await createLeafKeyAndCsr(deps, runId, loaded.identifiers);
    const issued = await finishIssuance(deps, loaded, order, leaf);
    const purge = await purgePreviousCertificate(deps, loaded.previousCertificate);
    const cleanup = await cleanupTxtRecords(deps, runId);
    await finishIssueRun(env.DB, runId, domain.id, { status: "succeeded" }, {
      recordDomainError: false,
    });

    const current = await getCurrentCertificate(env.DB, domain.id, "staging");
    expect(current).toMatchObject({ id: runId, is_current: 1, environment: "staging" });
    expect(JSON.parse(current?.sans_json ?? "[]")).toEqual(
      loaded.identifiers.map(({ value }) => value),
    );
    expect(issued).toMatchObject({
      certificateId: runId,
      sans: loaded.identifiers.map(({ value }) => value),
      profile: "tlsserver",
    });
    expect(await getCertificate(env.DB, oldCertId)).toMatchObject({
      is_current: 0,
      purged_at: expect.any(String),
    });
    expect(await getCertificateArtifacts(env.DB, oldCertId)).toBeNull();

    const artifacts = await getCertificateArtifacts(env.DB, issued.certificateId);
    expect(artifacts).toMatchObject({
      certificate_id: issued.certificateId,
      cert_pem: expect.stringContaining("BEGIN CERTIFICATE"),
      fullchain_pem: expect.stringContaining("BEGIN CERTIFICATE"),
    });
    expect(artifacts?.chain_pem).toBeTypeOf("string");
    expect(artifacts?.private_key ?? "").not.toContain("BEGIN PRIVATE KEY");
    expect(artifacts?.private_key ?? "").toMatch(/^v1:/);
    const accounts = await env.DB.prepare("SELECT environment FROM acme_accounts").all();
    expect(accounts.results).toHaveLength(1);
    expect(purge).toEqual({ purged: true });
    expect(cleanup.deleted).toBe(2);
    expect(dns.records).toHaveLength(0);
    expect(await listPendingChallengeRecords(env.DB, runId)).toEqual([]);
    expect(await getIssueRun(env.DB, runId)).toMatchObject({ status: "succeeded" });
    expect(requests.some(({ url }) => url.origin === "https://dns.google")).toBe(true);
  });

  it("keeps production state untouched by a staging run and vice versa", async () => {
    const domain = await seedCertDomain(env.DB, { includeWildcard: false });
    const productionCurrent = await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: true,
    });

    const { deps } = makeDependencies({}); // staging directory by default
    const { runId } = await seedIssueRun(env.DB, domain.id, "test", "staging");
    const loaded = await loadIssue(deps, runId, domain.id);
    expect(loaded.previousCertificate).toBeNull();

    await ensureAcmeAccount(deps);
    const order = await createOrder(deps, loaded.identifiers);
    const published = await publishTxtChallenges(deps, runId, loaded.domain, order.authorizations);
    await expect(checkTxtPropagation(deps, published)).resolves.toBe(true);
    await acceptChallenges(deps, published);
    await expect(checkAuthorizations(deps, published)).resolves.toBe(true);
    const leaf = await createLeafKeyAndCsr(deps, runId, loaded.identifiers);
    await finishIssuance(deps, loaded, order, leaf);

    const stagingCurrent = await getCurrentCertificate(env.DB, domain.id, "staging");
    expect(stagingCurrent).not.toBeNull();
    const stillProduction = await getCurrentCertificate(env.DB, domain.id, "production");
    expect(stillProduction?.id).toBe(productionCurrent.id);
  });

  it("preserves an invalid authorization problem and cleans published TXT records", async () => {
    const domain = await seedCertDomain(env.DB, { includeWildcard: false });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const { deps, dns } = makeDependencies({ invalidAuthorization: true });
    const loaded = await loadIssue(deps, runId, domain.id);
    await ensureAcmeAccount(deps);
    const order = await createOrder(deps, loaded.identifiers);
    const published = await publishTxtChallenges(deps, runId, loaded.domain, order.authorizations);
    await expect(checkTxtPropagation(deps, published)).resolves.toBe(true);
    await acceptChallenges(deps, published);

    let failure: unknown;
    try {
      await checkAuthorizations(deps, published);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const error = issueErrorMessage(failure);
    expect(error).toContain('"type":"urn:ietf:params:acme:error:unauthorized"');
    expect(error).toContain("mock authorization rejected");

    await cleanupTxtRecords(deps, runId);
    await finishIssueRun(env.DB, runId, domain.id, { status: "failed", error }, {
      recordDomainError: false,
    });

    expect((await getIssueRun(env.DB, runId))?.error).toBe(error);
    expect(await getCurrentCertificate(env.DB, domain.id, "staging")).toBeNull();
    expect(dns.records).toHaveLength(0);
    expect(await listPendingChallengeRecords(env.DB, runId)).toEqual([]);
  });

  it("fails a propagation check loudly when every resolver errors", async () => {
    // WHY: a failed fetch is not evidence that DNS has not propagated.
    // Looping on it burns the run's subrequest budget and reports a DNS
    // timeout; the real cause (usually budget exhaustion) must surface.
    const domain = await seedCertDomain(env.DB, { includeWildcard: false });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const { deps } = makeDependencies({});
    const loaded = await loadIssue(deps, runId, domain.id);
    await ensureAcmeAccount(deps);
    const order = await createOrder(deps, loaded.identifiers);
    const published = await publishTxtChallenges(deps, runId, loaded.domain, order.authorizations);

    const broken: IssueDependencies = {
      ...deps,
      fetcher: async () => {
        throw new Error("Too many subrequests by single Worker invocation");
      },
    };
    await expect(checkTxtPropagation(broken, published)).rejects.toThrow(
      /Too many subrequests/,
    );
  });

  it("keeps the propagation poll inside the subrequest budget", () => {
    // WHY: a Workflow instance has a hard subrequest budget (50 on the free
    // plan), and each check costs one fetch per resolver. The window must
    // stay what the operator configured while the number of questions stays
    // affordable — a run that spends its budget on propagation cannot clean
    // up its own TXT records.
    const window = propagationWindow({
      dnsTimeoutMs: 300_000,
      dnsPollIntervalMs: 5_000,
      dnsSettleMs: 10_000,
      dnsRequestTimeoutMs: 10_000,
      acmeTimeoutMs: 300_000,
      acmePollIntervalMs: 3_000,
      acmeRequestTimeoutMs: 30_000,
    });
    expect(window.attempts).toBe(10);
    // 10 checks x 2 resolvers leaves 30 of 50 for the rest of the run.
    expect(window.attempts * 2).toBeLessThanOrEqual(20);
    // The time window is preserved: the last check still lands near the
    // configured timeout.
    expect(window.attempts * window.intervalMs).toBeGreaterThanOrEqual(300_000);
    // The first question waits for the record to be live: asking earlier is
    // answered from a negative cache for the zone's whole TTL.
    expect(window.initialDelayMs).toBeGreaterThan(0);
    expect(window.initialDelayMs).toBeLessThan(window.intervalMs);
  });

  it("treats an empty answer as not yet visible rather than an error", async () => {
    // WHY: NODATA is the normal answer before propagation; only resolver
    // *errors* are infrastructure failures.
    const domain = await seedCertDomain(env.DB, { includeWildcard: false });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const { deps } = makeDependencies({});
    const loaded = await loadIssue(deps, runId, domain.id);
    await ensureAcmeAccount(deps);
    const order = await createOrder(deps, loaded.identifiers);
    const published = await publishTxtChallenges(deps, runId, loaded.domain, order.authorizations);

    const empty: IssueDependencies = {
      ...deps,
      fetcher: async () =>
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          headers: { "Content-Type": "application/dns-json" },
        }),
    };
    await expect(checkTxtPropagation(empty, published)).resolves.toBe(false);
  });
});

/**
 * WHAT: drive the durable single-pass steps to a stored certificate.
 *
 * WHY a helper: the workflow polls each check through durable steps; these
 * tests run the same calls in a tight loop against instant mock responses.
 */
async function finishIssuance(
  deps: IssueDependencies,
  loaded: Awaited<ReturnType<typeof loadIssue>>,
  order: Awaited<ReturnType<typeof createOrder>>,
  leaf: Awaited<ReturnType<typeof createLeafKeyAndCsr>>,
) {
  const ready = await checkOrderReadiness(deps, order);
  expect(ready).not.toBeNull();
  await finalizeOrder(deps, order, ready!, leaf);
  let valid = await checkOrderValidity(deps, order);
  for (let attempt = 0; valid === null && attempt < 5; attempt += 1) {
    valid = await checkOrderValidity(deps, order);
  }
  expect(valid).not.toBeNull();
  return storeIssuedCertificate(deps, loaded.domain, loaded.identifiers, order, leaf, valid!);
}

function makeDependencies(options: MockAcmeOptions): {
  deps: IssueDependencies;
  dns: MockCloudflareDns;
  requests: ReturnType<typeof createScriptedFetch>["requests"];
} {
  const acme = new MockAcme(options);
  const dns = new MockCloudflareDns();
  const scripted = createScriptedFetch(async (request) => {
    const acmeResponse = await acme.handle(request);
    if (acmeResponse) return acmeResponse;
    const dnsResponse = await dns.handle(request);
    if (dnsResponse) return dnsResponse;
    throw new Error(`No offline mock for ${request.request.method} ${request.url.href}`);
  });
  return {
    deps: createIssueDependencies(env, "staging", {
      fetcher: scripted.fetch,
      timings: {
        dnsTimeoutMs: 1_000,
        dnsPollIntervalMs: 1,
        dnsSettleMs: 0,
        dnsRequestTimeoutMs: 100,
        acmeTimeoutMs: 1_000,
        acmePollIntervalMs: 1,
        acmeRequestTimeoutMs: 1_000,
      },
    }),
    dns,
    requests: scripted.requests,
  };
}
