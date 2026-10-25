/**
 * Issuance vocabulary shared by the store, the workflow, and the cron.
 *
 * WHY two environments as constants, not Worker vars: staging and
 * production are distinct ACME accounts with distinct directories, and the
 * whole P1b design (§3.3) treats them as fixed facts of the deployment —
 * a variable would invite pointing production at staging by accident.
 */

export type AcmeEnvironment = "production" | "staging";

export type IssueTrigger = "renew" | "manual" | "test";

/** WHAT: the Workflow payload; everything else is re-read from D1. */
export interface IssuePayload {
  runId: string;
  domainId: string;
  environment: AcmeEnvironment;
}

/** WHAT: the two Let's Encrypt directory URLs, by environment. */
export const ACME_DIRECTORIES: Record<AcmeEnvironment, string> = {
  production: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};
