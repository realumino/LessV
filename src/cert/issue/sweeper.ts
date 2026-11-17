/**
 * Daily-cron cleanup for state the normal pipeline could not finish:
 *
 * - production non-current certificates whose artifacts still exist
 *   (purge-previous is best-effort) → delete them, mark purged, keep the row;
 * - staging non-current certificates → delete artifacts and rows;
 * - staging current certificates older than 7 days → delete artifacts and rows
 *   (skipped while a run is active for the domain);
 * - artifacts rows no certificate ever claimed (a run that died between
 *   the key write and the activation) → delete the row;
 * - `_acme-challenge` TXT records a crashed workflow never deleted (24 h);
 * - finished issue runs older than 30 days (and their challenge rows).
 *
 * Every item is attempted; one failure never blocks the rest or throws.
 */

import { deleteTxtRecord } from "../dns/cloudflare";
import { activeDnsToken, NO_DNS_CREDENTIAL_ERROR } from "../credentials";
import {
  deleteCertificateArtifacts,
  deleteStagingCertificate,
  findActiveIssueRun,
  listOldFinishedRuns,
  listOrphanedArtifacts,
  listStaleChallengeRecords,
  listUnpurgedProductionCertificates,
  listExpiredStagingCertificates,
  markChallengeRecordDeleted,
  markCertificatePurged,
} from "../store/d1";

export interface SweeperDependencies {
  db: D1Database;
  /**
   * WHAT: the env slice the credential reader needs.
   *
   * WHY no threaded token: the credential is runtime state; the sweeper
   * resolves what is in force when it runs, and a missing credential is
   * the named "no DNS credential configured" event, not a Cloudflare 401
   * per record.
   */
  env: Env;
  fetcher: typeof fetch;
  now: () => Date;
}

export interface SweepResult {
  certificatesPurged: number;
  certificateFailures: number;
  stagingCertificatesDeleted: number;
  stagingFailures: number;
  orphanedArtifactsDeleted: number;
  orphanFailures: number;
  challengesDeleted: number;
  challengeFailures: number;
  runsDeleted: number;
}

/** Challenge TXT records younger than this are the live workflow's business. */
export const STALE_CHALLENGE_MS = 24 * 60 * 60 * 1000;

/** How long a staging current certificate may exist before it is swept. */
export const STAGING_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** Finished-run retention. */
export const RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long an unclaimed artifacts row is left alone.
 *
 * WHY days and not minutes: a live issuance writes the key before it writes
 * the certificate, so the row is an orphan for one run's duration. The
 * sweeper only has to outlast a run that died, and an abandoned row costs
 * a few kilobytes.
 */
export const ORPHANED_ARTIFACTS_MS = 7 * 24 * 60 * 60 * 1000;

export async function sweep(deps: SweeperDependencies): Promise<SweepResult> {
  const production = await sweepUnpurgedCertificates(deps);
  const staging = await sweepStagingCertificates(deps);
  const orphans = await sweepOrphanedArtifacts(deps);
  const challenges = await sweepStaleChallengeRecords(deps);
  const runs = await sweepOldRuns(deps);
  return {
    certificatesPurged: production.purged,
    certificateFailures: production.failed,
    stagingCertificatesDeleted: staging.deleted,
    stagingFailures: staging.failed,
    orphanedArtifactsDeleted: orphans.deleted,
    orphanFailures: orphans.failed,
    challengesDeleted: challenges.deleted,
    challengeFailures: challenges.failed,
    runsDeleted: runs.deleted,
  };
}

/** Production only: superseded artifacts that still exist. */
export async function sweepUnpurgedCertificates(
  deps: SweeperDependencies,
): Promise<{ purged: number; failed: number }> {
  const rows = await listUnpurgedProductionCertificates(deps.db);
  let purged = 0;
  let failed = 0;

  for (const certificate of rows) {
    try {
      await deleteCertificateArtifacts(deps.db, certificate.id);
      await markCertificatePurged(deps.db, certificate.id);
      purged += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.certificate_failed",
        certificateId: certificate.id,
        error: errorMessage(error),
      }));
    }
  }

  return { purged, failed };
}

