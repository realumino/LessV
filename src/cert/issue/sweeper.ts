/**
 * Daily-cron cleanup for state the normal pipeline could not finish
 * (P1B-PLAN.md §3.3):
 *
 * - production non-current certificates whose R2 objects still exist
 *   (purge-previous is best-effort) → delete objects, mark purged, keep the row;
 * - staging non-current certificates → delete objects and rows;
 * - staging current certificates older than 7 days → delete objects and rows
 *   (skipped while a run is active for the domain);
 * - `_acme-challenge` TXT records a crashed workflow never deleted (24 h);
 * - finished issue runs older than 30 days (and their challenge rows).
 *
 * Every item is attempted; one failure never blocks the rest or throws.
 */

import { deleteTxtRecord } from "../dns/cloudflare";
import {
  deleteStagingCertificate,
  findActiveIssueRun,
  listOldFinishedRuns,
  listStaleChallengeRecords,
  listUnpurgedProductionCertificates,
  listExpiredStagingCertificates,
  markChallengeRecordDeleted,
  markCertificatePurged,
} from "../store/d1";
import { deletePrefix } from "../store/r2";

export interface SweeperDependencies {
  db: D1Database;
  bucket: R2Bucket;
  dnsApiToken: string;
  fetcher: typeof fetch;
  now: () => Date;
}

export interface SweepResult {
  certificatesPurged: number;
  certificateFailures: number;
  stagingCertificatesDeleted: number;
  stagingFailures: number;
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

export async function sweep(deps: SweeperDependencies): Promise<SweepResult> {
  const production = await sweepUnpurgedCertificates(deps);
  const staging = await sweepStagingCertificates(deps);
  const challenges = await sweepStaleChallengeRecords(deps);
  const runs = await sweepOldRuns(deps);
  return {
    certificatesPurged: production.purged,
    certificateFailures: production.failed,
    stagingCertificatesDeleted: staging.deleted,
    stagingFailures: staging.failed,
    challengesDeleted: challenges.deleted,
    challengeFailures: challenges.failed,
    runsDeleted: runs.deleted,
  };
}

/** Production only: superseded prefixes whose R2 objects still exist. */
export async function sweepUnpurgedCertificates(
  deps: SweeperDependencies,
): Promise<{ purged: number; failed: number }> {
  const rows = await listUnpurgedProductionCertificates(deps.db);
  let purged = 0;
  let failed = 0;

  for (const certificate of rows) {
    try {
      await deletePrefix(deps.bucket, certificate.r2_prefix);
      await markCertificatePurged(deps.db, certificate.id);
      purged += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.certificate_failed",
        certificateId: certificate.id,
        r2Prefix: certificate.r2_prefix,
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
      // R2 prefix bookkeeping; leave this current to the next pass.
      if (await findActiveIssueRun(deps.db, certificate.domain_id)) continue;
      await deletePrefix(deps.bucket, certificate.r2_prefix);
      await deleteStagingCertificate(deps.db, certificate.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.warn(JSON.stringify({
        event: "sweeper.staging_certificate_failed",
        certificateId: certificate.id,
        r2Prefix: certificate.r2_prefix,
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

  for (const record of rows) {
    try {
      // The Cloudflare API answers 404 for an already-gone record; that counts as deleted.
      await deleteTxtRecord({
        apiToken: deps.dnsApiToken,
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
