/**
 * Certificate business logic: domain CRUD, issuance triggers, run/cert
 * views, artifact downloads, node assignment, and the delivery manifest.
 *
 * WHY no SQL and no HTTP here: routers translate JSON and status codes;
 * `store/d1` speaks storage; this module owns the rules —
 * environment isolation for delivery, ETag composition, wildcard naming,
 * and the error taxonomy the routers map to status codes.
 *
 * WHY it never imports the Workflow: issuance is started through
 * `issue/trigger.ts` with the `env.ISSUANCE` binding passed in by the
 * router, so tests can substitute a fake creator.
 */

import { CloudflareApiError, findZoneId, getZone, listZones } from "./dns/cloudflare";
import { activeDnsToken } from "./credentials";
import {
  getCertificate as getCertificateById,
  ActiveIssueRunError,
  createCertDomain,
  deleteNodeCertDomainAssignments,
  findActiveIssueRun,
  findCertDomainByName,
  getCertificateArtifacts,
  getCertDomain,
  getCertDomainWithCertificates,
  listCertDomains,
  listCertificatesByDomain,
  listIssueRunsByDomain,
  listNodeAssignedDomains,
  replaceNodeCertDomains,
  softDeleteCertDomain,
  updateCertDomainSettings,
  type CertificateRow,
  type CertDomainRow,
  type CertDomainStatus,
  type CertDomainWithCertificatesRow,
} from "./store/d1";
import { startIssueRun, IssueDomainNotFoundError, IssueDomainNotActiveError } from "./issue/trigger";
import type { AcmeEnvironment, IssueTrigger } from "./issue/types";
import { unseal } from "../services/key_cipher";
import {
  ACME_PROFILE,
  CertDomainIssueConfirm,
  certPathName,
  normalizedDomainName,
  type CertificateOut,
  type CertificateSummaryOut,
  type CertDomainOut,
  type CertDomainUpdate,
  type CertRunOut,
  type CertRunStep,
  type NodeCertDomainsOut,
  type NodeCertDomainOut,
  type NodeCertSummary,
  type NodeCertsOut,
} from "./models";
import { ApiError } from "../models";
import type { CertDomainCreate } from "./models";
import * as nodeDb from "../db";
import type { NodeRow } from "../db";
export { certPathName };

// ------------------------------------------------------------- error types

export class WildcardOverlapError extends Error {
  constructor(readonly existing: CertDomainRow, readonly requested: string) {
    super(
      `${existing.name} already issues the wildcard SAN for ${requested.replace(/^\*\./, "")}`,
    );
    this.name = "WildcardOverlapError";
  }
}

export class CertDomainNotFoundError extends Error {
  constructor(id: string) {
    super(`Cert domain ${id} does not exist`);
    this.name = "CertDomainNotFoundError";
  }
}

export class InvalidAssignmentError extends Error {
  constructor(domainId: string) {
    super(`Unknown or deleted cert domain: ${domainId}`);
    this.name = "InvalidAssignmentError";
  }
}

/**
 * WHAT: a certificate row exists but the bytes it points at do not.
 *
 * WHY the certificate id and the field: that pair is what an operator has
 * to look at, and it never leaks a path or key material. It is a server
 * fault (500), not a missing resource: the certificate row is real.
 */
export class CertificateArtifactsMissingError extends Error {
  constructor(certificateId: string, field: string) {
    super(`Certificate ${certificateId} has no stored ${field}`);
    this.name = "CertificateArtifactsMissingError";
  }
}

// ------------------------------------------------------------------- zones

/** WHAT: the zones the DNS token can read, for the domain form's picker. */
export async function zoneList(env: Env): Promise<Array<{ id: string; name: string; status: string }>> {
  const zones = await listZones({ apiToken: await activeDnsToken(env) });
  return zones.map(({ id, name, status }) => ({
    id,
    name,
    status: status ?? "unknown",
  }));
}

