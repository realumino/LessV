/**
 * Schema contract tests for the certificate tables.
 *
 * WHY a dedicated file: the DDL in migrations/0005/0006 is part of the
 * product contract — the partial unique indexes ARE the staging/production
 * isolation and the one-active-run lock, so a refactor that quietly drops
 * one must fail loudly here, not in an issuance race on a real domain.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  ActiveIssueRunError,
  createCertDomain,
  createIssueRun,
  activateCertificate,
  getAcmeAccount,
  saveAcmeAccount,
  type CertificateRow,
} from "../../src/cert/store/d1";

describe("cert schema", () => {
  it("has every certificate table with its columns", async () => {
    const { results } = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('cert_domains','certificates','acme_accounts','issue_runs',
                     'challenge_records','node_cert_domains')`,
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual([
      "acme_accounts",
      "cert_domains",
      "certificates",
      "challenge_records",
      "issue_runs",
      "node_cert_domains",
    ]);

    const certColumns = await tableColumns("certificates");
    for (const column of [
      "environment",
      "profile",
      "is_current",
      "purged_at",
      "created_at",
      "r2_prefix",
    ]) {
      expect(certColumns).toContain(column);
    }
    const domainColumns = await tableColumns("cert_domains");
    expect(domainColumns).toContain("acme_profile");
    expect(domainColumns).toContain("last_error");
    const accountColumns = await tableColumns("acme_accounts");
    for (const column of ["environment", "directory_url", "public_jwk", "thumbprint"]) {
      expect(accountColumns).toContain(column);
    }
    const runColumns = await tableColumns("issue_runs");
    expect(runColumns).toContain("environment");
    expect(runColumns).toContain("created_at");
  });

  it("has the nginx/cert status columns on nodes", async () => {
    const columns = await tableColumns("nodes");
    for (const column of ["nginx_ok", "nginx_error", "cert_etag", "cert_synced_at"]) {
      expect(columns).toContain(column);
    }
  });

  it("keeps the partial indexes that encode isolation and the run lock", async () => {
    const { results: indexes } = await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
    ).all<{ name: string; sql: string }>();
    const byName = new Map(indexes.map((index) => [index.name, index.sql]));

    expect(byName.get("idx_cert_current_env")).toContain(
      "ON certificates(domain_id, environment) WHERE is_current = 1",
    );
    expect(byName.get("idx_run_active")).toContain(
      "ON issue_runs(domain_id) WHERE status IN ('queued', 'running')",
    );
    expect(byName.get("idx_challenge_run")).toContain("ON challenge_records(run_id, deleted_at)");
  });

  it("locks one active run per domain across environments", async () => {
    const domainId = crypto.randomUUID();
    await createCertDomain(env.DB, {
      id: domainId,
      name: `lock-${domainId.slice(0, 6)}.example.com`,
      zone_id: "zone",
      include_wildcard: 0,
      acme_profile: "tlsserver",
      renew_before_days: null,
    });

    const stagingRun = crypto.randomUUID();
    await createIssueRun(env.DB, {
      id: stagingRun,
      domain_id: domainId,
      environment: "staging",
      workflow_id: `test-${stagingRun}`,
      trigger: "test",
    });
    const productionRun = crypto.randomUUID();
    // Same domain, different environment: still blocked — the TXT names collide.
    await expect(
      createIssueRun(env.DB, {
        id: productionRun,
        domain_id: domainId,
        environment: "production",
        workflow_id: `manual-${productionRun}`,
        trigger: "manual",
      }),
    ).rejects.toBeInstanceOf(ActiveIssueRunError);
  });

  it("allows one current certificate per domain AND environment", async () => {
    const domainId = crypto.randomUUID();
    await createCertDomain(env.DB, {
      id: domainId,
      name: `idx-${domainId.slice(0, 6)}.example.com`,
      zone_id: "zone",
      include_wildcard: 0,
      acme_profile: "tlsserver",
      renew_before_days: null,
    });

    const staging = certificate(domainId, "staging", "a".repeat(64));
    const production = certificate(domainId, "production", "b".repeat(64));
    await activateCertificate(env.DB, staging);
    await activateCertificate(env.DB, production);

    // One current in EACH environment is fine (two rows); a second current
    // in the SAME environment violates idx_cert_current_env.
    const duplicate = certificate(domainId, "staging", "c".repeat(64));
    duplicate.is_current = 1;
    await expect(
      env.DB.prepare(
        `INSERT INTO certificates (
           id, domain_id, environment, serial, fingerprint_sha256, sans_json,
           not_before, not_after, profile, issued_at, r2_prefix, is_current, created_at
         ) VALUES (?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      ).bind(
        duplicate.id,
        domainId,
        duplicate.serial,
        duplicate.fingerprint_sha256,
        duplicate.sans_json,
        duplicate.not_before,
        duplicate.not_after,
        duplicate.profile,
        duplicate.issued_at,
        duplicate.r2_prefix,
        duplicate.created_at,
      ).run(),
    ).rejects.toThrow(/UNIQUE|idx_cert_current/);

    const currents = await env.DB.prepare(
      "SELECT environment FROM certificates WHERE domain_id = ? AND is_current = 1 ORDER BY environment",
    ).bind(domainId).all<{ environment: string }>();
    expect(currents.results.map((row) => row.environment)).toEqual(["production", "staging"]);
  });

  it("round-trips one sealed ACME account per environment", async () => {
    const account = {
      environment: "production" as const,
      directory_url: "https://acme-v02.api.letsencrypt.org/directory",
      account_url: `https://acme.example/account/${crypto.randomUUID()}`,
      private_key: "v1:sealed-account-key",
      public_jwk: '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
      thumbprint: "t".repeat(43),
    };
    await saveAcmeAccount(env.DB, account);
    const stored = await getAcmeAccount(env.DB, "production");
    expect(stored).toMatchObject({
      account_url: account.account_url,
      private_key: "v1:sealed-account-key",
      thumbprint: account.thumbprint,
    });
    expect(await getAcmeAccount(env.DB, "staging")).toBeNull();
  });
});

async function tableColumns(table: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return results.map((row) => row.name);
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
    r2_prefix: `certs/production/example.com/${environment}`,
    is_current: 0,
    purged_at: null,
    created_at: now,
  };
}