export async function sweepStagingCertificates(
  deps: SweeperDependencies,
): Promise<{ deleted: number; failed: number }> {
  const now = deps.now();
  const cutoff = new Date(now.getTime() - STAGING_KEEP_MS).toISOString();
  const expired = await listExpiredStagingCertificates(deps.db, cutoff);
  let deleted = 0;
  let failed = 0;

  for (const certificate of expired) {
    try {
      // A live run for the same domain may be re-using the challenge or the
      // certificate id; leave this current to the next pass.
      if (await findActiveIssueRun(deps.db, certificate.domain_id)) continue;
      await deleteCertificateArtifacts(deps.db, certificate.id);
      await deleteStagingCertificate(deps.db, certificate.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.staging_certificate_failed",
        certificateId: certificate.id,
        error: errorMessage(error),
      }));
    }
  }

  return { deleted, failed };
}

export async function sweepOrphanedArtifacts(
  deps: SweeperDependencies,
): Promise<{ deleted: number; failed: number }> {
  const cutoff = Math.floor((deps.now().getTime() - ORPHANED_ARTIFACTS_MS) / 1000);
  let deleted = 0;
  let failed = 0;

  for (const certificateId of await listOrphanedArtifacts(deps.db, cutoff)) {
    try {
      await deleteCertificateArtifacts(deps.db, certificateId);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.orphaned_artifacts_failed",
        certificateId,
        error: errorMessage(error),
      }));
    }
  }

  return { deleted, failed };
}

export async function sweepStaleChallengeRecords(
  deps: SweeperDependencies,
): Promise<{ deleted: number; failed: number }> {
  const cutoff = new Date(deps.now().getTime() - STALE_CHALLENGE_MS).toISOString();
  const rows = await listStaleChallengeRecords(deps.db, cutoff);
  let deleted = 0;
  let failed = 0;

  // WHY resolved once, at the top: the loop's per-record failures stay
  // Cloudflare-shaped; a missing credential is a configuration fact that
  // would turn every record into the same 401. Absent rows fail as named
  // events and the next cron run retries them.
  let apiToken: string;
  try {
    apiToken = await activeDnsToken(deps.env);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== NO_DNS_CREDENTIAL_ERROR) {
      throw error;
    }
    console.warn(JSON.stringify({
      event: "sweeper.no_dns_credential",
      staleChallenges: rows.length,
      error: error.message,
    }));
    return { deleted: 0, failed: rows.length };
  }

  for (const record of rows) {
    try {
      // The Cloudflare API answers 404 for an already-gone record; that counts as deleted.
      await deleteTxtRecord({
        apiToken,
        zoneId: record.zone_id,
        recordId: record.cf_record_id,
        fetch: deps.fetcher,
      });
      await markChallengeRecordDeleted(deps.db, record.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.challenge_failed",
        recordId: record.id,
        cfRecordId: record.cf_record_id,
        error: errorMessage(error),
      }));
    }
  }

  return { deleted, failed };
}

export async function sweepOldRuns(
  deps: SweeperDependencies,
): Promise<{ deleted: number }> {
  const cutoff = new Date(deps.now().getTime() - RUN_RETENTION_MS).toISOString();
  const rows = await listOldFinishedRuns(deps.db, cutoff, 200);
  let deleted = 0;

  for (const run of rows) {
    try {
      await deps.db.batch([
        deps.db.prepare("DELETE FROM challenge_records WHERE run_id = ?").bind(run.id),
        deps.db.prepare("DELETE FROM issue_runs WHERE id = ?").bind(run.id),
      ]);
      deleted += 1;
    } catch (error) {
      console.warn(JSON.stringify({
        event: "sweeper.run_delete_failed",
        runId: run.id,
        error: errorMessage(error),
      }));
    }
  }

  return { deleted };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
