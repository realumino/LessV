/**
 * Run creation: validate the domain, insert the run row (the active-run
 * index rejects a second), then ask the Workflow binding to create the
 * instance. Ported from certworker's trigger.ts with the environment
 * dimension added — the payload carries it, and the workflow id keeps the
 * plan's per-trigger shapes (`manual-<runId>`, `test-<runId>`,
 * `renew-<domainId>-<date>` from the cron).
 */

import {
  ActiveIssueRunError,
  createIssueRun,
  finishIssueRun,
  getCertDomain,
} from "../store/d1";
import type { AcmeEnvironment, IssuePayload, IssueTrigger } from "./types";

export interface IssueWorkflowCreator {
  create(options: { id: string; params: IssuePayload }): Promise<unknown>;
}

export interface StartIssueRunOptions {
  environment: AcmeEnvironment;
  trigger: IssueTrigger;
  workflowId?: string;
}

export class IssueDomainNotFoundError extends Error {
  constructor(domainId: string) {
    super(`Cert domain ${domainId} does not exist`);
    this.name = "IssueDomainNotFoundError";
  }
}

export class IssueDomainNotActiveError extends Error {
  constructor(domainId: string, status: string) {
    super(`Cert domain ${domainId} is ${status}, not active`);
    this.name = "IssueDomainNotActiveError";
  }
}

export async function startIssueRun(
  db: D1Database,
  workflow: IssueWorkflowCreator,
  domainId: string,
  options: StartIssueRunOptions,
): Promise<{ runId: string; workflowId: string }> {
  const domain = await getCertDomain(db, domainId);
  if (!domain) throw new IssueDomainNotFoundError(domainId);
  if (domain.status !== "active") {
    throw new IssueDomainNotActiveError(domainId, domain.status);
  }

  const runId = crypto.randomUUID();
  const workflowId = options.workflowId ?? `${options.trigger}-${runId}`;
  await createIssueRun(db, {
    id: runId,
    domain_id: domainId,
    environment: options.environment,
    workflow_id: workflowId,
    trigger: options.trigger,
  });

  try {
    await workflow.create({
      id: workflowId,
      params: { runId, domainId, environment: options.environment },
    });
  } catch (error) {
    try {
      await finishIssueRun(db, runId, domainId, { status: "failed", error: errorMessage(error) });
    } catch (finishError) {
      throw new AggregateError(
        [error, finishError],
        "Workflow creation and issue-run failure recording both failed",
      );
    }
    throw error;
  }

  return { runId, workflowId };
}

export { ActiveIssueRunError };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