async function resolveZone(
  env: Env,
  input: CertDomainCreate,
  normalized: string,
): Promise<string> {
  // WHY resolved per call: the credential is runtime state now — an active
  // row can change between two calls, and each call must use what is in
  // force at that moment.
  const apiToken = await activeDnsToken(env);
  if (input.zone_id !== undefined && input.zone_id !== "") {
    const zone = await getZone({ apiToken, zoneId: input.zone_id });
    if (zone.status !== undefined && zone.status !== "active") {
      throw new CloudflareApiError(409, [], `Cloudflare zone ${zone.name} is ${zone.status}, not active`);
    }
    return zone.id;
  }
  return findZoneId({ apiToken, domain: normalized });
}

// ------------------------------------------------------------- domain CRUD

function parseSans(json: string | null): string[] {
  if (json === null) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((name) => typeof name === "string")) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return [];
}

function summaryFromJoined(
  prefix: "production" | "staging",
  row: CertDomainWithCertificatesRow,
): CertificateSummaryOut | null {
  const id = row[`${prefix}_id`];
  if (id === null) return null;
  return {
    id,
    environment: prefix,
    serial: row[`${prefix}_serial`] ?? "",
    fingerprint_sha256: row[`${prefix}_fingerprint_sha256`] ?? "",
    sans: parseSans(row[`${prefix}_sans_json`]),
    not_before: row[`${prefix}_not_before`] ?? "",
    not_after: row[`${prefix}_not_after`] ?? "",
    profile: row[`${prefix}_profile`] ?? "",
    purged_at: row[`${prefix}_purged_at`],
    created_at: row[`${prefix}_created_at`] ?? "",
  };
}

export function domainOut(
  row: CertDomainWithCertificatesRow,
): CertDomainOut {
  return {
    id: row.id,
    name: row.name,
    path: certPathName(row.name),
    zone_id: row.zone_id,
    include_wildcard: row.include_wildcard === 1,
    acme_profile: ACME_PROFILE,
    renew_before_days: row.renew_before_days,
    status: row.status,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    production_certificate: summaryFromJoined("production", row),
    staging_certificate: summaryFromJoined("staging", row),
  };
}

export async function createDomain(env: Env, input: CertDomainCreate): Promise<CertDomainOut> {
  let normalized: string;
  try {
    normalized = normalizedDomainName(input.name);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "invalid domain");
  }
  // A wildcard-only row issues exactly the wildcard SAN; the toggle is off.
  const wildcardOnly = normalized.startsWith("*.");
  const includeWildcard = wildcardOnly ? false : input.include_wildcard;

  const zoneId = await resolveZone(env, input, normalized);

  const existing = await findCertDomainByName(env.DB, normalized);
  if (existing) {
    throw new ActiveIssueRunNameConflict(normalized, existing.status);
  }
  // Both rows would produce the same wildcard SAN: one must go.
  const overlap = await findWildcardOverlap(env.DB, normalized, includeWildcard);
  if (overlap) {
    throw new WildcardOverlapError(overlap, normalized);
  }

  const id = crypto.randomUUID();
  await createCertDomain(env.DB, {
    id,
    name: normalized,
    zone_id: zoneId,
    include_wildcard: includeWildcard ? 1 : 0,
    acme_profile: ACME_PROFILE,
    renew_before_days: input.renew_before_days,
  });
  return await domainOutById(env, id);
}

export class ActiveIssueRunNameConflict extends Error {
  constructor(name: string, status: string) {
    super(`A cert domain row already exists for ${name} (status: ${status})`);
    this.name = "ActiveIssueRunNameConflict";
  }
}

async function findWildcardOverlap(
  db: D1Database,
  normalized: string,
  includeWildcard: boolean,
): Promise<CertDomainRow | null> {
  const baseName = normalized.replace(/^\*\./, "");
  // `example.com` + include_wildcard issues `*.example.com`; a dedicated
  // `*.example.com` row issues exactly that SAN. Either pairing collides.
  const otherName = normalized.startsWith("*.") ? baseName : `*.${baseName}`;
  const other = await findCertDomainByName(db, otherName);
  if (!other || other.status === "deleted") return null;
  if (normalized.startsWith("*.")) return other.include_wildcard === 1 ? other : null;
  return includeWildcard ? other : null;
}

export async function domainOutById(env: Env, id: string): Promise<CertDomainOut> {
  const row = await getCertDomainWithCertificates(env.DB, id);
  if (!row || row.status === "deleted") throw new CertDomainNotFoundError(id);
  return domainOut(row);
}

