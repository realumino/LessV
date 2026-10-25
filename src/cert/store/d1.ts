/**
 * D1 access for the certificate subsystem: the only file that speaks SQL
 * to the P1b tables (`cert_domains`, `certificates`, `acme_accounts`,
 * `issue_runs`, `challenge_records`, `node_cert_domains`).
 *
 * WHY a separate module and not `src/db.ts`: the cert tables use ISO-8601
 * TEXT timestamps (ported from certworker) while the node/user tables use
 * Unix seconds; mixing them in one file would blur which convention each
 * query follows. The UI parses ISO strings, the node report columns parse
 * seconds — the conversion is confined to the service layer's boundary.
 *
 * WHY environment is a parameter on every current-certificate read: the
 * staging/production isolation (P1B-PLAN.md §3.3) is enforced here — one
 * partial unique index per `(domain_id, environment)`, and the delivery
 * path queries `environment='production' AND is_current=1` only.
 */

import type { AcmeEnvironment, IssueTrigger } from "../issue/types";

export type CertDomainStatus = "active" | "paused" | "deleted";
export type IssueRunStatus = "queued" | "running" | "succeeded" | "failed";

export interface CertDomainRow {
  id: string;
  name: string;
  zone_id: string;
  include_wildcard: number;
  acme_profile: string;
  renew_before_days: number | null;
  status: CertDomainStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CertificateRow {
  id: string;
  domain_id: string;
  environment: AcmeEnvironment;
  serial: string;
  fingerprint_sha256: string;
  sans_json: string;
  not_before: string;
  not_after: string;
  profile: string;
  issued_at: string;
  r2_prefix: string;
  is_current: number;
  purged_at: string | null;
  created_at: string;
}

export interface AcmeAccountRow {
  environment: AcmeEnvironment;
  directory_url: string;
  account_url: string;
  /** `v1:` sealed PKCS#8 PEM (`key_cipher`), never plaintext. */
  private_key: string;
  /** Public JWK JSON, stored to rebuild the CryptoKeyPair on load. */
  public_jwk: string;
  thumbprint: string;
  updated_at: string;
}

export interface IssueRunRow {
  id: string;
  domain_id: string;
  environment: AcmeEnvironment;
  trigger: IssueTrigger;
  status: IssueRunStatus;
  phase: string | null;
  error: string | null;
  workflow_id: string;
  started_at: string | null;
  finished_at: string | null;
  steps_json: string | null;
  created_at: string;
}

export interface ChallengeRecordRow {
  id: string;
  run_id: string;
  zone_id: string;
  cf_record_id: string;
  name: string;
  value: string;
  created_at: string;
  deleted_at: string | null;
}

export interface NodeCertDomainRow {
  node_id: string;
  domain_id: string;
  assigned_at: number;
}

export class ActiveIssueRunError extends Error {
  constructor(domainId: string) {
    super(`An issue run is already active for domain ${domainId}`);
    this.name = "ActiveIssueRunError";
  }
}

export class DomainNameConflictError extends Error {
  constructor(name: string) {
    super(`A cert domain row already exists for ${name}`);
    this.name = "DomainNameConflictError";
  }
}

// ---------------------------------------------------------------- domains

export async function getCertDomain(
  db: D1Database,
  id: string,
): Promise<CertDomainRow | null> {
  return db.prepare("SELECT * FROM cert_domains WHERE id = ?").bind(id).first<CertDomainRow>();
}

export async function findCertDomainByName(
  db: D1Database,
  name: string,
): Promise<CertDomainRow | null> {
  return db.prepare("SELECT * FROM cert_domains WHERE name = ?").bind(name).first<CertDomainRow>();
}

export async function createCertDomain(
  db: D1Database,
  domain: Pick<
    CertDomainRow,
    "id" | "name" | "zone_id" | "include_wildcard" | "acme_profile" | "renew_before_days"
  >,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO cert_domains (
         id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
         status, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    ).bind(
      domain.id,
      domain.name,
      domain.zone_id,
      domain.include_wildcard,
      domain.acme_profile,
      domain.renew_before_days,
      new Date().toISOString(),
      new Date().toISOString(),
    ).run();
  } catch (error) {
    if (
      error instanceof Error &&
      /UNIQUE constraint failed:\s*cert_domains\.name/.test(error.message)
    ) {
      throw new DomainNameConflictError(domain.name);
    }
    throw error;
  }
}

