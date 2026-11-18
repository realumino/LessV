/**
 * Sweeper tests, adapted from certworker's sweeper.spec.ts: production
 * purge with row retention, staging row deletion, orphaned artifacts, stale
 * TXT cleanup, 30-day run retention.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  sweep,
  sweepStaleChallengeRecords,
  sweepUnpurgedCertificates,
  sweepStagingCertificates,
  sweepOrphanedArtifacts,
  sweepOldRuns,
  ORPHANED_ARTIFACTS_MS,
  type SweeperDependencies,
} from "../../src/cert/issue/sweeper";
import { createTxtRecord } from "../../src/cert/dns/cloudflare";
import {
  getCertificate,
  getCertificateArtifacts,
  getCertDomain,
  insertChallengeRecord,
  listPendingChallengeRecords,
  putCertificatePrivateKey,
} from "../../src/cert/store/d1";
import { createScriptedFetch } from "./support/fake-fetch";
import { MockCloudflareDns } from "./support/mock-dns";
import { seedActiveDnsCredential, seedCertificate, seedCertDomain, seedIssueRun } from "./support/fixtures";

const NOW = new Date("2026-01-02T00:00:00.000Z");

function makeSetup() {
  const dns = new MockCloudflareDns();
  const { fetch } = createScriptedFetch(async (request) => {
    const response = await dns.handle(request);
    if (response) return response;
    throw new Error(`No offline mock for ${request.request.method} ${request.url.href}`);
  });
  return { dns, fetch };
}

function sweeperDeps(fetcher: typeof fetch): SweeperDependencies {
  // The env carries DB and KEY_SECRET; the DNS calls are intercepted by the
  // mock, so which token the reader unseals does not matter here — only that
  // an active row exists, because there is no env fallback.
  return { db: env.DB, env, fetcher, now: () => NOW };
}

describe("production certificate sweeper", () => {
  it("purges superseded artifacts and leaves current rows alone", async () => {
    const domain = await seedCertDomain(env.DB, { name: "sweep-certs.example.com" });
    const current = await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: true,
    });
    const superseded = await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: false,
    });
    // Already-purged rows are not listed again.
    await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: false,
      purgedAt: "2025-12-01T00:00:00.000Z",
      storeArtifacts: false,
    });

    await expect(
      sweepUnpurgedCertificates(sweeperDeps(makeSetup().fetch)),
    ).resolves.toEqual({ purged: 1, failed: 0 });
    expect(await getCertificateArtifacts(env.DB, superseded.id)).toBeNull();
    expect(await getCertificateArtifacts(env.DB, current.id)).toMatchObject({
      cert_pem: expect.any(String),
      fullchain_pem: expect.any(String),
    });
    await expect(getCertificate(env.DB, superseded.id)).resolves.toMatchObject({
      purged_at: expect.any(String),
      is_current: 0,
    });
    // The D1 row survives (production history).
    await expect(getCertificate(env.DB, superseded.id)).resolves.not.toBeNull();
    await expect(getCertificate(env.DB, current.id)).resolves.toMatchObject({
      purged_at: null,
      is_current: 1,
    });
  });
});

describe("staging certificate sweeper", () => {
  it("deletes non-current staging rows and keeps young staging currents", async () => {
    const domain = await seedCertDomain(env.DB, { name: "sweep-staging.example.com" });
    const young = await seedCertificate(env.DB, domain.id, {
      environment: "staging",
      current: true,
      createdAt: "2026-01-01T00:00:00.000Z", // 1 day old — keep
    });
    const oldCurrent = await seedCertificate(env.DB, domain.id, {
      environment: "staging",
      current: false,
      createdAt: "2025-12-01T00:00:00.000Z", // over 7 days
    });
    const oldNonCurrent = await seedCertificate(env.DB, domain.id, {
      environment: "staging",
      current: false,
      createdAt: "2026-01-01T12:00:00.000Z",
    });

    await expect(sweepStagingCertificates(sweeperDeps(makeSetup().fetch))).resolves.toEqual({
      deleted: 2,
      failed: 0,
    });
    expect(await getCertificate(env.DB, young.id)).not.toBeNull();
    expect(await getCertificate(env.DB, oldCurrent.id)).toBeNull();
    expect(await getCertificate(env.DB, oldNonCurrent.id)).toBeNull();
    expect(await getCertificateArtifacts(env.DB, oldCurrent.id)).toBeNull();
  });

  it("skips staging currents for domains with an active run", async () => {
    const domain = await seedCertDomain(env.DB, { name: "sweep-active.example.com" });
    const { runId } = await seedIssueRun(env.DB, domain.id, "test", "staging");
    await seedCertificate(env.DB, domain.id, {
      environment: "staging",
      current: true,
      createdAt: "2025-12-01T00:00:00.000Z",
    });

    await expect(sweepStagingCertificates(sweeperDeps(makeSetup().fetch))).resolves.toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(await listPendingChallengeRecords(env.DB, runId)).toEqual([]);
  });
});

describe("orphaned artifact sweeper", () => {
  it("deletes rows no certificate claimed once they are a week old", async () => {
    const stale = crypto.randomUUID();
    const fresh = crypto.randomUUID();
    await putCertificatePrivateKey(env.DB, stale, "v1:stale", 0);
    await putCertificatePrivateKey(
      env.DB,
      fresh,
      "v1:fresh",
      Math.floor((NOW.getTime() - ORPHANED_ARTIFACTS_MS / 2) / 1000),
    );

    await expect(sweepOrphanedArtifacts(sweeperDeps(makeSetup().fetch))).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(await getCertificateArtifacts(env.DB, stale)).toBeNull();
    expect(await getCertificateArtifacts(env.DB, fresh)).not.toBeNull();
  });
});

describe("stale challenge-record sweeper", () => {
  async function seedChallengeRow(
    domain: { zone_id: string },
    runId: string,
    recordId: string,
    name: string,
    createdAt: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertChallengeRecord(env.DB, {
      id,
      run_id: runId,
      zone_id: domain.zone_id,
      cf_record_id: recordId,
      name,
      value: `value-for-${name}`,
    });
    await env.DB.prepare("UPDATE challenge_records SET created_at = ? WHERE id = ?")
      .bind(createdAt, id)
      .run();
    return id;
  }

  it("leaves every record alone when no credential is active", async () => {
    const { dns, fetch } = makeSetup();
    const domain = await seedCertDomain(env.DB, { name: "sweep-nocred.example.com" });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const recordId = await seedChallengeRow(
      domain,
      runId,
      "kept-record-id",
      "_acme-challenge.kept.example.com",
      new Date(NOW.getTime() - 48 * 3600_000).toISOString(),
    );

    await expect(sweepStaleChallengeRecords(sweeperDeps(fetch))).resolves.toEqual({
      deleted: 0,
      failed: 1,
    });
    // WHY nothing was attempted: the record still exists at the provider and
    // in the table, because a missing credential is a configuration fact, not
    // a per-record Cloudflare failure.
    expect(dns.records).toEqual([]);
    const row = await env.DB.prepare("SELECT deleted_at FROM challenge_records WHERE id = ?")
      .bind(recordId)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeNull();
    // WHY the row is removed again: sibling tests sweep every stale record in
    // the table, so a fixture left behind would be swept by the next one.
    await env.DB.prepare("DELETE FROM challenge_records WHERE id = ?")
      .bind(recordId)
      .run();
  });

  it("deletes records older than 24h and marks them, keeping fresh ones", async () => {
    await seedActiveDnsCredential(env.DB);
    const { dns, fetch } = makeSetup();
    const domain = await seedCertDomain(env.DB, { name: "sweep-txt.example.com" });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const staleId = await createTxtRecord({
      apiToken: "test-token",
      zoneId: domain.zone_id,
      name: `_acme-challenge.stale.example.com`,
      value: "stale",
      fetch,
    });
    const freshId = await createTxtRecord({
      apiToken: "test-token",
      zoneId: domain.zone_id,
      name: `_acme-challenge.fresh.example.com`,
      value: "fresh",
      fetch,
    });
    await seedChallengeRow(
      domain,
      runId,
      staleId,
      "_acme-challenge.stale.example.com",
      new Date(NOW.getTime() - 25 * 3600_000).toISOString(),
    );
    await seedChallengeRow(
      domain,
      runId,
      freshId,
      "_acme-challenge.fresh.example.com",
      new Date(NOW.getTime() - 1 * 3600_000).toISOString(),
    );

    await expect(sweepStaleChallengeRecords(sweeperDeps(fetch))).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(dns.records.map(({ id }) => id)).toEqual([freshId]);
    expect(await listPendingChallengeRecords(env.DB, runId)).toHaveLength(1);
  });

  it("counts a 404 from the DNS API as deleted", async () => {
    await seedActiveDnsCredential(env.DB);
    const { fetch } = makeSetup();
    const domain = await seedCertDomain(env.DB, { name: "sweep-gone.example.com" });
    const { runId } = await seedIssueRun(env.DB, domain.id);
    const rowId = await seedChallengeRow(
      domain,
      runId,
      "gone-record-id",
      "_acme-challenge.gone.example.com",
      new Date(NOW.getTime() - 48 * 3600_000).toISOString(),
    );

    await expect(sweepStaleChallengeRecords(sweeperDeps(fetch))).resolves.toEqual({
      deleted: 1,
      failed: 0,
    });
    const pending = await env.DB.prepare("SELECT deleted_at FROM challenge_records WHERE id = ?")
      .bind(rowId)
      .first<{ deleted_at: string | null }>();
    expect(pending?.deleted_at).not.toBeNull();
  });
});

describe("run retention", () => {
  it("deletes finished runs older than 30 days with their challenge rows", async () => {
    const domain = await seedCertDomain(env.DB, { name: "sweep-runs.example.com" });
    const old = await seedIssueRun(env.DB, domain.id, "manual", "production");
    await insertChallengeRecord(env.DB, {
      id: crypto.randomUUID(),
      run_id: old.runId,
      zone_id: domain.zone_id,
      cf_record_id: "gone",
      name: "_acme-challenge.sweep-runs.example.com",
      value: "v",
    });
    await env.DB.prepare(
      "UPDATE issue_runs SET status = 'failed', finished_at = ? WHERE id = ?",
    ).bind("2025-11-01T00:00:00.000Z", old.runId).run();

    const fresh = await seedIssueRun(env.DB, domain.id, "manual", "production");
    await env.DB.prepare(
      "UPDATE issue_runs SET status = 'succeeded', finished_at = ? WHERE id = ?",
    ).bind("2025-12-20T00:00:00.000Z", fresh.runId).run();

    await expect(sweepOldRuns(sweeperDeps(makeSetup().fetch))).resolves.toEqual({
      deleted: 1,
    });
    expect(await getIssueRunSafe(old.runId)).toBeNull();
    expect(await getIssueRunSafe(fresh.runId)).not.toBeNull();
  });
});

describe("combined sweep", () => {
  it("runs every pass and aggregates the counts", async () => {
    const domain = await seedCertDomain(env.DB, { name: "sweep-all.example.com" });
    await seedCertificate(env.DB, domain.id, {
      environment: "production",
      current: false,
    });
    const { fetch } = makeSetup();

    const result = await sweep(sweeperDeps(fetch));
    expect(result).toMatchObject({
      certificatesPurged: 1,
      certificateFailures: 0,
      orphanedArtifactsDeleted: 0,
      orphanFailures: 0,
      challengesDeleted: 0,
      challengeFailures: 0,
    });
    // Sanity: the domain row was only a fixture target.
    expect(await getCertDomain(env.DB, domain.id)).not.toBeNull();
  });
});

async function getIssueRunSafe(id: string) {
  return env.DB.prepare("SELECT * FROM issue_runs WHERE id = ?").bind(id).first();
}