export async function listDomainOuts(
  env: Env,
  options: { limit?: number; offset?: number } = {},
): Promise<CertDomainOut[]> {
  const rows = await listCertDomains(env.DB, {
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
  });
  // Soft-deleted rows keep their history in D1 but leave the API surface.
  return rows.filter((row) => row.status !== "deleted").map(domainOut);
}

export async function getDomainOut(env: Env, id: string): Promise<CertDomainOut> {
  return domainOutById(env, id);
}

/**
 * WHAT: apply one PATCH body to a domain row.
 *
 * WHY read-merge-write: the store's settings setter takes complete values;
 * the PATCH contract (missing = unchanged) is applied here.
 */
export async function updateDomain(env: Env, id: string, patch: CertDomainUpdate): Promise<CertDomainOut> {
  const domain = await getCertDomain(env.DB, id);
  if (!domain || domain.status === "deleted") {
    throw new CertDomainNotFoundError(id);
  }
  if (domain.name.startsWith("*.") && patch.include_wildcard !== null) {
    throw new ApiError(400, "the wildcard toggle does not apply to wildcard-only domain rows");
  }
  const includeWildcard =
    patch.include_wildcard === null ? domain.include_wildcard : patch.include_wildcard ? 1 : 0;
  if (patch.include_wildcard === true && domain.include_wildcard !== 1) {
    const overlap = await findWildcardOverlap(env.DB, domain.name, true);
    if (overlap) throw new WildcardOverlapError(overlap, domain.name);
  }
  await updateCertDomainSettings(env.DB, id, {
    include_wildcard: includeWildcard,
    acme_profile: ACME_PROFILE,
    renew_before_days:
      patch.renew_before_days === null ? null : (patch.renew_before_days ?? domain.renew_before_days),
    status: (patch.status ?? domain.status) as CertDomainStatus,
  });
  return domainOutById(env, id);
}

/**
 * WHAT: soft-delete one domain.
 *
 * WHY no revocation: v1 deliberately has no revoke path — deletion stops
 * future issuance and assignment; issued
 * certificates stay valid until they expire.
 */
export async function deleteDomain(env: Env, id: string): Promise<void> {
  const domain = await getCertDomain(env.DB, id);
  if (!domain || domain.status === "deleted") {
    throw new CertDomainNotFoundError(id);
  }
  if (await findActiveIssueRun(env.DB, id)) {
    throw new ActiveIssueRunError(id);
  }
  await softDeleteCertDomain(env.DB, id);
  await deleteNodeCertDomainAssignments(env.DB, id);
}

// ---------------------------------------------------------------- issuance

export async function issueDomain(
  env: Env,
  id: string,
  body: unknown,
): Promise<{ run_id: string; workflow_id: string; status: "queued"; environment: AcmeEnvironment }> {
  const domain = await requireActiveDomain(env, id);
  const confirm = CertDomainIssueConfirm.parse(body ?? {}).confirm;
  if (confirm !== domain.name) {
    throw new ApiError(400, `confirm must be exactly '${domain.name}'`);
  }
  return await start(env, id, "production", "manual");
}

export async function testIssueDomain(
  env: Env,
  id: string,
): Promise<{ run_id: string; workflow_id: string; status: "queued"; environment: AcmeEnvironment }> {
  await requireActiveDomain(env, id);
  return await start(env, id, "staging", "test");
}

async function start(
  env: Env,
  domainId: string,
  environment: AcmeEnvironment,
  trigger: IssueTrigger,
): Promise<{ run_id: string; workflow_id: string; status: "queued"; environment: AcmeEnvironment }> {
  const { runId, workflowId } = await startIssueRun(env.DB, env.ISSUANCE, domainId, {
    environment,
    trigger,
  });
  return { run_id: runId, workflow_id: workflowId, status: "queued", environment };
}

async function requireActiveDomain(env: Env, id: string): Promise<CertDomainRow> {
  const domain = await getCertDomain(env.DB, id);
  if (!domain || domain.status === "deleted") {
    throw new CertDomainNotFoundError(id);
  }
  if (domain.status !== "active") {
    throw new ApiError(409, `cert domain ${domain.name} is ${domain.status}, not active`);
  }
  return domain;
}

