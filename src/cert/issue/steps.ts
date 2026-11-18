/**
 * Issuance steps: the pure(ish) building blocks the Workflow binds into
 * durable steps. Ported from certworker's steps.ts with three Vela
 * changes:
 *
 * 1. The directory URL is chosen by `environment` from the ACME_DIRECTORIES
 *    constant — there is no `ACME_DIRECTORY` Worker variable to misread.
 * 2. The ACME account private key is sealed in D1 (`acme_accounts`,
 *    `key_cipher.seal`, `v1:` text) instead of a binary envelope.
 * 3. `newOrder` requests the one ACME profile the plane uses (`tlsserver`).
 */

import { NonRetryableError } from "cloudflare:workflows";
import { AcmeClient, type AcmeIdentifier, type AcmeOrder } from "../acme/client";
import { AcmeError, AcmeProtocolError, isRateLimited } from "../acme/errors";
import {
  dns01RecordName,
  dns01Value,
  normalizeDomainName,
  observeTxtPropagation,
} from "../acme/dns01";
import { CloudflareApiError, createTxtRecord, deleteTxtRecord } from "../dns/cloudflare";
import { activeDnsToken } from "../credentials";
import { parseCertificate, splitCertificateChain } from "../crypto/certificate";
import { buildCsr } from "../crypto/csr";
import { b64uDecode, b64uEncode } from "../crypto/base64url";
import { exportPrivateKeyPem, importPrivateKeyPem } from "../crypto/pem";
import { exportPublicJwk, generateEcP256KeyPair, jwkThumbprint } from "../crypto/keys";
import { seal, unseal } from "../../services/key_cipher";
import {
  activateCertificate,
  deleteCertificateArtifacts,
  findPendingChallengeRecord,
  getAcmeAccount,
  getCertificate,
  getCertificateArtifacts,
  getCurrentCertificate,
  getCertDomain,
  insertChallengeRecord,
  listPendingChallengeRecords,
  markCertificatePurged,
  markChallengeRecordDeleted,
  putCertificateArtifacts,
  putCertificatePrivateKey,
  saveAcmeAccount,
  type CertificateRow,
  type CertDomainRow,
} from "../store/d1";
import { ACME_PROFILE } from "../models";
import { ACME_DIRECTORIES, type AcmeEnvironment } from "./types";

export interface IssueTimings {
  dnsTimeoutMs: number;
  dnsPollIntervalMs: number;
  dnsSettleMs: number;
  dnsRequestTimeoutMs: number;
  acmeTimeoutMs: number;
  acmePollIntervalMs: number;
  acmeRequestTimeoutMs: number;
}

/**
 * WHAT: the Env slice issuance needs.
 *
 * WHY the whole `env` rides along: `key_cipher.seal/unseal` reads
 * `env.KEY_SECRET`, and the cron/test seams pass the full binding object.
 * The DNS token is not here: it is a sealed row, resolved per call by
 * `activeDnsToken`.
 */
export type IssueEnv = Pick<Env, "DB" | "KEY_SECRET">;

export interface IssueDependencies {
  env: IssueEnv;
  db: D1Database;
  environment: AcmeEnvironment;
  directoryUrl: string;
  /**
   * WHAT: no threaded DNS token.
   *
   * WHY: the credential is runtime state now — a panel action can activate
   * a new one mid-run, and every DNS call must use what is in force at
   * that moment. Each call site resolves through `activeDnsToken`, which
   * fails with the named "no DNS credential configured" sentence instead
   * of surfacing a Cloudflare 401.
   */
  fetcher: typeof fetch;
  timings: IssueTimings;
}

export interface LoadedIssue {
  domain: CertDomainRow;
  identifiers: AcmeIdentifier[];
  previousCertificate: CertificateRow | null;
}

export interface AcmeAccountState {
  environment: AcmeEnvironment;
  accountUrl: string;
  thumbprint: string;
}

export interface NewOrderState {
  orderUrl: string;
  authorizations: string[];
  /** The requested profile; the CA echo was checked to match in the client. */
  profile: string;
}

export interface AuthorizationWorkItem {
  authorizationUrl: string;
  identifier: string;
  status: "valid" | "pending";
  challengeUrl?: string;
  challengeStatus?: string;
}

export interface PublishedChallenges {
  authorizations: AuthorizationWorkItem[];
  targets: Array<{ name: string; values: string[] }>;
}

