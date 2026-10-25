/**
 * Seed helpers for the cert tier: cert_domains, runs, and certificates
 * (row + R2 artifacts sealed with the test KEY_SECRET via key_cipher).
 */

import type { IssueTrigger } from "../../../src/cert/issue/types";
import type { AcmeEnvironment } from "../../../src/cert/issue/types";
import {
  createIssueRun,
  type CertificateRow,
  type CertDomainRow,
  type CertDomainStatus,
} from "../../../src/cert/store/d1";
import { certificatePrefix, certificatePrivateKeyKey, certPathName } from "../../../src/cert/store/r2";
import { seal } from "../../../src/services/key_cipher";
import { env } from "cloudflare:workers";

export interface SeedDomainOptions {
  name?: string;
  status?: CertDomainStatus;
  includeWildcard?: boolean;
  zoneId?: string;
  acmeProfile?: string;
  renewBeforeDays?: number | null;
}

export async function seedCertDomain(
  db: D1Database,
  options: SeedDomainOptions = {},
): Promise<CertDomainRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const domain: CertDomainRow = {
    id,
    name: options.name ?? `test-${id.slice(0, 8)}.example.com`,
    zone_id: options.zoneId ?? "zone-test",
    include_wildcard: options.includeWildcard === false ? 0 : 1,
    acme_profile: options.acmeProfile ?? "tlsserver",
    renew_before_days: options.renewBeforeDays === undefined ? 30 : options.renewBeforeDays,
    status: options.status ?? "active",
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  await db.prepare(
    `INSERT INTO cert_domains (
       id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
       status, last_error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    domain.id,
    domain.name,
    domain.zone_id,
    domain.include_wildcard,
    domain.acme_profile,
    domain.renew_before_days,
    domain.status,
    domain.last_error,
    domain.created_at,
    domain.updated_at,
  ).run();
  return domain;
}

export async function seedIssueRun(
  db: D1Database,
  domainId: string,
  trigger: IssueTrigger = "manual",
  environment: AcmeEnvironment = "staging",
): Promise<{ runId: string; workflowId: string }> {
  const runId = crypto.randomUUID();
  const workflowId = `${trigger}-${runId}`;
  await createIssueRun(db, {
    id: runId,
    domain_id: domainId,
    environment,
    workflow_id: workflowId,
    trigger,
  });
  return { runId, workflowId };
}

export interface SeedCertificateOptions {
  domainName?: string;
  id?: string;
  environment?: AcmeEnvironment;
  current?: boolean;
  purgedAt?: string | null;
  notAfter?: string;
  notBefore?: string;
  serial?: string;
  sans?: string[];
  profile?: string;
  storeArtifacts?: boolean;
  privateKeyPem?: string;
  /** Overrides the default placeholder leaf PEM. */
  certPem?: string;
  createdAt?: string;
}

/**
 * WHAT: insert one certificate row and (unless skipped) its R2 artifacts,
 * sealing the private key with the test env's KEY_SECRET.
 */
export async function seedCertificate(
  db: D1Database,
  bucket: R2Bucket,
  domainId: string,
  options: SeedCertificateOptions = {},
): Promise<CertificateRow> {
  const certificateId = options.id ?? crypto.randomUUID();
  const domainName = options.domainName ?? `cert-${certificateId.slice(0, 8)}.example.com`;
  const environment = options.environment ?? "staging";
  const r2Prefix = certificatePrefix(environment, certPathName(domainName), certificateId);
  const now = new Date().toISOString();
  const row: CertificateRow = {
    id: certificateId,
    domain_id: domainId,
    environment,
    serial: options.serial ?? "0011aa22bb33cc44dd55ee66ff778899",
    fingerprint_sha256: crypto.randomUUID().replaceAll("-", ""),
    sans_json: JSON.stringify(options.sans ?? ["example.com", "*.example.com"]),
    not_before: options.notBefore ?? now,
    not_after: options.notAfter ?? new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
    profile: options.profile ?? "tlsserver",
    issued_at: now,
    r2_prefix: r2Prefix,
    is_current: options.current === false ? 0 : 1,
    purged_at: options.purgedAt ?? null,
    created_at: options.createdAt ?? now,
  };
  await db.prepare(
    `INSERT INTO certificates (
       id, domain_id, environment, serial, fingerprint_sha256, sans_json, not_before, not_after,
       profile, issued_at, r2_prefix, is_current, purged_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    row.id,
    row.domain_id,
    row.environment,
    row.serial,
    row.fingerprint_sha256,
    row.sans_json,
    row.not_before,
    row.not_after,
    row.profile,
    row.issued_at,
    row.r2_prefix,
    row.is_current,
    row.purged_at,
    row.created_at,
  ).run();

  if (options.storeArtifacts !== false) {
    await Promise.all([
      bucket.put(`${r2Prefix}/cert.pem`, options.certPem ?? `LEAF PEM for ${certificateId}\n`),
      bucket.put(`${r2Prefix}/chain.pem`, `CHAIN PEM for ${certificateId}\n`),
      bucket.put(`${r2Prefix}/fullchain.pem`, `FULLCHAIN PEM for ${certificateId}\n`),
    ]);
    const privateKey = options.privateKeyPem ?? `PRIVATE KEY for ${certificateId}\n`;
    await bucket.put(
      certificatePrivateKeyKey(r2Prefix),
      await seal(env, privateKey),
    );
  }

  return row;
}