/** WHAT: a domain's runs joined with names, newest first, capped at 20. */
export async function listDomainRuns(env: Env, domainId: string): Promise<CertRunOut[]> {
  const rows = await listIssueRunsByDomain(env.DB, domainId, 20);
  return (rows as unknown as Array<Record<string, unknown>>).map(runOut);
}

export function runOut(row: Record<string, unknown>): CertRunOut {
  let steps: CertRunStep[] = [];
  try {
    const parsed: unknown = JSON.parse((row["steps_json"] as string) ?? "[]");
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (entry) => typeof entry === "object" && entry !== null &&
          typeof (entry as { phase?: unknown }).phase === "string",
      )
    ) {
      steps = parsed as CertRunStep[];
    }
  } catch {
    steps = [];
  }
  return {
    id: String(row["id"]),
    domain_id: String(row["domain_id"]),
    domain_name: String(row["domain_name"]),
    environment: row["environment"] as AcmeEnvironment,
    trigger: String(row["trigger"]),
    status: String(row["status"]),
    phase: (row["phase"] as string | null) ?? null,
    error: (row["error"] as string | null) ?? null,
    workflow_id: String(row["workflow_id"]),
    started_at: (row["started_at"] as string | null) ?? null,
    finished_at: (row["finished_at"] as string | null) ?? null,
    created_at: String(row["created_at"] ?? ""),
    steps,
  };
}

export async function getRun(env: Env, id: string): Promise<CertRunOut> {
  const row = await env.DB.prepare(
    `SELECT r.*, d.name AS domain_name FROM issue_runs r
       JOIN cert_domains d ON d.id = r.domain_id WHERE r.id = ?`,
  ).bind(id).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "run not found");
  return runOut(row);
}

function certificateOut(row: CertificateRow, domainName: string): CertificateOut {
  return {
    id: row.id,
    domain_id: row.domain_id,
    domain_name: domainName,
    environment: row.environment,
    serial: row.serial,
    fingerprint_sha256: row.fingerprint_sha256,
    sans: parseSans(row.sans_json),
    not_before: row.not_before,
    not_after: row.not_after,
    profile: row.profile,
    is_current: row.is_current === 1,
    purged_at: row.purged_at,
    created_at: row.created_at,
  };
}

export async function listDomainCertificates(env: Env, domainId: string): Promise<CertificateOut[]> {
  const rows = await listCertificatesByDomain(env.DB, domainId, 50);
  return rows.map((row) => certificateOut(row, row.domain_name));
}

/** WHAT: the raw row getter, named apart from the OUT projection. */
function getCertificateRow(db: D1Database, id: string) {
  return getCertificateById(db, id);
}

export async function getCertificateOut(env: Env, id: string): Promise<CertificateOut> {
  const row = await getCertificateRow(env.DB, id);
  if (!row) throw new ApiError(404, "certificate not found");
  const domain = await getCertDomain(env.DB, row.domain_id);
  return certificateOut(row, domain?.name ?? "");
}

const DOWNLOAD_FILES = {
  cert: { column: "cert_pem", contentType: "application/x-pem-file" },
  chain: { column: "chain_pem", contentType: "application/x-pem-file" },
  fullchain: { column: "fullchain_pem", contentType: "application/x-pem-file" },
} as const;
export type DownloadFile = keyof typeof DOWNLOAD_FILES | "key";

/**
 * WHAT: return one artifact's PEM text, unsealing the private key.
 *
 * WHY key is not in DOWNLOAD_FILES: it is sealed with KEY_SECRET, so its
 * value needs unsealing while the three certificate PEMs are returned as
 * stored.
 */
