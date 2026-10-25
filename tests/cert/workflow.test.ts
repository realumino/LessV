/**
 * Workflow orchestration tests via `introspectWorkflowInstance` (the reason
 * the vitest plugin had to be upgraded for P1b): mock each step, run the
 * real instance, verify the D1 run is finalized and cleanup runs.
 *
 * The step names here pin the orchestration contract: phase steps are
 * `phase-<phase>`, order phases carry the attempt suffix (`new-order-1`),
 * and the expiry reopen emits `phase-order-expired-1` before attempt 2.
 */

import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedIssueRun, seedCertDomain } from "./support/fixtures";
import { getIssueRun } from "../../src/cert/store/d1";
import type { IssuePayload } from "../../src/cert/issue/types";

const EXPIRED_PROBLEM =
  '{"type":"urn:ietf:params:acme:error:expiredAuthorization","detail":"Authorization expired"}';

describe("CertificateWorkflow orchestration", () => {
  it("runs the durable steps and finalizes the D1 run", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId, workflowId } = await seedIssueRun(env.DB, domain.id, "manual", "production");
    const payload: IssuePayload = { runId, domainId: domain.id, environment: "production" };
    await withWorkflowInstance(workflowId, async (instance) => {
      await instance.modify(async (modifier) => {
        await mockSuccessfulRun(modifier, { domain, runId });
        await modifier.disableRetryDelays();
      });

      await env.ISSUANCE.create({ id: workflowId, params: payload });
      await instance.waitForStatus("complete");

      await expect(instance.getOutput()).resolves.toMatchObject({
        runId,
        status: "succeeded",
        certificateId: runId,
      });
      expect(await getIssueRun(env.DB, runId)).toMatchObject({
        status: "succeeded",
        phase: "complete",
      });
      await expect(instance.waitForStepResult({ name: "cleanup-txt" })).resolves.toEqual({
        deleted: 0,
      });
    });
  });

  it("still runs cleanup and marks the run failed when an issuance step errors", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId, workflowId } = await seedIssueRun(env.DB, domain.id, "manual", "production");
    const payload: IssuePayload = { runId, domainId: domain.id, environment: "production" };
    await withWorkflowInstance(workflowId, async (instance) => {
      await instance.modify(async (modifier) => {
        await mockSuccessfulRun(modifier, { domain, runId }, { skipSteps: ["await-authz-1"] });
        await modifier.mockStepError(
          { name: "await-authz-1" },
          new Error("mock authorization failure"),
        );
        await modifier.disableRetryDelays();
      });

      await env.ISSUANCE.create({ id: workflowId, params: payload });
      await instance.waitForStatus("complete");

      await expect(instance.getOutput()).resolves.toMatchObject({
        runId,
        status: "failed",
        error: "mock authorization failure",
      });
      expect(await getIssueRun(env.DB, runId)).toMatchObject({
        status: "failed",
        phase: "failed",
        error: "mock authorization failure",
      });
      await expect(instance.waitForStepResult({ name: "cleanup-txt" })).resolves.toEqual({
        deleted: 0,
      });
      // A production failure is mirrored into cert_domains.last_error.
      expect(
        await env.DB.prepare("SELECT last_error FROM cert_domains WHERE id = ?")
          .bind(domain.id)
          .first<{ last_error: string | null }>(),
      ).toMatchObject({ last_error: "mock authorization failure" });
    });
  });

  it("does not touch cert_domains.last_error for staging runs", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId, workflowId } = await seedIssueRun(env.DB, domain.id, "test", "staging");
    const payload: IssuePayload = { runId, domainId: domain.id, environment: "staging" };
    await withWorkflowInstance(workflowId, async (instance) => {
      await instance.modify(async (modifier) => {
        await mockSuccessfulRun(modifier, { domain, runId }, { skipSteps: ["await-authz-1"] });
        await modifier.mockStepError(
          { name: "await-authz-1" },
          new Error("staging failure"),
        );
        await modifier.disableRetryDelays();
      });

      await env.ISSUANCE.create({ id: workflowId, params: payload });
      await instance.waitForStatus("complete");

      await expect(instance.getOutput()).resolves.toMatchObject({ status: "failed" });
      expect(
        await env.DB.prepare("SELECT last_error FROM cert_domains WHERE id = ?")
          .bind(domain.id)
          .first<{ last_error: string | null }>(),
      ).toMatchObject({ last_error: null });
      expect(await getIssueRun(env.DB, runId)).toMatchObject({
        status: "failed",
        error: "staging failure",
      });
    });
  });

  it("reopens the order once when the CA reports it expired", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId, workflowId } = await seedIssueRun(env.DB, domain.id, "manual", "production");
    const payload: IssuePayload = { runId, domainId: domain.id, environment: "production" };
    await withWorkflowInstance(workflowId, async (instance) => {
      await instance.modify(async (modifier) => {
        await mockSuccessfulRun(modifier, { domain, runId }, { skipSteps: ["await-authz-1"] });
        // Attempt 1 fails at await-authz with a step-wrapped expired problem;
        // attempt 2 succeeds end to end.
        await modifier.mockStepError({ name: "await-authz-1" }, new Error(EXPIRED_PROBLEM));
        await modifier.disableRetryDelays();
      });

      await env.ISSUANCE.create({ id: workflowId, params: payload });
      await instance.waitForStatus("complete");

      await expect(instance.getOutput()).resolves.toMatchObject({ status: "succeeded" });
      const run = await getIssueRun(env.DB, runId);
      expect(run).toMatchObject({ status: "succeeded" });
      const phases = phasesOf(run?.steps_json);
      expect(phases).toContain("new-order-1");
      expect(phases).toContain("order-expired-1");
      expect(phases).toContain("new-order-2");
    });
  });

  it("fails the run when the order expires a second time", async () => {
    const domain = await seedCertDomain(env.DB);
    const { runId, workflowId } = await seedIssueRun(env.DB, domain.id, "manual", "production");
    const payload: IssuePayload = { runId, domainId: domain.id, environment: "production" };
    await withWorkflowInstance(workflowId, async (instance) => {
      await instance.modify(async (modifier) => {
        // Attempt 1 fails with an expired problem (reopens the order); attempt 2
        // fails the same way, which must fail the run — no third order.
        await mockSuccessfulRun(
          modifier,
          { domain, runId },
          { skipSteps: ["await-authz-1", "await-authz-2"] },
        );
        await modifier.mockStepError({ name: "await-authz-1" }, new Error(EXPIRED_PROBLEM));
        await modifier.mockStepError({ name: "await-authz-2" }, new Error(EXPIRED_PROBLEM));
        await modifier.disableRetryDelays();
      });

      await env.ISSUANCE.create({ id: workflowId, params: payload });
      await instance.waitForStatus("complete");

      await expect(instance.getOutput()).resolves.toMatchObject({ status: "failed" });
      const run = await getIssueRun(env.DB, runId);
      expect(run).toMatchObject({ status: "failed" });
      const phases = phasesOf(run?.steps_json);
      expect(phases.filter((phase) => phase === "order-expired-1")).toHaveLength(1);
      expect(phases).not.toContain("new-order-3");
    });
  });
});