export interface LeafKeyState {
  certificateId: string;
  csrB64u: string;
  publicJwk: Awaited<ReturnType<typeof exportPublicJwk>>;
}

export interface StoredCertificate {
  certificateId: string;
  serial: string;
  fingerprintSha256: string;
  sans: string[];
  notBefore: string;
  notAfter: string;
  profile: string;
}

const DEFAULT_TIMINGS: IssueTimings = {
  dnsTimeoutMs: 5 * 60_000,
  dnsPollIntervalMs: 5_000,
  dnsSettleMs: 10_000,
  dnsRequestTimeoutMs: 10_000,
  acmeTimeoutMs: 5 * 60_000,
  acmePollIntervalMs: 3_000,
  acmeRequestTimeoutMs: 30_000,
};

/**
 * WHAT: the most propagation checks one order attempt may spend.
 *
 * WHY a cap and not the full window at the configured interval: every check
 * fetches one DoH resolver per target, and a Workflow instance has a hard
 * subrequest budget (50 on the Workers Free plan). A 300 s window at a 5 s
 * interval would spend 120 subrequests on propagation alone and leave
 * nothing for publish, accept, and cleanup — and a run that cannot clean up
 * strands `_acme-challenge` records in the zone. Ten checks spread over the
 * same window fit the budget, and the pre-check settle (propagationWindow)
 * makes the first one count, so a healthy publish converges on check one.
 */
const PROPAGATION_MAX_CHECKS = 10;

/**
 * WHAT: the polling shape for TXT propagation within a subrequest budget.
 *
 * WHY the interval is derived: the time window stays what the operator
 * configured (`dnsTimeoutMs`), while the number of questions asked is
 * capped by what the run can afford. `dnsSettleMs` becomes the initial
 * delay — asking before the record is live would be answered from a cache
 * for the zone's negative TTL.
 */
export function propagationWindow(timings: IssueTimings): {
  attempts: number;
  intervalMs: number;
  initialDelayMs: number;
} {
  const attempts = Math.max(
    1,
    Math.min(PROPAGATION_MAX_CHECKS, Math.ceil(timings.dnsTimeoutMs / timings.dnsPollIntervalMs)),
  );
  return {
    attempts,
    intervalMs: Math.max(timings.dnsPollIntervalMs, Math.ceil(timings.dnsTimeoutMs / attempts)),
    initialDelayMs: timings.dnsSettleMs,
  };
}

export function createIssueDependencies(
  env: IssueEnv,
  environment: AcmeEnvironment,
  options: { fetcher?: typeof fetch; timings?: Partial<IssueTimings> } = {},
): IssueDependencies {
  const directoryUrl = ACME_DIRECTORIES[environment];
  assertHttpsUrl(directoryUrl, "ACME directory URL");
  return {
    env,
    db: env.DB,
    environment,
    directoryUrl,
    fetcher: options.fetcher ?? globalThis.fetch,
    timings: { ...DEFAULT_TIMINGS, ...options.timings },
  };
}