export async function updateCertDomainSettings(
  db: D1Database,
  id: string,
  settings: Pick<
    CertDomainRow,
    "include_wildcard" | "acme_profile" | "renew_before_days" | "status"
  >,
): Promise<void> {
  await db.prepare(
    `UPDATE cert_domains
        SET include_wildcard = ?, acme_profile = ?, renew_before_days = ?, status = ?, updated_at = ?
      WHERE id = ? AND status != 'deleted'`,
  ).bind(
    settings.include_wildcard,
    settings.acme_profile,
    settings.renew_before_days,
    settings.status,
    new Date().toISOString(),
    id,
  ).run();
}

export async function setCertDomainError(
  db: D1Database,
  id: string,
  lastError: string | null,
): Promise<void> {
  await db.prepare(
    "UPDATE cert_domains SET last_error = ?, updated_at = ? WHERE id = ?",
  ).bind(lastError, new Date().toISOString(), id).run();
}

/**
 * WHAT: soft-delete one domain row.
 *
 * WHY soft and not hard: assigned nodes and old runs keep their references
 * readable for the UI, and no ACME revocation happens (P1B-PLAN.md C10) —
 * a hard delete would make the history unauditable.
 */
export async function softDeleteCertDomain(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(
    "UPDATE cert_domains SET status = 'deleted', updated_at = ? WHERE id = ? AND status != 'deleted'",
  ).bind(new Date().toISOString(), id).run();
  return result.meta.changes === 1;
}

/**
 * WHAT: list non-deleted domains joined with their current production and
 * staging certificates, name-ordered.
 *
 * WHY one join instead of N queries: the list view needs both columns
 * (production/test) for every row; one scale is small, so a LEFT JOIN per
 * environment is cheaper and simpler than a second round-trip.
 */
export async function listCertDomains(
  db: D1Database,
  options: { status?: CertDomainStatus; limit: number; offset: number },
): Promise<CertDomainWithCertificatesRow[]> {
  const statusFilter =
    options.status === undefined ? " WHERE d.status != 'deleted'" : " WHERE d.status = ?";
  const { results } = await db.prepare(
    `SELECT d.*,
            p.id AS production_id, p.serial AS production_serial,
            p.fingerprint_sha256 AS production_fingerprint_sha256,
            p.sans_json AS production_sans_json,
            p.not_before AS production_not_before, p.not_after AS production_not_after,
            p.profile AS production_profile, p.purged_at AS production_purged_at,
            p.created_at AS production_created_at,
            s.id AS staging_id, s.serial AS staging_serial,
            s.fingerprint_sha256 AS staging_fingerprint_sha256,
            s.sans_json AS staging_sans_json,
            s.not_before AS staging_not_before, s.not_after AS staging_not_after,
            s.profile AS staging_profile, s.purged_at AS staging_purged_at,
            s.created_at AS staging_created_at
       FROM cert_domains d
       LEFT JOIN certificates p ON p.domain_id = d.id
         AND p.environment = 'production' AND p.is_current = 1
       LEFT JOIN certificates s ON s.domain_id = d.id
         AND s.environment = 'staging' AND s.is_current = 1${statusFilter}
      ORDER BY d.name LIMIT ? OFFSET ?`,
  )
    .bind(
      ...(options.status === undefined ? [] : [options.status]),
      options.limit,
      options.offset,
    )
    .all<CertDomainWithCertificatesRow>();
  return results;
}

export interface CertificateSummary {
  id: string;
  serial: string;
  fingerprint_sha256: string;
  sans_json: string;
  not_before: string;
  not_after: string;
  profile: string;
  purged_at: string | null;
  created_at: string;
}

export interface CertDomainWithCertificatesRow extends CertDomainRow {
  production_id: string | null;
  production_serial: string | null;
  production_fingerprint_sha256: string | null;
  production_sans_json: string | null;
  production_not_before: string | null;
  production_not_after: string | null;
  production_profile: string | null;
  production_purged_at: string | null;
  production_created_at: string | null;
  staging_id: string | null;
  staging_serial: string | null;
  staging_fingerprint_sha256: string | null;
  staging_sans_json: string | null;
  staging_not_before: string | null;
  staging_not_after: string | null;
  staging_profile: string | null;
  staging_purged_at: string | null;
  staging_created_at: string | null;
}

// ------------------------------------------------------------ certificates

export async function getCurrentCertificate(
  db: D1Database,
  domainId: string,
  environment: AcmeEnvironment,
): Promise<CertificateRow | null> {
  return db.prepare(
    `SELECT * FROM certificates
      WHERE domain_id = ? AND environment = ? AND is_current = 1`,
  ).bind(domainId, environment).first<CertificateRow>();
}

