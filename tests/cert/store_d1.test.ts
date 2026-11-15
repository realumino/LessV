/**
 * D1 store tests for the certificate tables, adapted from certworker's
 * store-d1.spec.ts to the LessV schema (environment column, is_current,
 * created_at on runs, node assignment).
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  activateCertificate,
  ActiveIssueRunError,
  createCertDomain,
  createIssueRun,
  deleteNodeCertDomainAssignments,
  finishIssueRun,
  getAcmeAccount,
  getCertificate,
  getCurrentCertificate,
  getIssueRun,
  insertChallengeRecord,
  listCurrentCertificates,
  listExpiredStagingCertificates,
  listNodeAssignedDomains,
  listNodeCertDomains,
  listPendingChallengeRecords,
  listUnpurgedProductionCertificates,
  markCertificatePurged,
  markChallengeRecordDeleted,
  recordRunPhase,
  replaceNodeCertDomains,
  saveAcmeAccount,
  type CertificateRow,
} from "../../src/cert/store/d1";

describe("D1 persistence", () => {
  it("records run phases and finalizes a run idempotently", async () => {
    const domain = await seedDomain();
    const runId = crypto.randomUUID();
    await createIssueRun(env.DB, {
      id: runId,
      domain_id: domain.id,
      environment: "production",
      workflow_id: `manual-${runId}`,
      trigger: "manual",
    });

    await recordRunPhase(env.DB, runId, "load");
    await recordRunPhase(env.DB, runId, "new-order");
    const running = await getIssueRun(env.DB, runId);
    expect(running).toMatchObject({ status: "running", phase: "new-order" });
    expect(JSON.parse(running?.steps_json ?? "[]")).toHaveLength(2);

    await finishIssueRun(env.DB, runId, domain.id, { status: "succeeded" });
    await finishIssueRun(env.DB, runId, domain.id, { status: "succeeded" });
    expect(await getIssueRun(env.DB, runId)).toMatchObject({
      status: "succeeded",
      phase: "complete",
      error: null,
    });
  });

  it("uses the active-run partial unique index to serialize issuance", async () => {
    const domain = await seedDomain();
    const firstRun = crypto.randomUUID();
    await createIssueRun(env.DB, {
      id: firstRun,
      domain_id: domain.id,
      environment: "staging",
      workflow_id: `test-${firstRun}`,
      trigger: "test",
    });

    const secondRun = crypto.randomUUID();
    await expect(
      createIssueRun(env.DB, {
        id: secondRun,
        domain_id: domain.id,
        environment: "production",
        workflow_id: `manual-${secondRun}`,
        trigger: "manual",
      }),
    ).rejects.toBeInstanceOf(ActiveIssueRunError);

    await finishIssueRun(env.DB, firstRun, domain.id, {
      status: "failed",
      error: "test failure",
    });
    await createIssueRun(env.DB, {
      id: secondRun,
      domain_id: domain.id,
      environment: "production",
      workflow_id: `manual-${secondRun}`,
      trigger: "manual",
    });
    expect(await getIssueRun(env.DB, secondRun)).toMatchObject({ status: "queued" });
  });

  it("atomically flips the current certificate and marks purged history", async () => {
    const domain = await seedDomain();
    const first = certificate(domain.id, "production", "a".repeat(64));
    const second = certificate(domain.id, "production", "b".repeat(64));

    await activateCertificate(env.DB, first);
    expect(await getCurrentCertificate(env.DB, domain.id, "production")).toMatchObject({
      id: first.id,
      is_current: 1,
    });

    await activateCertificate(env.DB, second);
    expect(await getCertificate(env.DB, first.id)).toMatchObject({ is_current: 0 });
    expect(await getCurrentCertificate(env.DB, domain.id, "production")).toMatchObject({
      id: second.id,
      is_current: 1,
    });

    await markCertificatePurged(env.DB, first.id);
    expect(await getCertificate(env.DB, first.id)).toMatchObject({
      purged_at: expect.any(String),
    });

    await expect(
      activateCertificate(env.DB, { ...second, fingerprint_sha256: "c".repeat(64) }),
    ).rejects.toThrow("already in use");
  });

  it("isolates currents per environment and filters sweeps by it", async () => {
    const domain = await seedDomain();
    const staging = certificate(domain.id, "staging", "a".repeat(64));
    const production = certificate(domain.id, "production", "b".repeat(64));
    await activateCertificate(env.DB, staging);
    await activateCertificate(env.DB, production);

    const productionCurrents = await listCurrentCertificates(env.DB, "production");
    // Shared test D1: assert on this domain's rows, not the global list.
    const domainProduction = productionCurrents.filter((row) => row.domain_id === domain.id);
    expect(domainProduction.map((row) => row.id)).toEqual([production.id]);
    expect(domainProduction.every((row) => row.environment === "production")).toBe(true);

    // Staging current is visible to the staging sweep when old enough, and
    // the production purge list never contains a current.
    const otherDomain = await seedDomain();
    const old = certificate(otherDomain.id, "staging", "c".repeat(64));
    old.created_at = "2026-01-01T00:00:00.000Z";
    await activateCertificate(env.DB, old);
    const expired = await listExpiredStagingCertificates(env.DB, "2026-01-02T00:00:00.000Z");
    expect(expired.some((row) => row.id === old.id)).toBe(true);

    const unpurged = await listUnpurgedProductionCertificates(env.DB);
    expect(unpurged.some((row) => row.domain_id === domain.id || row.is_current === 1)).toBe(
      false,
    );
  });

  it("persists one ACME account per environment and tracks TXT cleanup", async () => {
    const domain = await seedDomain();
    const runId = crypto.randomUUID();
    await createIssueRun(env.DB, {
      id: runId,
      domain_id: domain.id,
      environment: "production",
      workflow_id: `manual-${runId}`,
      trigger: "manual",
    });

    await saveAcmeAccount(env.DB, {
      environment: "staging",
      directory_url: "https://acme-staging-v02.api.letsencrypt.org/directory",
      account_url: "https://acme.example/account/1",
      private_key: "v1:sealed",
      public_jwk: '{"kty":"EC"}',
      thumbprint: "t".repeat(43),
    });
    expect(await getAcmeAccount(env.DB, "staging")).toMatchObject({
      account_url: "https://acme.example/account/1",
    });

    await insertChallengeRecord(env.DB, {
      id: crypto.randomUUID(),
      run_id: runId,
      zone_id: domain.zone_id,
      cf_record_id: "cf-record-1",
      name: `_acme-challenge.${domain.name}`,
      value: "challenge-value",
    });
    const [record] = await listPendingChallengeRecords(env.DB, runId);
    expect(record).toMatchObject({ cf_record_id: "cf-record-1", deleted_at: null });
    await markChallengeRecordDeleted(env.DB, record.id);
    expect(await listPendingChallengeRecords(env.DB, runId)).toEqual([]);
  });

  it("replaces node assignments and joins the current certificate of the requested environment", async () => {
    const domainA = await seedDomain("a");
    const domainB = await seedDomain("b");
    const nodeId = crypto.randomUUID();

    await replaceNodeCertDomains(env.DB, nodeId, [domainA.id, domainB.id], 1000);
    expect((await listNodeCertDomains(env.DB, nodeId)).map((row) => row.domain_id).sort()).toEqual(
      [domainA.id, domainB.id].sort(),
    );

    const production = certificate(domainB.id, "production", "b".repeat(64));
    await activateCertificate(env.DB, production);
    const assigned = await listNodeAssignedDomains(env.DB, nodeId, "production");
    expect(assigned.map((row) => row.domain_name).sort()).toEqual(
      [domainA.name, domainB.name].sort(),
    );
    const rowB = assigned.find((row) => row.domain_id === domainB.id);
    expect(rowB).toMatchObject({
      certificate_id: production.id,
      certificate_fingerprint_sha256: "b".repeat(64),
    });
    expect(assigned.find((row) => row.domain_id === domainA.id)?.certificate_id).toBeNull();

    // The same assignment read for staging: no current pointer, no certificate.
    const stagingRows = await listNodeAssignedDomains(env.DB, nodeId, "staging");
    expect(stagingRows.map((row) => row.certificate_id)).toEqual([null, null]);

    await replaceNodeCertDomains(env.DB, nodeId, [], 2000);
    expect(await listNodeCertDomains(env.DB, nodeId)).toEqual([]);

    await deleteNodeCertDomainAssignments(env.DB, domainB.id);
    expect(await listNodeCertDomains(env.DB, crypto.randomUUID())).toEqual([]);
  });
});

async function seedDomain(suffix = ""): Promise<{ id: string; name: string; zone_id: string }> {
  const id = crypto.randomUUID();
  const name = `store-d1-${id.slice(0, 6)}${suffix}.example.com`;
  await createCertDomain(env.DB, {
    id,
    name,
    zone_id: "zone-1",
    include_wildcard: 0,
    acme_profile: "tlsserver",
    renew_before_days: null,
  });
  return { id, name, zone_id: "zone-1" };
}

function certificate(domainId: string, environment: string, fingerprint: string): CertificateRow {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    domain_id: domainId,
    environment: environment as CertificateRow["environment"],
    serial: "abc123",
    fingerprint_sha256: fingerprint,
    sans_json: '["example.com"]',
    not_before: now,
    not_after: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString(),
    profile: "tlsserver",
    issued_at: now,
    is_current: 0,
    purged_at: null,
    created_at: now,
  };
}
