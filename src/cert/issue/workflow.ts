/**
 * The durable issuance pipeline. Ported from certworker's workflow.ts with
 * the environment dimension and the order/authz expiry retry ring. The
 * order phases run under suffixed step names
 * (`new-order-1`, `publish-txt-1`, ...) and an AcmeError mentioning
 * `expired`/`orderNotReady` reopens the order at most once — LE staging
 * authorizations expire in ~5 minutes and an expired order must not fail
 * a run that could succeed with a fresh one. `finalize+store` is outside
 * the ring: a failure there means the run failed for real, and a retry
 * would double-spend a rate-limited CA.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { finishIssueRun, recordRunPhase, type CertificateRow } from "../store/d1";
import { AcmeError } from "../acme/errors";
import {
  acceptChallenges,
  checkAuthorizations,
  checkOrderReadiness,
  checkOrderValidity,
  checkTxtPropagation,
  cleanupFailedArtifacts,
  cleanupTxtRecords,
  createIssueDependencies,
  createLeafKeyAndCsr,
  createOrder,
  ensureAcmeAccount,
  finalizeOrder,
  issueErrorMessage,
  loadIssue,
  publishTxtChallenges,
  purgePreviousCertificate,
  storeIssuedCertificate,
  type NewOrderState,
  type PublishedChallenges,
  type ReadyOrder,
  type ValidOrder,
} from "./steps";
import type { IssuePayload } from "./types";

const NEW_ORDER_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: 10_000, backoff: "exponential" },
  timeout: "10 minutes",
};

const PURGE_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: 10_000, backoff: "exponential" },
  timeout: "10 minutes",
};

/** Maximum order attempts (initial + one reopen after expiry). */
const MAX_ORDER_ATTEMPTS = 2;

export interface IssueWorkflowOutput {
  runId: string;
  status: "succeeded" | "failed";
  certificateId?: string;
  error?: string;
}