function phasesOf(stepsJson: string | null | undefined): string[] {
  return (JSON.parse(stepsJson ?? "[]") as Array<{ phase: string }>).map(({ phase }) => phase);
}

type WorkflowInstanceInspector = Awaited<ReturnType<typeof introspectWorkflowInstance>>;
type WorkflowModifier = Parameters<Parameters<WorkflowInstanceInspector["modify"]>[0]>[0];

async function mockSuccessfulRun(
  modifier: WorkflowModifier,
  context: { domain: { name: string }; runId: string },
  options: { skipSteps?: string[] } = {},
): Promise<void> {
  const { domain, runId } = context;
  const order = (attempt: number) => ({
    orderUrl: `https://acme.example/order/${attempt}`,
    authorizations: [`https://acme.example/authz/${attempt}`],
    profile: "tlsserver",
  });
  const noop = { authorizations: [], targets: [] };

  await modifier.mockStepResult({ name: "load" }, {
    domain,
    identifiers: [
      { type: "dns", value: domain.name },
      { type: "dns", value: `*.${domain.name}` },
    ],
    previousCertificate: null,
  });
  await modifier.mockStepResult({ name: "ensure-account" }, {
    environment: "production",
    accountUrl: "https://acme.example/account/1",
    thumbprint: "thumbprint",
  });
  for (const attempt of [1, 2]) {
    await modifier.mockStepResult({ name: `new-order-${attempt}` }, order(attempt));
    await modifier.mockStepResult({ name: `publish-txt-${attempt}` }, noop);
    await modifier.mockStepResult({ name: `wait-propagation-${attempt}` }, { mocked: true });
    await modifier.mockStepResult({ name: `accept-challenges-${attempt}` }, { mocked: true });
    const authzName = `await-authz-${attempt}`;
    // The failing step gets its error registered by the caller, and the
    // introspector forbids mocking a result for it as well.
    if (!options.skipSteps?.includes(authzName)) {
      await modifier.mockStepResult({ name: authzName }, { mocked: true });
    }
  }
  await modifier.mockStepResult({ name: "key+csr" }, {
    certificateId: runId,
    r2Prefix: `certs/production/${domain.name}/${runId}`,
    csrB64u: "AQ",
    publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
  });
  await modifier.mockStepResult({ name: "finalize+store" }, {
    certificateId: runId,
    r2Prefix: `certs/production/${domain.name}/${runId}`,
    serial: "serial",
    fingerprintSha256: "a".repeat(64),
    sans: [domain.name, `*.${domain.name}`],
    notBefore: new Date().toISOString(),
    notAfter: new Date(Date.now() + 90 * 24 * 60 * 60_000).toISOString(),
    profile: "tlsserver",
  });
}

async function withWorkflowInstance<T>(
  workflowId: string,
  callback: (instance: WorkflowInstanceInspector) => Promise<T>,
): Promise<T> {
  const instance = await introspectWorkflowInstance(env.ISSUANCE, workflowId);
  try {
    return await callback(instance);
  } finally {
    await instance.dispose();
  }
}
