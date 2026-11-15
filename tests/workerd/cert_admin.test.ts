/**
 * HTTP-tier tests for issuance and artifact endpoints: confirm gating,
 * environment isolation, run views, downloads.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { planeFetch, planeJson } from "../helpers";
import { seedIssueRun } from "../cert/support/fixtures";
import { seedCertificate } from "../cert/support/fixtures";

async function seedDomain(name?: string, status: "active" | "paused" = "active") {
  const id = crypto.randomUUID();
  const name0 = name ?? `admin-${crypto.randomUUID().slice(0, 6)}.example.com`;
  await env.DB.prepare(
    `INSERT INTO cert_domains (
       id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
       status, last_error, created_at, updated_at
     ) VALUES (?, ?, 'zone-test', 0, 'tlsserver', NULL, ?, NULL, ?, ?)`,
  ).bind(id, name0, status, new Date().toISOString(), new Date().toISOString()).run();
  return { id, name: name0 };
}

describe("POST issue / test-issue", () => {
  it("issue requires an exact confirm; test-issue does not", async () => {
    const domain = await seedDomain();
    const badConfirm = await planeJson(
      "POST",
      `/api/admin/cert-domains/${domain.id}/issue`,
      { confirm: "wrong.example.com" },
    );
    expect(badConfirm.status).toBe(400);

    const issued = await planeJson("POST", `/api/admin/cert-domains/${domain.id}/issue`, {
      confirm: domain.name,
    });
    expect(issued.status).toBe(202);
    const issuedBody = (await issued.json()) as Record<string, unknown>;
    expect(issuedBody).toMatchObject({
      status: "queued",
      environment: "production",
    });
    expect(String(issuedBody.workflow_id)).toContain("manual-");

    // Same domain: the active run blocks both kinds.
    const blocked = await planeJson("POST", `/api/admin/cert-domains/${domain.id}/issue`, {
      confirm: domain.name,
    });
    expect(blocked.status).toBe(409);
    const blockedTest = await planeFetch(`/api/admin/cert-domains/${domain.id}/test-issue`, {
      method: "POST",
    });
    expect(blockedTest.status).toBe(409);

    // The staging path on a free domain flips environment to staging.
    const domain2 = await seedDomain();
    const tested = await planeFetch(`/api/admin/cert-domains/${domain2.id}/test-issue`, {
      method: "POST",
    });
    expect(tested.status).toBe(202);
    expect(((await tested.json()) as Record<string, unknown>).environment).toBe("staging");
  });

  it("unknown domain 404", async () => {
    const response = await planeFetch(`/api/admin/cert-domains/${crypto.randomUUID()}/test-issue`, {
      method: "POST",
    });
    expect(response.status).toBe(404);
  });
});

describe("runs and certificates", () => {
  it("lists runs newest-first with steps and verbatim errors", async () => {
    const domain = await seedDomain();
    const stagingRun = await seedIssueRun(env.DB, domain.id, "test", "staging");
    await env.DB.prepare(
      "UPDATE issue_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
    ).bind(
      '{"type":"urn:ietf:params:acme:error:caa","detail":"CAA error"}',
      new Date().toISOString(),
      stagingRun.runId,
    ).run();
    // The production run stays active; it must be the second in the list.
    await seedIssueRun(env.DB, domain.id, "manual", "production");

    const response = await planeFetch(`/api/admin/cert-domains/${domain.id}/runs`);
    expect(response.status).toBe(200);
    const runs = (await response.json()) as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(2);
    // Newest first: the production run was seeded last.
    expect(runs[0]).toMatchObject({ trigger: "manual", environment: "production", status: "queued" });
    expect(runs[1]).toMatchObject({ trigger: "test", environment: "staging", status: "failed" });
    expect(runs[1]["error"]).toContain("CAA");
  });

  it("run detail 404 for unknown ids", async () => {
    const response = await planeFetch(`/api/admin/cert-runs/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });

  it("certificate download: fullchain and key; missing artifacts 500", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    const cert = await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: true,
      sans: [domain.name],
    });

    const fullchain = await planeFetch(`/api/admin/certificates/${cert.id}/download?file=fullchain`);
    expect(fullchain.status).toBe(200);
    expect(await fullchain.text()).toContain("FULLCHAIN PEM");
    expect(fullchain.headers.get("cache-control")).toBe("no-store");

    const key = await planeFetch(`/api/admin/certificates/${cert.id}/download?file=key`);
    expect(key.status).toBe(200);
    expect(await key.text()).toContain("PRIVATE KEY");

    const badFile = await planeFetch(`/api/admin/certificates/${cert.id}/download?file=oops`);
    expect(badFile.status).toBe(422);

    // A row whose bytes were swept has no artifacts: 500 naming the row and
    // the field, because the certificate exists and the request was valid.
    await env.DB.prepare("UPDATE certificates SET is_current = 0, purged_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), cert.id).run();
    await env.DB.prepare("DELETE FROM certificate_artifacts WHERE certificate_id = ?")
      .bind(cert.id).run();
    const missing = await planeFetch(`/api/admin/certificates/${cert.id}/download?file=fullchain`);
    expect(missing.status).toBe(500);
    const detail = (await missing.json()) as { detail?: string };
    expect(detail.detail).toContain(cert.id);
    expect(detail.detail).toContain("fullchain_pem");
  });

  it("domain certificate list separates environments with is_current", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: true,
      sans: [domain.name],
    });
    await seedCertificate(env.DB, domain.id, {
      environment: "staging",
      current: false,
      sans: [domain.name],
    });

    const response = await planeFetch(`/api/admin/cert-domains/${domain.id}/certs`);
    expect(response.status).toBe(200);
    const certs = (await response.json()) as Array<Record<string, unknown>>;
    expect(certs).toHaveLength(2);
    expect(certs[0]).toMatchObject({ environment: "staging", is_current: false });
    expect(certs[1]).toMatchObject({ environment: "production", is_current: true });
  });
});