export async function downloadCertificate(
  env: Env,
  id: string,
  file: DownloadFile,
): Promise<{ body: string; contentType: string }> {
  const row = await getCertificateRow(env.DB, id);
  if (!row) throw new ApiError(404, "certificate not found");

  const artifacts = await getCertificateArtifacts(env.DB, id);
  if (file === "key") {
    if (artifacts === null) throw new CertificateArtifactsMissingError(id, "private_key");
    return {
      body: await unseal(env, "certificate private key", artifacts.private_key),
      contentType: "application/x-pem-file",
    };
  }

  const spec = DOWNLOAD_FILES[file];
  const body = artifacts?.[spec.column] ?? null;
  if (body === null) throw new CertificateArtifactsMissingError(id, spec.column);
  return { body, contentType: spec.contentType };
}

// -------------------------------------------------------- node assignment

/**
 * WHAT: replace one node's certificate-domain assignment.
 *
 * WHY 422 and not 404 on unknown ids: the body as a whole is well-formed
 * but references resources that do not exist — a validation failure of the
 * payload, not a missing route target.
 */
export async function setNodeAssignment(
  env: Env,
  nodeId: string,
  domainIds: string[],
): Promise<void> {
  const seen = new Set<string>();
  for (const domainId of domainIds) {
    if (seen.has(domainId)) throw new ApiError(422, `duplicate cert domain id '${domainId}'`);
    seen.add(domainId);
    const domain = await getCertDomain(env.DB, domainId);
    if (!domain || domain.status === "deleted") {
      throw new InvalidAssignmentError(domainId);
    }
  }
  await replaceNodeCertDomains(env.DB, nodeId, domainIds, Math.floor(Date.now() / 1000));
}

export async function nodeCertDomainState(
  env: Env,
  nodeId: string,
): Promise<NodeCertDomainsOut> {
  const node = await requireNode(env, nodeId);
  const assigned = new Set(
    (await env.DB.prepare("SELECT domain_id FROM node_cert_domains WHERE node_id = ?")
      .bind(nodeId).all<{ domain_id: string }>()).results.map((row) => row.domain_id),
  );
  const rows = await listCertDomains(env.DB, { limit: 200, offset: 0 });
  const domains: NodeCertDomainOut[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    status: row.status,
    assigned: assigned.has(row.id),
    current_certificate: summaryFromJoined(node.cert_environment, row),
  }));
  return {
    node_id: nodeId,
    cert_environment: node.cert_environment,
    domains,
    nginx_ok: node.nginx_ok,
    nginx_error: node.nginx_error,
    cert_synced_at: node.cert_synced_at,
  };
}

export async function nodeCertSummaries(env: Env, nodeId: string): Promise<NodeCertsOut> {
  const node = await requireNode(env, nodeId);
  const rows = await listNodeAssignedDomains(env.DB, nodeId, node.cert_environment);
  const certs: NodeCertSummary[] = [];
  for (const row of rows) {
    if (row.certificate_id === null) continue;
    certs.push({
      domain: row.domain_name,
      path: certPathName(row.domain_name),
      sans: parseSans(row.certificate_sans_json),
      serial: row.certificate_serial ?? "",
      fingerprint_sha256: row.certificate_fingerprint_sha256 ?? "",
      not_before: row.certificate_not_before ?? "",
      not_after: row.certificate_not_after ?? "",
      profile: row.certificate_profile ?? "",
    });
  }
  return {
    node_id: nodeId,
    cert_environment: node.cert_environment,
    nginx_ok: node.nginx_ok,
    nginx_error: node.nginx_error,
    cert_synced_at: node.cert_synced_at,
    certs,
  };
}

export async function requireNode(env: Env, nodeId: string): Promise<NodeRow> {
  const node = await nodeDb.getNode(env.DB, nodeId);
  if (!node) throw new ApiError(404, "node not found");
  return node;
}

// --------------------------------------------------------------- delivery

/**
 * WHAT: the node's delivery manifest — assigned active domains with their
 * current certificate PEMs for the node's own ACME environment, plus the
 * composite ETag.
 *
 * WHY all-or-nothing: a missing artifact or unseal failure throws, so the
 * router answers 500 and the agent keeps its previous files; a partial
 * manifest could let nginx serve mismatched key/cert pairs.
 *
 * WHY the environment comes from the node row: production and staging are
 * separate current pointers per domain, and a node is served exactly one of
 * them. A staging node with no staging certificate therefore receives an
 * empty manifest — never the production bytes, which clients would trust
 * while the operator believes they are testing the staging path.
 */