export async function loadIssue(
  deps: IssueDependencies,
  runId: string,
  domainId: string,
): Promise<LoadedIssue> {
  const domain = await getCertDomain(deps.db, domainId);
  if (!domain) throw new NonRetryableError(JSON.stringify({ error: "cert_domain_not_found", domainId }));
  if (domain.status !== "active") {
    throw new NonRetryableError(
      JSON.stringify({ error: "cert_domain_not_active", domainId, status: domain.status }),
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) {
    throw new NonRetryableError("Issue run id is not safe for a certificate id");
  }

  let normalized: string;
  try {
    normalized = normalizeDomainName(domain.name);
  } catch (error) {
    throw new NonRetryableError(issueErrorMessage(error));
  }

  const identifiers: AcmeIdentifier[] = normalized.startsWith("*.")
    ? [{ type: "dns", value: normalized }]
    : [
        { type: "dns", value: normalized },
        ...(domain.include_wildcard === 1
          ? [{ type: "dns" as const, value: `*.${normalized}` }]
          : []),
      ];

  return {
    domain,
    identifiers,
    // Same environment only: a staging run must never see (or purge) the
    // production current, and vice versa.
    previousCertificate: await getCurrentCertificate(deps.db, domainId, deps.environment),
  };
}

export async function ensureAcmeAccount(deps: IssueDependencies): Promise<AcmeAccountState> {
  const existing = await getAcmeAccount(deps.db, deps.environment);
  if (existing) {
    if (existing.directory_url !== deps.directoryUrl) {
      throw new NonRetryableError(
        `ACME account for ${deps.environment} belongs to a different directory`,
      );
    }
    const context = await loadAcmeAccount(deps);
    return {
      environment: deps.environment,
      accountUrl: context.accountUrl,
      thumbprint: context.thumbprint,
    };
  }

  const keyPair = await generateEcP256KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const client = new AcmeClient({
    directoryUrl: deps.directoryUrl,
    accountKey: keyPair,
    fetch: deps.fetcher,
    requestTimeoutMs: deps.timings.acmeRequestTimeoutMs,
  });

  let accountUrl: string;
  try {
    accountUrl = await client.ensureAccount();
  } catch (error) {
    throwPermanentAcmeError(error);
  }

  const privateKeyPem = await exportPrivateKeyPem(keyPair.privateKey);
  await saveAcmeAccount(deps.db, {
    environment: deps.environment,
    directory_url: deps.directoryUrl,
    account_url: accountUrl,
    private_key: await seal(deps.env, privateKeyPem),
    public_jwk: JSON.stringify(publicJwk),
    thumbprint: await jwkThumbprint(publicJwk),
  });

  const saved = await loadAcmeAccount(deps);
  return { environment: deps.environment, accountUrl: saved.accountUrl, thumbprint: saved.thumbprint };
}

export async function createOrder(
  deps: IssueDependencies,
  identifiers: AcmeIdentifier[],
): Promise<NewOrderState> {
  const { client } = await loadAcmeAccount(deps);
  let order: AcmeOrder;
  try {
    order = await client.newOrder(identifiers, ACME_PROFILE);
    if (!sameIdentifiers(order.identifiers, identifiers)) {
      throw new NonRetryableError("ACME order identifiers did not match the requested SANs");
    }
    return {
      orderUrl: order.url,
      authorizations: order.authorizations,
      profile: order.profile ?? ACME_PROFILE,
    };
  } catch (error) {
    throwPermanentAcmeError(error);
  }
}

export async function publishTxtChallenges(
  deps: IssueDependencies,
  runId: string,
  domain: CertDomainRow,
  authorizationUrls: string[],
): Promise<PublishedChallenges> {
  const { client, thumbprint } = await loadAcmeAccount(deps);
  const authorizations: AuthorizationWorkItem[] = [];
  const targets = new Map<string, Set<string>>();

  for (const authorizationUrl of [...new Set(authorizationUrls)]) {
    let authorization;
    try {
      authorization = await client.getAuthorization(authorizationUrl);
    } catch (error) {
      throwPermanentAcmeError(error);
    }

    const identifier = authorization.identifier.value;
    if (authorization.status === "valid") {
      authorizations.push({ authorizationUrl, identifier, status: "valid" });
      continue;
    }
    if (authorization.status === "invalid") {
      throw new NonRetryableError(
        problemMessage(authorization.error, `Authorization for ${identifier} is invalid`),
      );
    }

    const challenge = authorization.challenges.find(({ type }) => type === "dns-01");
    if (!challenge) {
      throw new NonRetryableError(`ACME returned no DNS-01 challenge for ${identifier}`);
    }
    if (challenge.status === "invalid") {
      throw new NonRetryableError(
        problemMessage(challenge.error, `DNS-01 challenge for ${identifier} is invalid`),
      );
    }
    if (challenge.status === "valid") {
      authorizations.push({
        authorizationUrl,
        identifier,
        status: "pending",
        challengeUrl: challenge.url,
        challengeStatus: "valid",
      });
      continue;
    }
    if (!challenge.token) {
      throw new NonRetryableError(`DNS-01 challenge for ${identifier} is missing its token`);
    }

    const value = await dns01Value(challenge.token, thumbprint);
    const name = dns01RecordName(identifier);
    const existingRecord = await findPendingChallengeRecord(deps.db, runId, name, value);
    let recordId = existingRecord?.cf_record_id;
    if (!recordId) {
      try {
        recordId = await createTxtRecord({
          apiToken: await activeDnsToken(deps.env),
          zoneId: domain.zone_id,
          name,
          value,
          ttl: 60,
          fetch: deps.fetcher,
          requestTimeoutMs: deps.timings.dnsRequestTimeoutMs,
        });
      } catch (error) {
        throwPermanentCloudflareError(error);
      }
      await insertChallengeRecord(deps.db, {
        id: crypto.randomUUID(),
        run_id: runId,
        zone_id: domain.zone_id,
        cf_record_id: recordId,
        name,
        value,
      });
    }

    const values = targets.get(name) ?? new Set<string>();
    values.add(value);
    targets.set(name, values);

    authorizations.push({
      authorizationUrl,
      identifier,
      status: "pending",
      challengeUrl: challenge.url,
      challengeStatus: challenge.status,
    });
  }

  return {
    authorizations,
    targets: [...targets].map(([name, values]) => ({ name, values: [...values] })),
  };
}

/**
 * WHAT: one propagation check; true once every TXT value is visible.
 *
 * WHY single-pass: the Workflow polls this through durable steps so each
 * invocation stays inside the subrequest budget; the blocking variant is
 * kept for non-Workflow callers and unit tests.
 *
 * WHY a check where every resolver *errored* throws instead of answering
 * "not visible": a failed fetch is not evidence that DNS has not
 * propagated. Looping on it burns the run's subrequest budget and reports
 * a timeout that blames DNS, hiding the real cause (typically budget
 * exhaustion, whose message names itself). Real NODATA is a valid
 * "not yet"; an exception is not.
 */
export async function checkTxtPropagation(
  deps: IssueDependencies,
  published: PublishedChallenges,
): Promise<boolean> {
  if (published.targets.length === 0) return true;
  const observation = await observeTxtPropagation(published.targets, {
    fetch: deps.fetcher,
    requestTimeoutMs: deps.timings.dnsRequestTimeoutMs,
  });
  const failures = Object.values(observation.missingByResolver);
  const allErrored =
    failures.length > 0 &&
    failures.every(
      (missing) => missing.length > 0 && missing.every((entry) => entry.startsWith("resolver error:")),
    );
  if (allErrored) {
    throw new Error(`DNS propagation check failed: ${failures.flat().join("; ")}`);
  }
  return observation.allVisible;
}

export async function acceptChallenges(
  deps: IssueDependencies,
  published: PublishedChallenges,
): Promise<void> {
  const pending = published.authorizations.filter(
    (
      item,
    ): item is AuthorizationWorkItem & { challengeUrl: string; challengeStatus: string } =>
      item.challengeStatus === "pending" && typeof item.challengeUrl === "string",
  );
  if (pending.length === 0) return;

  const { client } = await loadAcmeAccount(deps);
  for (const authorization of pending) {
    try {
      await client.acceptChallenge(authorization.challengeUrl);
    } catch (error) {
      throwPermanentAcmeError(error);
    }
  }
}

/**
 * WHAT: one authorization check; true when all are valid, false while pending.
 *
 * WHY single-pass: same durable-polling reason as the propagation check. An
 * invalid authorization throws the CA's problem document verbatim, which is
 * what the panel shows and what the order ring inspects for expiry.
 */
export async function checkAuthorizations(
  deps: IssueDependencies,
  published: PublishedChallenges,
): Promise<boolean> {
  const pending = published.authorizations.filter(({ status }) => status !== "valid");
  if (pending.length === 0) return true;

  const { client } = await loadAcmeAccount(deps);
  for (const authorization of pending) {
    let fresh: Awaited<ReturnType<typeof client.getAuthorization>>;
    try {
      fresh = await client.getAuthorization(authorization.authorizationUrl);
    } catch (error) {
      throwPermanentAcmeError(error);
    }
    if (fresh.status === "invalid") {
      const problem = fresh.error ?? {
        type: "urn:ietf:params:acme:error:malformed",
        detail: `Authorization for ${fresh.identifier.value} became invalid`,
      };
      throw new NonRetryableError(JSON.stringify(problem));
    }
    if (fresh.status !== "valid") return false;
  }
  return true;
}

/**
 * WHAT: one order-readiness check.
 *
 * WHY return the order: finalize needs the current `finalize` URL, and a
 * durable polling loop must hand the freshest order to the next step.
 * Returns null while the order is still pending.
 */
export interface ReadyOrder {
  finalize: string;
}

export async function checkOrderReadiness(
  deps: IssueDependencies,
  order: NewOrderState,
): Promise<ReadyOrder | null> {
  const { client } = await loadAcmeAccount(deps);
  let fresh: AcmeOrder;
  try {
    fresh = await client.getOrder(order.orderUrl);
  } catch (error) {
    throwPermanentAcmeError(error);
  }
  if (fresh.status === "ready") return { finalize: fresh.finalize };
  if (fresh.status === "pending") return null;
  if (fresh.status === "invalid") {
    throw new NonRetryableError(JSON.stringify(fresh.error ?? {
      type: "urn:ietf:params:acme:error:malformed",
      detail: `Order ${order.orderUrl} became invalid`,
    }));
  }
  throw new NonRetryableError(
    `Expected order ${order.orderUrl} to become ready, received status ${fresh.status}`,
  );
}

/** WHAT: submit the CSR once the order is ready (single ACME request). */
export async function finalizeOrder(
  deps: IssueDependencies,
  order: NewOrderState,
  readyOrder: ReadyOrder,
  leaf: LeafKeyState,
): Promise<void> {
  const { client } = await loadAcmeAccount(deps);
  try {
    await client.finalizeOrder(readyOrder.finalize, b64uDecode(leaf.csrB64u), order.orderUrl);
  } catch (error) {
    throwPermanentAcmeError(error);
  }
}

/**
 * WHAT: one order-validity check; returns the valid order, null while processing.
 */
export interface ValidOrder {
  certificate: string;
}

export async function checkOrderValidity(
  deps: IssueDependencies,
  order: NewOrderState,
): Promise<ValidOrder | null> {
  const { client } = await loadAcmeAccount(deps);
  let fresh: AcmeOrder;
  try {
    fresh = await client.getOrder(order.orderUrl);
  } catch (error) {
    throwPermanentAcmeError(error);
  }
  if (fresh.status === "valid") {
    if (!fresh.certificate) {
      throw new NonRetryableError("Valid ACME order is missing its certificate URL");
    }
    return { certificate: fresh.certificate };
  }
  if (fresh.status === "processing" || fresh.status === "ready") return null;
  if (fresh.status === "invalid") {
    throw new NonRetryableError(JSON.stringify(fresh.error ?? {
      type: "urn:ietf:params:acme:error:malformed",
      detail: `Order ${order.orderUrl} became invalid`,
    }));
  }
  throw new NonRetryableError(
    `Expected finalized order ${order.orderUrl} to become valid, received status ${fresh.status}`,
  );
}

export async function createLeafKeyAndCsr(
  deps: IssueDependencies,
  runId: string,
  identifiers: AcmeIdentifier[],
): Promise<LeafKeyState> {
  const certificateId = runId;
  const keyPair = await generateEcP256KeyPair();
  const publicJwk = await exportPublicJwk(keyPair.publicKey);
  const csr = await buildCsr(keyPair, identifiers.map(({ value }) => value));
  const key = await exportPrivateKeyPem(keyPair.privateKey);
  await putCertificatePrivateKey(
    deps.db,
    certificateId,
    await seal(deps.env, key),
    nowSeconds(),
  );

  return {
    certificateId,
    csrB64u: b64uEncode(csr.der),
    publicJwk,
  };
}

/**
 * WHAT: download, verify, and persist the certificate of a valid order.
 *
 * WHY the order arrives as an argument: polling happens in durable workflow
 * steps; this function performs the single, non-idempotent-sensitive tail
 * (one download + the artifacts rows + the activation).
 */
export async function storeIssuedCertificate(
  deps: IssueDependencies,
  domain: CertDomainRow,
  identifiers: AcmeIdentifier[],
  order: NewOrderState,
  leaf: LeafKeyState,
  validOrder: ValidOrder,
): Promise<StoredCertificate> {
  const existing = await getCertificate(deps.db, leaf.certificateId);
  if (existing) {
    if (existing.domain_id !== domain.id) {
      throw new Error(`Certificate ${leaf.certificateId} belongs to another domain`);
    }
    return storedCertificateFromRow(existing);
  }

  const { client } = await loadAcmeAccount(deps);
  if (!validOrder.certificate) {
    throw new NonRetryableError("Valid ACME order is missing its certificate URL");
  }

  let downloadedChain: string;
  try {
    downloadedChain = await client.downloadCertificate(validOrder.certificate);
  } catch (error) {
    throwPermanentAcmeError(error);
  }

  const chain = splitCertificateChain(downloadedChain);
  const parsed = await parseCertificate(chain.leafPem);
  if (!sameNames(parsed.sans, identifiers.map(({ value }) => value))) {
    throw new NonRetryableError(
      `Issued certificate SAN mismatch: expected [${identifiers.map(({ value }) => value).join(", ")}], received [${parsed.sans.join(", ")}]`,
    );
  }
  if (parsed.publicKeyJwk.x !== leaf.publicJwk.x || parsed.publicKeyJwk.y !== leaf.publicJwk.y) {
    throw new NonRetryableError("Issued certificate public key does not match the generated CSR key");
  }

  await assertPrivateKeyMatchesCertificate(deps, leaf, parsed.publicKeyJwk, parsed.fingerprintSha256);

  const issuedAt = new Date().toISOString();
  await putCertificateArtifacts(
    deps.db,
    leaf.certificateId,
    {
      certPem: chain.leafPem,
      chainPem: chain.chainPem,
      fullchainPem: chain.fullchainPem,
    },
    nowSeconds(),
  );

  const certificate: CertificateRow = {
    id: leaf.certificateId,
    domain_id: domain.id,
    environment: deps.environment,
    serial: parsed.serial,
    fingerprint_sha256: parsed.fingerprintSha256,
    sans_json: JSON.stringify(parsed.sans),
    not_before: parsed.notBefore,
    not_after: parsed.notAfter,
    profile: order.profile,
    issued_at: issuedAt,
    is_current: 0,
    purged_at: null,
    created_at: issuedAt,
  };
  // Same environment only (activateCertificate demotes within it).
  await activateCertificate(deps.db, certificate);

  return {
    certificateId: certificate.id,
    serial: certificate.serial,
    fingerprintSha256: certificate.fingerprint_sha256,
    sans: parsed.sans,
    notBefore: certificate.not_before,
    notAfter: certificate.not_after,
    profile: certificate.profile,
  };
}

export async function purgePreviousCertificate(
  deps: IssueDependencies,
  previous: CertificateRow | null,
): Promise<{ purged: boolean }> {
  if (!previous) return { purged: false };
  await deleteCertificateArtifacts(deps.db, previous.id);
  await markCertificatePurged(deps.db, previous.id);
  return { purged: true };
}

export async function cleanupFailedArtifacts(
  deps: IssueDependencies,
  certificateId: string,
): Promise<{ deleted: boolean }> {
  // Once a certificates row exists, the artifacts are committed history and stay intact.
  if (await getCertificate(deps.db, certificateId)) return { deleted: false };
  await deleteCertificateArtifacts(deps.db, certificateId);
  return { deleted: true };
}

export async function cleanupTxtRecords(
  deps: IssueDependencies,
  runId: string,
): Promise<{ deleted: number }> {
  const records = await listPendingChallengeRecords(deps.db, runId);
  const failures: string[] = [];
  let deleted = 0;

  for (const record of records) {
    try {
      await deleteTxtRecord({
        apiToken: await activeDnsToken(deps.env),
        zoneId: record.zone_id,
        recordId: record.cf_record_id,
        fetch: deps.fetcher,
        requestTimeoutMs: deps.timings.dnsRequestTimeoutMs,
      });
      await markChallengeRecordDeleted(deps.db, record.id);
      deleted += 1;
    } catch (error) {
      failures.push(`${record.cf_record_id}: ${issueErrorMessage(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Could not remove all ACME TXT records: ${failures.join("; ")}`);
  }
  return { deleted };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function issueErrorMessage(error: unknown): string {
  if (error instanceof AcmeError) return error.rawBody ?? JSON.stringify(error.problem);
  if (error instanceof CloudflareApiError) {
    return JSON.stringify({ status: error.status, errors: error.errors, message: error.message });
  }
  if (error instanceof AggregateError) {
    return [...error.errors].map(issueErrorMessage).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function loadAcmeAccount(
  deps: IssueDependencies,
): Promise<{ client: AcmeClient; accountUrl: string; thumbprint: string }> {
  const account = await getAcmeAccount(deps.db, deps.environment);
  if (!account) throw new Error(`ACME account for ${deps.environment} has not been initialized`);
  if (account.directory_url !== deps.directoryUrl) {
    throw new NonRetryableError(
      `ACME account for ${deps.environment} belongs to a different directory`,
    );
  }

  const privateKeyPem = await unseal(deps.env, "ACME account key", account.private_key);
  const privateKey = await importPrivateKeyPem(privateKeyPem);
  const publicJwk = parsePublicJwk(account.public_jwk, deps.environment);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const client = new AcmeClient({
    directoryUrl: deps.directoryUrl,
    accountKey: { privateKey, publicKey },
    kid: account.account_url,
    fetch: deps.fetcher,
    requestTimeoutMs: deps.timings.acmeRequestTimeoutMs,
  });
  return {
    client,
    accountUrl: account.account_url,
    thumbprint: account.thumbprint,
  };
}

async function assertPrivateKeyMatchesCertificate(
  deps: IssueDependencies,
  leaf: LeafKeyState,
  publicJwk: LeafKeyState["publicJwk"],
  fingerprint: string,
): Promise<void> {
  const artifacts = await getCertificateArtifacts(deps.db, leaf.certificateId);
  if (artifacts === null) {
    throw new NonRetryableError(`Certificate ${leaf.certificateId} has no stored private key`);
  }
  const privateKeyPem = await unseal(deps.env, "certificate private key", artifacts.private_key);
  const privateKey = await importPrivateKeyPem(privateKeyPem);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const proof = new TextEncoder().encode(`${leaf.certificateId}:${fingerprint}`);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, proof);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, proof))) {
    throw new NonRetryableError("Encrypted private key does not match the issued certificate");
  }
}

function parsePublicJwk(text: string, environment: AcmeEnvironment): {
  kty: string;
  crv: string;
  x: string;
  y: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError(`ACME account public JWK for ${environment} is not valid JSON`);
  }
  const jwk = parsed as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown };
  if (
    typeof jwk !== "object" || jwk === null ||
    jwk.kty !== "EC" || jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" || typeof jwk.y !== "string"
  ) {
    throw new TypeError(`ACME account public JWK for ${environment} is not an EC P-256 key`);
  }
  return jwk as { kty: string; crv: string; x: string; y: string };
}

