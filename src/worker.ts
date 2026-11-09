/**
 * Worker entrypoint: the Hono app, plus the certificate cron and the
 * issuance Workflow class.
 *
 * WHY the app is a valid module Worker as-is: a Hono instance exposes a
 * `fetch(request, env, ctx)` method, which is exactly workerd's ES module
 * handler contract. The default export carries both handlers — `fetch`
 * serving the app and `scheduled` running the daily certificate cron —
 * and `CertificateWorkflow` is a named export because the `workflows`
 * config references the class by name.
 */

import { app } from "./main";
import { CertificateWorkflow } from "./cert/issue/workflow";
import { runCron } from "./cert/issue/cron";

export { CertificateWorkflow };

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),

  /**
   * WHAT: the daily certificate cron (UTC 03:17): renew due production
   * certificates and sweep cleanup debt.
   *
   * WHY waitUntil: the cron may create several workflows and run the
   * sweeper; workerd keeps the invocation alive while the ctx promise is
   * pending, so the handler awaits inside it instead of fire-and-forget.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const scheduledAt = _event.scheduledTime ? new Date(_event.scheduledTime) : new Date();
    ctx.waitUntil(runCron(env, { now: scheduledAt }));
  },
};