export interface NodeCertManifestEntry {
  domain: string;
  path: string;
  sans: string[];
  serial: string;
  fingerprint_sha256: string;
  not_before: string;
  not_after: string;
  profile: string;
  fullchain_pem: string;
  private_key_pem: string;
}

export interface NodeCertManifest {
  etag: string;
  certs: NodeCertManifestEntry[];
}

export async function nodeCertManifest(env: Env, nodeId: string): Promise<NodeCertManifest> {
  const node = await requireNode(env, nodeId);
  const rows = await listNodeAssignedDomains(env.DB, nodeId, node.cert_environment);
  const active = rows.filter((row) => row.domain_status === "active" && row.certificate_id !== null);
  const certs: NodeCertManifestEntry[] = [];
  for (const row of active) {
    const certificateId = row.certificate_id!;
    const artifacts = await getCertificateArtifacts(env.DB, certificateId);
    if (artifacts === null) {
      throw new CertificateArtifactsMissingError(certificateId, "artifacts");
    }
    // All-or-nothing: one incomplete artifact row fails the whole manifest so
    // the node keeps the files it already has instead of adopting a partial set.
    const {
      private_key: sealedKey,
      cert_pem: certPem,
      chain_pem: chainPem,
      fullchain_pem: fullchain,
    } = artifacts;
    if (certPem === null || chainPem === null || fullchain === null) {
      const missing =
        certPem === null ? "cert_pem" : chainPem === null ? "chain_pem" : "fullchain_pem";
      throw new CertificateArtifactsMissingError(certificateId, missing);
    }
    certs.push({
      domain: row.domain_name,
      path: certPathName(row.domain_name),
      sans: parseSans(row.certificate_sans_json),
      serial: row.certificate_serial ?? "",
      fingerprint_sha256: row.certificate_fingerprint_sha256 ?? "",
      not_before: row.certificate_not_before ?? "",
      not_after: row.certificate_not_after ?? "",
      profile: row.certificate_profile ?? "",
      fullchain_pem: fullchain,
      private_key_pem: await unseal(env, "certificate private key", sealedKey),
    });
  }
  return { etag: await manifestEtag(certs), certs };
}

/**
 * WHAT: the composite delivery ETag: SHA-256 over the domain/fingerprint
 * pairs, sorted, quoted.
 *
 * WHY sorting: the same certificate set must hash the same regardless of
 * row order; assignment changes that do not change the certificate set
 * keep the same ETag.
 */
export async function manifestEtag(certs: NodeCertManifestEntry[]): Promise<string> {
  const parts = certs
    .map((cert) => `${cert.domain}\0${cert.fingerprint_sha256}`)
    .sort();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("\n")),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `"${hex}"`;
}

// ------------------------------------------------------------ error mapping

/**
 * WHAT: map a thrown error to an ApiError the router can render.
 *
 * WHY central: every admin cert endpoint shares the same vocabulary
 * (404 unknown, 409 conflicts, 422 invalid assignment, 502 Cloudflare),
 * and one mapping keeps status codes consistent across handlers.
 */
export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ActiveIssueRunError) {
    return new ApiError(409, error.message);
  }
  if (
    error instanceof ActiveIssueRunNameConflict ||
    error instanceof WildcardOverlapError ||
    error instanceof IssueDomainNotActiveError
  ) {
    return new ApiError(409, error.message);
  }
  if (error instanceof CertDomainNotFoundError || error instanceof IssueDomainNotFoundError) {
    return new ApiError(404, error.message);
  }
  if (error instanceof InvalidAssignmentError) {
    return new ApiError(422, error.message);
  }
  if (error instanceof CertificateArtifactsMissingError) {
    // The certificate row exists, so this is broken server state, not a 404.
    return new ApiError(500, error.message);
  }
  if (error instanceof CloudflareApiError) {
    return new ApiError(502, error.message);
  }
  if (error instanceof DnsZoneError) {
    return new ApiError(502, error.message);
  }
  if (error instanceof TypeError) {
    return new ApiError(400, error.message);
  }
  return new ApiError(500, error instanceof Error ? error.message : String(error));
}

export class DnsZoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsZoneError";
  }
}