/** Durable ACME DNS-01 issuance, artifact persistence, and cleanup pipeline. */
export class CertificateWorkflow extends WorkflowEntrypoint<Env, IssuePayload> {
  async run(
    event: Readonly<WorkflowEvent<IssuePayload>>,
    step: WorkflowStep,
  ): Promise<IssueWorkflowOutput> {
    const { runId, domainId, environment } = event.payload;
    const deps = createIssueDependencies(this.env, environment);
    let previousCertificate: CertificateRow | null = null;
    let domainName: string | undefined;
    let certificateId: string | undefined;
    let failure: unknown;
    let hasFailure = false;

    try {
      await this.phase(step, runId, "load");
      const loaded = await step.do("load", async () => loadIssue(deps, runId, domainId));
      domainName = loaded.domain.name;
      previousCertificate = loaded.previousCertificate;

      await this.phase(step, runId, "ensure-account");
      // The account state rides in D1; ensureAcmeAccount creates it when the
      // environment has none. The value itself is not used downstream (every
      // step reloads the account), but the step must still run.
      await step.do("ensure-account", async () => ensureAcmeAccount(deps));

      // Order ring: reopen at most once when the CA reports an expired
      // order/authorization. Step names carry the attempt suffix.
      let order: NewOrderState | undefined;
      let published: PublishedChallenges | undefined;
      for (let attempt = 1; attempt <= MAX_ORDER_ATTEMPTS; attempt += 1) {
        try {
          await this.phase(step, runId, `new-order-${attempt}`);
          order = await step.do(
            `new-order-${attempt}`,
            NEW_ORDER_CONFIG,
            async () => createOrder(deps, loaded.identifiers),
          );

          await this.phase(step, runId, `publish-txt-${attempt}`);
          published = await step.do(
            `publish-txt-${attempt}`,
            async () =>
              publishTxtChallenges(deps, runId, loaded.domain, order!.authorizations),
          );

          await this.phase(step, runId, `wait-propagation-${attempt}`);
          await this.pollUntil(
            step,
            `propagation-${attempt}`,
            {
              attempts: Math.max(1, Math.ceil(deps.timings.dnsTimeoutMs / deps.timings.dnsPollIntervalMs)),
              intervalMs: deps.timings.dnsPollIntervalMs,
              settleMs: deps.timings.dnsSettleMs,
            },
            () => checkTxtPropagation(deps, published!),
          );

          await this.phase(step, runId, `accept-challenges-${attempt}`);
          await step.do(`accept-challenges-${attempt}`, async () =>
            acceptChallenges(deps, published!),
          );

          await this.phase(step, runId, `await-authz-${attempt}`);
          await this.pollUntil(
            step,
            `authz-${attempt}`,
            {
              attempts: Math.max(1, Math.ceil(deps.timings.acmeTimeoutMs / deps.timings.acmePollIntervalMs)),
              intervalMs: deps.timings.acmePollIntervalMs,
            },
            () => checkAuthorizations(deps, published!),
          );

          break;
        } catch (error) {
          if (attempt < MAX_ORDER_ATTEMPTS && isExpiredOrderError(error)) {
            await this.phase(step, runId, `order-expired-${attempt}`);
            continue;
          }
          throw error;
        }
      }

      await this.phase(step, runId, "key+csr");
      const leaf = await step.do(
        "key+csr",
        async () => createLeafKeyAndCsr(deps, runId, loaded.identifiers),
      );

      await this.phase(step, runId, "finalize+store");
      const readyOrder = await this.pollReadyOrder(
        step,
        "order-ready",
        {
          attempts: Math.max(1, Math.ceil(deps.timings.acmeTimeoutMs / deps.timings.acmePollIntervalMs)),
          intervalMs: deps.timings.acmePollIntervalMs,
        },
        () => checkOrderReadiness(deps, order!),
      );
      await step.do("finalize-order", async () =>
        finalizeOrder(deps, order!, readyOrder, leaf),
      );
      const validOrder = await this.pollValidOrder(
        step,
        "order-valid",
        {
          attempts: Math.max(1, Math.ceil(deps.timings.acmeTimeoutMs / deps.timings.acmePollIntervalMs)),
          intervalMs: deps.timings.acmePollIntervalMs,
        },
        () => checkOrderValidity(deps, order!),
      );
      const certificate = await step.do(
        "store-certificate",
        async () =>
          storeIssuedCertificate(deps, loaded.domain, loaded.identifiers, order!, leaf, validOrder),
      );
      certificateId = certificate.certificateId;

      try {
        await this.phase(step, runId, "purge-previous");
      } catch (error) {
        console.warn(JSON.stringify({
          event: "certificate.previous_purge_phase_failed",
          runId,
          error: issueErrorMessage(error),
        }));
      }
      try {
        const result = await step.do(
          "purge-previous",
          PURGE_CONFIG,
          async () => purgePreviousCertificate(deps, previousCertificate),
        );
        if (previousCertificate && !result.purged) {
          console.warn(JSON.stringify({ event: "certificate.previous_not_purged", runId }));
        }
      } catch (error) {
        // The sweeper retries superseded prefixes whose purged_at is still NULL.
        console.warn(JSON.stringify({
          event: "certificate.previous_purge_failed",
          runId,
          error: issueErrorMessage(error),
        }));
      }
    } catch (error) {
      failure = error;
      hasFailure = true;
    }

    try {
      await this.phase(step, runId, "cleanup-txt");
    } catch (error) {
      failure = appendFailure(failure, error, hasFailure);
      hasFailure = true;
    }
    try {
      await step.do("cleanup-txt", async () => cleanupTxtRecords(deps, runId));
    } catch (error) {
      failure = appendFailure(failure, error, hasFailure);
      hasFailure = true;
    }

    if (hasFailure && domainName) {
      try {
        await this.phase(step, runId, "cleanup-failed-artifacts");
      } catch (error) {
        failure = appendFailure(failure, error, true);
      }
      try {
        await step.do(
          "cleanup-failed-artifacts",
          async () => cleanupFailedArtifacts(deps, runId),
        );
      } catch (error) {
        failure = appendFailure(failure, error, true);
      }
    }

    const status = hasFailure ? "failed" : "succeeded";
    const errorMessage = hasFailure ? issueErrorMessage(failure) : undefined;
    await step.do("finish-run", async () => finishIssueRun(
      deps.db,
      runId,
      domainId,
      hasFailure
        ? { status: "failed", error: errorMessage ?? "Issuance failed" }
        : { status: "succeeded" },
      // last_error is the production column; staging test runs never touch it.
      { recordDomainError: environment === "production" },
    ));

    return {
      runId,
      status,
      ...(certificateId ? { certificateId } : {}),
      ...(errorMessage ? { error: errorMessage } : {}),
    };
  }