export async function getCertificate(
  db: D1Database,
  id: string,
): Promise<CertificateRow | null> {
  return db.prepare("SELECT * FROM certificates WHERE id = ?").bind(id).first<CertificateRow>();
}

/**
 * WHAT: every current certificate, optionally filtered to one environment.
 *
 * WHY: the delivery ETag hashes all assigned production currents; lint and
 * the cron need the same shape.
 */
export async function listCurrentCertificates(
  db: D1Database,
  environment?: AcmeEnvironment,
): Promise<CertificateRow[]> {
  const filter = environment === undefined ? "" : " AND environment = ?";
  const { results } = await db.prepare(
    `SELECT * FROM certificates WHERE is_current = 1${filter} ORDER BY created_at, id`,
  ).bind(...(environment === undefined ? [] : [environment])).all<CertificateRow>();
  return results;
}

/**
 * WHAT: make one certificate the current one for its `(domain, environment)`.
 *
 * WHY a batch and not two statements: readers must never observe "two
 * currents" or "no current" — the demotion and promotion commit together.
 * R2 objects are written before this is called, so a crash here leaves
 * current pointing at objects that exist.
 */
export async function activateCertificate(db: D1Database, certificate: CertificateRow): Promise<void> {
  const existing = await getCertificate(db, certificate.id);
  if (existing) {
    if (
      existing.domain_id !== certificate.domain_id ||
      existing.environment !== certificate.environment ||
      existing.fingerprint_sha256 !== certificate.fingerprint_sha256
    ) {
      throw new Error(`Certificate id ${certificate.id} is already in use`);
    }
    // A retry after the D1 commit must not re-activate an older certificate.
    return;
  }

  await db.batch([
    db.prepare(
      `UPDATE certificates SET is_current = 0
        WHERE domain_id = ? AND environment = ? AND is_current = 1`,
    ).bind(certificate.domain_id, certificate.environment),
    db.prepare(
      `INSERT INTO certificates (
         id, domain_id, environment, serial, fingerprint_sha256, sans_json,
         not_before, not_after, profile, issued_at, r2_prefix, is_current, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).bind(
      certificate.id,
      certificate.domain_id,
      certificate.environment,
      certificate.serial,
      certificate.fingerprint_sha256,
      certificate.sans_json,
      certificate.not_before,
      certificate.not_after,
      certificate.profile,
      certificate.issued_at,
      certificate.r2_prefix,
      certificate.created_at,
    ),
  ]);
}

/**
 * WHAT: mark one non-current certificate's R2 artifacts as deleted.
 *
 * WHY the WHERE guard: the current certificate is never purgeable —
 * marking it would let the sweeper "complete" a purge that broke delivery.
 */
export async function markCertificatePurged(db: D1Database, id: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE certificates
        SET purged_at = COALESCE(purged_at, ?)
      WHERE id = ? AND is_current = 0`,
  ).bind(new Date().toISOString(), id).run();
  if (result.meta.changes !== 1) {
    throw new Error(`Certificate ${id} was not eligible to mark purged`);
  }
}

/** WHAT: all production non-current certificates whose R2 may still exist. */
export async function listUnpurgedProductionCertificates(db: D1Database): Promise<CertificateRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM certificates
      WHERE purged_at IS NULL AND is_current = 0 AND environment = 'production'
      ORDER BY created_at, id`,
  ).all<CertificateRow>();
  return results;
}

/**
 * WHAT: staging current certificates older than `cutoffIso`.
 *
 * WHY staging only: production currents live until superseded; staging
 * certificates are throwaway test artifacts kept for exactly 7 days.
 */
export async function listExpiredStagingCertificates(
  db: D1Database,
  cutoffIso: string,
): Promise<CertificateRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM certificates
      WHERE environment = 'staging' AND is_current = 1
        AND (purged_at IS NULL OR purged_at = '') AND created_at < ?
      ORDER BY created_at, id`,
  ).bind(cutoffIso).all<CertificateRow>();
  return results;
}

/** WHAT: hard-delete one staging certificate row (artifacts already gone). */
export async function deleteStagingCertificate(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    "DELETE FROM certificates WHERE id = ? AND environment = 'staging' AND is_current = 0",
  ).bind(id).run();
}

