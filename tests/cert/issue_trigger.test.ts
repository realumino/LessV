import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getIssueRun } from "../../src/cert/store/d1";
import {
  ActiveIssueRunError,
  IssueDomainNotActiveError,
  IssueDomainNotFoundError,
  startIssueRun,
} from "../../src/cert/issue/trigger";
import type { IssuePayload } from "../../src/cert/issue/types";
import { seedCertDomain } from "./support/fixtures";

describe("issue trigger", () => {
  it("inserts a queued run before creating the workflow with a stable id", async () => {
    const domain = await seedCertDomain(env.DB);
    const created: Array<{ id: string; params: IssuePayload }> = [];
    const workflow = {
      async create(options: { id: string; params: IssuePayload }): Promise<unknown> {
        created.push(options);
        return { id: options.id };
      },
    };

    const started = await startIssueRun(env.DB, workflow, domain.id, {
      environment: "production",
      trigger: "manual",
    });

    expect(started.workflowId).toBe(`manual-${started.runId}`);
    expect(created).toEqual([{
      id: started.workflowId,
      params: { runId: started.runId, domainId: domain.id, environment: "production" },
    }]);
    expect(await getIssueRun(env.DB, started.runId)).toMatchObject({
      domain_id: domain.id,
      environment: "production",
      workflow_id: started.workflowId,
      trigger: "manual",
      status: "queued",
    });
  });

  it("rejects missing, inactive, and already-running domains", async () => {
    const workflow = { async create(): Promise<unknown> { return {}; } };
    await expect(
      startIssueRun(env.DB, workflow, crypto.randomUUID(), {
        environment: "production",
        trigger: "manual",
      }),
    ).rejects.toBeInstanceOf(IssueDomainNotFoundError);

    const paused = await seedCertDomain(env.DB, { status: "paused" });
    await expect(
      startIssueRun(env.DB, workflow, paused.id, { environment: "production", trigger: "manual" }),
    ).rejects.toBeInstanceOf(IssueDomainNotActiveError);

    const active = await seedCertDomain(env.DB);
    const first = await startIssueRun(env.DB, workflow, active.id, {
      environment: "staging",
      trigger: "test",
    });
    expect(first.workflowId).toBe(`test-${first.runId}`);
    await expect(
      startIssueRun(env.DB, workflow, active.id, { environment: "production", trigger: "manual" }),
    ).rejects.toBeInstanceOf(ActiveIssueRunError);
  });

  it("marks the D1 run failed if workflow creation fails", async () => {
    const domain = await seedCertDomain(env.DB);
    const workflow = {
      async create(): Promise<unknown> {
        throw new Error("workflow binding unavailable");
      },
    };

    await expect(
      startIssueRun(env.DB, workflow, domain.id, { environment: "production", trigger: "manual" }),
    ).rejects.toThrow("workflow binding unavailable");
    const { results } = await env.DB.prepare(
      "SELECT id FROM issue_runs WHERE domain_id = ?",
    ).bind(domain.id).all<{ id: string }>();
    const run = await getIssueRun(env.DB, results[0].id);
    expect(run).toMatchObject({ status: "failed", error: "workflow binding unavailable" });
  });
});