  private async phase(step: WorkflowStep, runId: string, phase: string): Promise<void> {
    await step.do(`phase-${phase}`, async () => recordRunPhase(this.env.DB, runId, phase));
  }

  /**
   * WHAT: durable boolean polling — one check per step, sleeps between.
   *
   * WHY not one long polling step: the per-invocation subrequest budget
   * (50 on the free plan) is shared by every fetch inside a step, so a
   * five-minute ACME or DoH poll loop can exhaust it and fail the run
   * after the CA has already accepted the order. Sleeping between checks
   * ends the invocation and gives every check a fresh budget.
   */
  private async pollUntil(
    step: WorkflowStep,
    name: string,
    options: { attempts: number; intervalMs: number; settleMs?: number },
    check: () => Promise<boolean>,
  ): Promise<void> {
    for (let index = 0; index < options.attempts; index += 1) {
      const done = await step.do(`${name}-check-${index}`, check);
      if (done) {
        if (!options.settleMs) return;
        await step.sleep(`${name}-settle`, options.settleMs);
        if (await step.do(`${name}-recheck`, check)) return;
      }
      await step.sleep(`${name}-wait-${index}`, options.intervalMs);
    }
    throw new NonRetryableError(`${name} did not converge within ${options.attempts} checks`);
  }

  /** WHAT: durable polling for the first ready order. */
  private async pollReadyOrder(
    step: WorkflowStep,
    name: string,
    options: { attempts: number; intervalMs: number },
    check: () => Promise<ReadyOrder | null>,
  ): Promise<ReadyOrder> {
    for (let index = 0; index < options.attempts; index += 1) {
      const value = await step.do(`${name}-check-${index}`, check);
      if (value !== null) return value;
      await step.sleep(`${name}-wait-${index}`, options.intervalMs);
    }
    throw new NonRetryableError(`${name} did not converge within ${options.attempts} checks`);
  }

  /** WHAT: durable polling for the first valid order. */
  private async pollValidOrder(
    step: WorkflowStep,
    name: string,
    options: { attempts: number; intervalMs: number },
    check: () => Promise<ValidOrder | null>,
  ): Promise<ValidOrder> {
    for (let index = 0; index < options.attempts; index += 1) {
      const value = await step.do(`${name}-check-${index}`, check);
      if (value !== null) return value;
      await step.sleep(`${name}-wait-${index}`, options.intervalMs);
    }
    throw new NonRetryableError(`${name} did not converge within ${options.attempts} checks`);
  }
}

/**
 * WHAT: true when the error says the order or one of its authorizations
 * expired (or finalize hit a not-ready order after authz expiry).
 *
 * WHY two shapes: steps wrap permanent ACME problems in `NonRetryableError`
 * with the serialized problem document as the message, while retriable
 * AcmeErrors escape unwrapped. Both spell expiry inside the ACME problem
 * body; requiring the acme:error URI in the wrapped case keeps generic
 * failures out of the retry ring.
 */
function isExpiredOrderError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof AcmeError) {
    return /expired|orderNotReady/i.test(
      `${error.type ?? ""} ${error.detail ?? ""} ${error.rawBody ?? ""}`,
    );
  }
  return /urn:ietf:params:acme:error:/.test(error.message) &&
    /expired|orderNotReady/i.test(error.message);
}

function appendFailure(current: unknown, next: unknown, hasCurrent: boolean): unknown {
  return hasCurrent
    ? new AggregateError([current, next], "Issuance and cleanup both failed")
    : next;
}