export async function listCertificatesByDomain(
  db: D1Database,
  domainId: string,
  limit: number,
): Promise<CertificateWithDomainRow[]> {
  const { results } = await db.prepare(
    `SELECT c.*, d.name AS domain_name
       FROM certificates c JOIN cert_domains d ON d.id = c.domain_id
      WHERE c.domain_id = ?
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
  ).bind(domainId, limit).all<CertificateWithDomainRow>();
  return results;
}

export interface CertificateWithDomainRow extends CertificateRow {
  domain_name: string;
}

// -------------------------------------------------------------- issue runs

export async function createIssueRun(
  db: D1Database,
  run: Pick<IssueRunRow, "id" | "domain_id" | "environment" | "workflow_id" | "trigger">,
): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO issue_runs (id, domain_id, environment, workflow_id, trigger, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
    ).bind(
      run.id,
      run.domain_id,
      run.environment,
      run.workflow_id,
      run.trigger,
      new Date().toISOString(),
    ).run();
  } catch (error) {
    if (error instanceof Error && /idx_run_active|issue_runs\.domain_id/.test(error.message)) {
      throw new ActiveIssueRunError(run.domain_id);
    }
    throw error;
  }
}

export async function getIssueRun(db: D1Database, id: string): Promise<IssueRunRow | null> {
  return db.prepare("SELECT * FROM issue_runs WHERE id = ?").bind(id).first<IssueRunRow>();
}

/** Idempotency check for date-scoped cron workflow IDs (`renew-<domainId>-<date>`). */
export async function findIssueRunByWorkflowId(
  db: D1Database,
  workflowId: string,
): Promise<IssueRunRow | null> {
  return db.prepare(
    "SELECT * FROM issue_runs WHERE workflow_id = ? ORDER BY rowid DESC LIMIT 1",
  ).bind(workflowId).first<IssueRunRow>();
}

export async function recordRunPhase(db: D1Database, runId: string, phase: string): Promise<void> {
  const row = await db.prepare("SELECT steps_json FROM issue_runs WHERE id = ?")
    .bind(runId)
    .first<{ steps_json: string | null }>();
  if (!row) throw new Error(`Issue run ${runId} does not exist`);

  const steps = parseSteps(row.steps_json);
  steps.push({ phase, at: new Date().toISOString() });
  const result = await db.prepare(
    `UPDATE issue_runs
        SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
            phase = ?,
            started_at = COALESCE(started_at, ?),
            steps_json = ?
      WHERE id = ? AND status IN ('queued', 'running')`,
  ).bind(phase, new Date().toISOString(), JSON.stringify(steps), runId).run();

  if (result.meta.changes !== 1) throw new Error(`Issue run ${runId} is no longer active`);
}

/**
 * WHAT: finalize one run and mirror the outcome into `cert_domains.last_error`.
 *
 * WHY the domain update is unconditional: `last_error` is production-only in
 * meaning, so the caller passes `shouldRecordError = environment ==
 * 'production'` and this function clears the domain error on a production
 * success (a recovery is worth recording as loudly as a failure).
 */
export async function finishIssueRun(
  db: D1Database,
  runId: string,
  domainId: string,
  outcome: { status: "succeeded" } | { status: "failed"; error: string },
  options: { recordDomainError?: boolean } = {},
): Promise<void> {
  const existing = await getIssueRun(db, runId);
  if (!existing) throw new Error(`Issue run ${runId} does not exist`);
  if (existing.finished_at !== null) {
    if (existing.status === outcome.status) return;
    throw new Error(`Issue run ${runId} already finished as ${existing.status}`);
  }

  const finishedAt = new Date().toISOString();
  const phase = outcome.status === "succeeded" ? "complete" : "failed";
  const steps = parseSteps(existing.steps_json);
  steps.push({ phase, at: finishedAt });
  const recordError = options.recordDomainError ?? true;
  const domainError = recordError && outcome.status === "failed" ? outcome.error : null;
  const statements = [
    db.prepare(
      `UPDATE issue_runs
          SET status = ?, phase = ?, error = ?, finished_at = ?, steps_json = ?
        WHERE id = ? AND finished_at IS NULL`,
    ).bind(outcome.status, phase, outcome.status === "failed" ? outcome.error : null, finishedAt, JSON.stringify(steps), runId),
  ];
  if (recordError) {
    statements.push(
      db.prepare("UPDATE cert_domains SET last_error = ?, updated_at = ? WHERE id = ?")
        .bind(domainError, finishedAt, domainId),
    );
  }
  const results = await db.batch(statements);

  if (results[0].meta.changes !== 1) {
    throw new Error(`Issue run ${runId} could not be finalized`);
  }
}

export async function findActiveIssueRun(
  db: D1Database,
  domainId: string,
): Promise<IssueRunRow | null> {
  return db.prepare(
    `SELECT * FROM issue_runs
      WHERE domain_id = ? AND status IN ('queued', 'running')
      ORDER BY rowid DESC LIMIT 1`,
  ).bind(domainId).first<IssueRunRow>();
}

export async function getIssueRunWithDomain(
  db: D1Database,
  id: string,
): Promise<IssueRunWithDomainRow | null> {
  return db.prepare(
    `SELECT r.*, d.name AS domain_name FROM issue_runs r
       JOIN cert_domains d ON d.id = r.domain_id WHERE r.id = ?`,
  ).bind(id).first<IssueRunWithDomainRow>();
}

export async function listIssueRuns(
  db: D1Database,
  options: { domainId?: string; status?: IssueRunStatus; limit: number; offset: number },
): Promise<IssueRunWithDomainRow[]> {
  const filters = [
    ...(options.domainId === undefined ? [] : ["r.domain_id = ?"]),
    ...(options.status === undefined ? [] : ["r.status = ?"]),
  ];
  const where = filters.length === 0 ? "" : ` WHERE ${filters.join(" AND ")}`;
  const { results } = await db.prepare(
    `SELECT r.*, d.name AS domain_name
       FROM issue_runs r JOIN cert_domains d ON d.id = r.domain_id${where}
      ORDER BY r.rowid DESC LIMIT ? OFFSET ?`,
  )
    .bind(
      ...[options.domainId, options.status].filter(
        (value): value is string => value !== undefined,
      ),
      options.limit,
      options.offset,
    )
    .all<IssueRunWithDomainRow>();
  return results;
}

export interface IssueRunWithDomainRow extends IssueRunRow {
  domain_name: string;
}

/** WHAT: finished runs older than the cutoff, for the 30-day retention sweep. */
export async function listOldFinishedRuns(
  db: D1Database,
  cutoffIso: string,
  limit: number,
): Promise<IssueRunRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM issue_runs
      WHERE finished_at IS NOT NULL AND finished_at < ?
      ORDER BY finished_at, id LIMIT ?`,
  ).bind(cutoffIso, limit).all<IssueRunRow>();
  return results;
}

