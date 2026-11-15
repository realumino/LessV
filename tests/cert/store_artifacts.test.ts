/**
 * Certificate artifacts in D1: the sealed leaf key written before the order,
 * the three PEMs written after it, purge by deletion, and the orphan query.
 *
 * WHY the order matters: issuance writes the key first because a retried
 * workflow has to find the key it already generated, so the table has to
 * support a row that exists before any certificate row does.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  deleteCertificateArtifacts,
  getCertificateArtifacts,
  listOrphanedArtifacts,
  putCertificateArtifacts,
  putCertificatePrivateKey,
} from "../../src/cert/store/d1";

/** WHAT: epoch seconds, the column's unit. */
function now(): number {
  return Math.floor(Date.now() / 1000);
}

describe("certificate artifacts store", () => {
  it("stores the sealed key before the certificate row exists", async () => {
    const id = crypto.randomUUID();
    await putCertificatePrivateKey(env.DB, id, "v1:sealed", now());

    await expect(getCertificateArtifacts(env.DB, id)).resolves.toMatchObject({
      certificate_id: id,
      private_key: "v1:sealed",
      cert_pem: null,
      chain_pem: null,
      fullchain_pem: null,
    });
  });

  it("replaces the key on a retry", async () => {
    const id = crypto.randomUUID();
    await putCertificatePrivateKey(env.DB, id, "v1:first", now());
    await putCertificatePrivateKey(env.DB, id, "v1:second", now() + 5);

    const row = await getCertificateArtifacts(env.DB, id);
    expect(row?.private_key).toBe("v1:second");
    expect(row?.updated_at).toBe(now() + 5);
  });

  it("fills the PEMs only for an existing key row", async () => {
    const id = crypto.randomUUID();
    await expect(
      putCertificateArtifacts(
        env.DB,
        id,
        { certPem: "leaf", chainPem: "chain", fullchainPem: "fullchain" },
        now(),
      ),
    ).rejects.toThrow(/do not exist/);

    await putCertificatePrivateKey(env.DB, id, "v1:sealed", now());
    await putCertificateArtifacts(
      env.DB,
      id,
      { certPem: "leaf", chainPem: "chain", fullchainPem: "fullchain" },
      now(),
    );
    await expect(getCertificateArtifacts(env.DB, id)).resolves.toMatchObject({
      cert_pem: "leaf",
      chain_pem: "chain",
      fullchain_pem: "fullchain",
    });
  });

  it("purges by deleting the row", async () => {
    const id = crypto.randomUUID();
    await putCertificatePrivateKey(env.DB, id, "v1:sealed", now());
    await deleteCertificateArtifacts(env.DB, id);
    await expect(getCertificateArtifacts(env.DB, id)).resolves.toBeNull();
  });

  it("lists only unclaimed rows older than the cutoff", async () => {
    const orphan = crypto.randomUUID();
    const recent = crypto.randomUUID();
    const claimed = crypto.randomUUID();
    await putCertificatePrivateKey(env.DB, orphan, "v1:a", 1000);
    await putCertificatePrivateKey(env.DB, recent, "v1:b", 9000);
    await putCertificatePrivateKey(env.DB, claimed, "v1:c", 1000);
    const domainId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO cert_domains (
         id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
         status, last_error, created_at, updated_at
       ) VALUES (?, ?, 'zone', 0, 'tlsserver', NULL, 'active', NULL, ?, ?)`,
    ).bind(domainId, `orphan-${domainId.slice(0, 8)}.example.com`, "2026-01-01", "2026-01-01").run();
    await env.DB.prepare(
      `INSERT INTO certificates (
         id, domain_id, environment, serial, fingerprint_sha256, sans_json,
         not_before, not_after, profile, issued_at, is_current, created_at
       ) VALUES (?, ?, 'staging', 's', ?, '[]', '2026-01-01', '2026-02-01', 'tlsserver', ?, 0, ?)`,
    ).bind(claimed, domainId, "f".repeat(64), "2026-01-01", "2026-01-01").run();

    const listed = await listOrphanedArtifacts(env.DB, 5000);
    expect(listed).toContain(orphan);
    expect(listed).not.toContain(recent);
    expect(listed).not.toContain(claimed);
  });
});
