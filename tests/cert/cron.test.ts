/**
 * Cron tests, adapted from certworker's cron.spec.ts: due-domain selection
 * with the 1/3-lifetime window, date-scoped idempotency, active-run
 * skipping, per-domain failures, and the production-only rule.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runCron } from "../../src/cert/issue/cron";
import { listDueDomains } from "../../src/cert/issue/renewal_window";
import { getIssueRun, listRenewalCandidates, listIssueRuns } from "../../src/cert/store/d1";
import type { IssueWorkflowCreator } from "../../src/cert/issue/trigger";
import type { IssuePayload } from "../../src/cert/issue/types";
import { seedCertificate, seedCertDomain, seedIssueRun } from "./support/fixtures";

const NOW = new Date("2026-03-01T03:17:00.000Z");
const isoInDays = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 3600_000).toISOString();

/** Fails the whole test if anything tries to make an outbound request. */
const unusedFetcher = (() => {
  throw new Error("unexpected outbound request during cron test");
}) as typeof fetch;

function fakeIssuance(failWorkflowFor: (workflowId: string) => boolean = () => false) {
  const created: Array<{ id: string; params: IssuePayload }> = [];
  const issuance: IssueWorkflowCreator = {
    async create(options: { id: string; params: IssuePayload }): Promise<unknown> {
      if (failWorkflowFor(options.id)) throw new Error("workflow binding unavailable");
      created.push(options);
      return { id: options.id };
    },
  };
  return { created, issuance };
}

function cronOptions(issuance: IssueWorkflowCreator) {
  return { issuance, now: NOW, jitterMs: 0, fetcher: unusedFetcher };
}

describe("due-domain selection", () => {
  it("picks domains without a current certificate or inside their renewal window", async () => {
    const far = await seedCertDomain(env.DB, { name: "far.example.com" });
    await seedCertificate(env.DB, far.id, {
      environment: "production",
      notAfter: isoInDays(90),
      notBefore: isoInDays(135), // 45-day tlsserver lifetime
    });

    const soon = await seedCertDomain(env.DB, { name: "soon.example.com" });
    await seedCertificate(env.DB, soon.id, {
      environment: "production",
      notAfter: isoInDays(20),
      notBefore: isoInDays(-25),
    });

    await seedCertDomain(env.DB, { name: "missing.example.com" });

    const paused = await seedCertDomain(env.DB, { name: "paused.example.com", status: "paused" });
    await seedCertificate(env.DB, paused.id, {
      environment: "production",
      notAfter: isoInDays(1),
    });

    const deleted = await seedCertDomain(env.DB, { name: "deleted.example.com", status: "deleted" });
    await seedCertificate(env.DB, deleted.id, {
      environment: "production",
      notAfter: isoInDays(1),
    });

    const custom = await seedCertDomain(env.DB, {
      name: "custom.example.com",
      renewBeforeDays: 7,
    });
    await seedCertificate(env.DB, custom.id, {
      environment: "production",
      notAfter: isoInDays(10),
      notBefore: isoInDays(-35),
    });

    // Staging current only: cron is production-only and must not see it.
    const stagingOnly = await seedCertDomain(env.DB, { name: "staging-only.example.com" });
    await seedCertificate(env.DB, stagingOnly.id, {
      environment: "staging",
      notAfter: isoInDays(1),
    });

    const due = listDueDomains(await listRenewalCandidates(env.DB), NOW);
    expect(due.map(({ name }) => name).sort()).toEqual([
      "missing.example.com",
      "soon.example.com",
      "staging-only.example.com",
    ]);
  });
});

describe("daily renewal trigger", () => {
  it("creates date-scoped cron runs and is idempotent within the day", async () => {
    const domain = await seedCertDomain(env.DB, { name: "renew.example.com" });
    const { created, issuance } = fakeIssuance();

    const first = await runCron(env, cronOptions(issuance));
    expect(first.date).toBe("2026-03-01");
    expect(first.started).toContain(domain.id);

    const domainCreations = created.filter(({ params }) => params.domainId === domain.id);
    expect(domainCreations).toEqual([{
      id: `renew-${domain.id}-2026-03-01`,
      params: {
        runId: expect.any(String),
        domainId: domain.id,
        environment: "production",
      },
    }]);

    const runs = await listIssueRuns(env.DB, { domainId: domain.id, limit: 10, offset: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      trigger: "renew",
      environment: "production",
      status: "queued",
      workflow_id: `renew-${domain.id}-2026-03-01`,
    });

    // Same-day repeat: everything already has its workflow for this date.
    const second = await runCron(env, cronOptions(issuance));
    expect(second.date).toBe("2026-03-01");
    expect(second.started).toEqual([]);
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.skipped.every(({ reason }) => reason === "already_started")).toBe(true);
    expect(created.filter(({ params }) => params.domainId === domain.id)).toHaveLength(1);
  });

  it("skips domains that already have an active run", async () => {
    const domain = await seedCertDomain(env.DB, { name: "busy.example.com" });
    const { runId } = await seedIssueRun(env.DB, domain.id, "manual", "production");
    const { issuance } = fakeIssuance();

    const outcome = await runCron(env, cronOptions(issuance));
    expect(outcome.skipped).toContainEqual({ domainId: domain.id, reason: "already_running" });
    const runs = await listIssueRuns(env.DB, { domainId: domain.id, limit: 10, offset: 0 });
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runId);
  });

  it("records per-domain failures without blocking the others", async () => {
    const broken = await seedCertDomain(env.DB, { name: "broken.example.com" });
    const working = await seedCertDomain(env.DB, { name: "working.example.com" });
    const { issuance } = fakeIssuance(
      (workflowId) => workflowId.startsWith(`renew-${broken.id}-`),
    );

    const outcome = await runCron(env, cronOptions(issuance));
    expect(outcome.started).toContain(working.id);
    expect(outcome.skipped).toContainEqual({ domainId: broken.id, reason: "workflow_create_failed" });

    const brokenRuns = await listIssueRuns(env.DB, { domainId: broken.id, limit: 10, offset: 0 });
    expect(brokenRuns).toHaveLength(1);
    await expect(getIssueRun(env.DB, brokenRuns[0].id)).resolves.toMatchObject({
      status: "failed",
      error: "workflow binding unavailable",
    });

    // Same-day retries do not recreate the workflow behind a recorded run row.
    const retry = await runCron(env, cronOptions(issuance));
    expect(retry.started).not.toContain(working.id);
    expect(retry.skipped).toContainEqual({ domainId: broken.id, reason: "already_started" });
  });
});