function storedCertificateFromRow(row: CertificateRow): StoredCertificate {
  let sans: string[];
  try {
    const parsed: unknown = JSON.parse(row.sans_json);
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string")) {
      throw new TypeError();
    }
    sans = parsed;
  } catch {
    throw new TypeError(`Certificate ${row.id} has invalid SAN metadata`);
  }
  return {
    certificateId: row.id,
    serial: row.serial,
    fingerprintSha256: row.fingerprint_sha256,
    sans,
    notBefore: row.not_before,
    notAfter: row.not_after,
    profile: row.profile,
  };
}

function throwPermanentAcmeError(error: unknown): never {
  if (
    error instanceof AcmeError &&
    !isRetryableRateLimit(error) &&
    (error.responseStatus === 200 || (error.responseStatus >= 400 && error.responseStatus < 500))
  ) {
    throw new NonRetryableError(issueErrorMessage(error));
  }
  if (error instanceof AcmeProtocolError) throw new NonRetryableError(error.message);
  throw error;
}

/** WHY a boolean wrapper: `isRateLimited` is a type predicate; negating it
 * in the same condition would subtract the whole AcmeError type (never). */
function isRetryableRateLimit(error: AcmeError): boolean {
  return isRateLimited(error);
}

function throwPermanentCloudflareError(error: unknown): never {
  if (
    error instanceof CloudflareApiError &&
    error.status !== 429 &&
    (error.status < 500 || error.status >= 600)
  ) {
    throw new NonRetryableError(issueErrorMessage(error));
  }
  throw error;
}

function problemMessage(problem: Record<string, unknown> | undefined, fallback: string): string {
  return problem ? JSON.stringify(problem) : fallback;
}

function sameIdentifiers(actual: AcmeIdentifier[], expected: AcmeIdentifier[]): boolean {
  return sameNames(actual.map(({ value }) => value), expected.map(({ value }) => value));
}

function sameNames(actual: string[], expected: string[]): boolean {
  const actualNames = new Set(actual);
  const expectedNames = new Set(expected);
  return actualNames.size === expectedNames.size && expected.some((name) => !actualNames.has(name)) === false;
}

function assertHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NonRetryableError(`${label} is not an absolute URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new NonRetryableError(`${label} must use HTTPS`);
  }
}