export async function deleteIssueRun(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM issue_runs WHERE id = ?").bind(id).run();
}

// ------------------------------------------------------------ acme accounts

export async function getAcmeAccount(
  db: D1Database,
  environment: AcmeEnvironment,
): Promise<AcmeAccountRow | null> {
  return db.prepare("SELECT * FROM acme_accounts WHERE environment = ?")
    .bind(environment)
    .first<AcmeAccountRow>();
}

export async function saveAcmeAccount(
  db: D1Database,
  account: Omit<AcmeAccountRow, "updated_at">,
): Promise<void> {
  await db.prepare(
    `INSERT INTO acme_accounts (environment, directory_url, account_url, private_key, public_jwk, thumbprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(environment) DO UPDATE SET
       directory_url = excluded.directory_url,
       account_url = excluded.account_url,
       private_key = excluded.private_key,
       public_jwk = excluded.public_jwk,
       thumbprint = excluded.thumbprint`,
  ).bind(
    account.environment,
    account.directory_url,
    account.account_url,
    account.private_key,
    account.public_jwk,
    account.thumbprint,
    new Date().toISOString(),
  ).run();
}

// -------------------------------------------------------- challenge records

export async function insertChallengeRecord(
  db: D1Database,
  record: Pick<
    ChallengeRecordRow,
    "id" | "run_id" | "zone_id" | "cf_record_id" | "name" | "value"
  >,
): Promise<void> {
  await db.prepare(
    `INSERT INTO challenge_records (id, run_id, zone_id, cf_record_id, name, value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    record.id,
    record.run_id,
    record.zone_id,
    record.cf_record_id,
    record.name,
    record.value,
    new Date().toISOString(),
  ).run();
}

export async function listPendingChallengeRecords(
  db: D1Database,
  runId: string,
): Promise<ChallengeRecordRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM challenge_records
      WHERE run_id = ? AND deleted_at IS NULL
      ORDER BY created_at, id`,
  ).bind(runId).all<ChallengeRecordRow>();
  return results;
}

export async function findPendingChallengeRecord(
  db: D1Database,
  runId: string,
  name: string,
  value: string,
): Promise<ChallengeRecordRow | null> {
  return db.prepare(
    `SELECT * FROM challenge_records
      WHERE run_id = ? AND name = ? AND value = ? AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
  ).bind(runId, name, value).first<ChallengeRecordRow>();
}

export async function markChallengeRecordDeleted(db: D1Database, id: string): Promise<void> {
  await db.prepare(
    "UPDATE challenge_records SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?",
  ).bind(new Date().toISOString(), id).run();
}

/**
 * WHAT: TXT records untouched by their run for longer than the cutoff.
 *
 * WHY the name filter: a live run's DNS wait is minutes; anything older
 * than the cutoff (24 h) belongs to a dead run and must not linger in the
 * zone.
 */
export async function listStaleChallengeRecords(
  db: D1Database,
  cutoffIso: string,
): Promise<ChallengeRecordRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM challenge_records
      WHERE deleted_at IS NULL AND created_at < ?
      ORDER BY created_at, id`,
  ).bind(cutoffIso).all<ChallengeRecordRow>();
  return results;
}

// ------------------------------------------------------- node cert domains

export async function listNodeCertDomains(
  db: D1Database,
  nodeId: string,
): Promise<NodeCertDomainRow[]> {
  const { results } = await db.prepare(
    "SELECT * FROM node_cert_domains WHERE node_id = ? ORDER BY assigned_at, domain_id",
  ).bind(nodeId).all<NodeCertDomainRow>();
  return results;
}

/**
 * WHAT: replace one node's certificate-domain assignment set.
 *
 * WHY replace and not diff: the UI sends the complete checkbox state, so
 * the store can make "what is assigned" a single statement away from
 * truth; the assignment history lives in the UI, not in D1.
 */
export async function replaceNodeCertDomains(
  db: D1Database,
  nodeId: string,
  domainIds: string[],
  assignedAt: number,
): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM node_cert_domains WHERE node_id = ?").bind(nodeId),
    ...domainIds.map((domainId) =>
      db.prepare(
        `INSERT INTO node_cert_domains (node_id, domain_id, assigned_at) VALUES (?, ?, ?)
         ON CONFLICT(node_id, domain_id) DO UPDATE SET assigned_at = excluded.assigned_at`,
      ).bind(nodeId, domainId, assignedAt),
    ),
  ];
  await db.batch(statements);
}

/**
 * WHAT: assigned active domains for one node joined with their current
 * production certificate, domain-name-ordered.
 *
 * WHY the join skips nothing: delivery omits a domain whose current
 * production certificate is missing (§4.2), so the caller needs the row
 * even when the certificate columns are NULL.
 */
export async function listNodeAssignedDomains(
  db: D1Database,
  nodeId: string,
): Promise<NodeAssignedDomainRow[]> {
  const { results } = await db.prepare(
    `SELECT d.id AS domain_id, d.name AS domain_name, d.status AS domain_status,
            c.id AS certificate_id, c.serial AS certificate_serial,
            c.fingerprint_sha256 AS certificate_fingerprint_sha256,
            c.sans_json AS certificate_sans_json,
            c.not_before AS certificate_not_before, c.not_after AS certificate_not_after,
            c.profile AS certificate_profile, c.r2_prefix AS certificate_r2_prefix,
            c.created_at AS certificate_created_at
       FROM node_cert_domains n
       JOIN cert_domains d ON d.id = n.domain_id
       LEFT JOIN certificates c ON c.domain_id = d.id
         AND c.environment = 'production' AND c.is_current = 1
      WHERE n.node_id = ?
      ORDER BY d.name`,
  ).bind(nodeId).all<NodeAssignedDomainRow>();
  return results;
}

export interface NodeAssignedDomainRow {
  domain_id: string;
  domain_name: string;
  domain_status: CertDomainStatus;
  certificate_id: string | null;
  certificate_serial: string | null;
  certificate_fingerprint_sha256: string | null;
  certificate_sans_json: string | null;
  certificate_not_before: string | null;
  certificate_not_after: string | null;
  certificate_profile: string | null;
  certificate_r2_prefix: string | null;
  certificate_created_at: string | null;
}

export async function deleteNodeCertDomainAssignments(
  db: D1Database,
  domainId: string,
): Promise<void> {
  await db.prepare("DELETE FROM node_cert_domains WHERE domain_id = ?").bind(domainId).run();
}

// ------------------------------------------------------------------ helpers

function parseSteps(value: string | null): Array<Record<string, string>> {
  if (value === null || value.length === 0) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(isObject)) {
    throw new TypeError("Issue run steps_json must be a JSON array of objects");
  }
  return parsed;
}

function isObject(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
