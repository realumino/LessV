/**
 * The Hono application.
 *
 * WHY a module-level app and not a factory: workerd takes the deploy-time
 * memory snapshot of the top-level scope, so the module must be
 * side-effect free — building the app object is pure, and no request-time
 * binding is touched until a request arrives. Bindings travel on the Hono
 * context (`c.env`), which replaces FastAPI's `routers/deps.py` wrapper.
 */

import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { adminKey } from "./auth/admin_key";
import { ApiError } from "./models";
import { ADMIN_PREFIX, isAllowedPath } from "./route_groups";
import { adminInboundLinks } from "./routers/admin_inbound_links";
import { adminNames } from "./routers/admin_names";
import { adminNodes } from "./routers/admin_nodes";
import { adminReality } from "./routers/admin_reality";
import { adminUsers } from "./routers/admin_users";
import { adminCerts } from "./routers/admin_certs";
import { health } from "./routers/health";
import { nodeApi } from "./routers/node";
import { subRouter } from "./routers/sub";

export const app = new Hono<{ Bindings: Env }>();

/**
 * WHAT: reject any path outside the four route groups with a bare 404, and
 * require the admin bearer key on `/api/admin/*`.
 *
 * WHY one middleware and not per-router checks: fail-closed must hold for
 * routes that do not exist yet and for mistakes made later. One check in
 * front of routing cannot be forgotten by a new router, and there is no
 * way to satisfy it partially — the path either sits in a group or the
 * request never reaches one.
 *
 * WHY the admin key check rides on the same `*` middleware instead of its
 * own `app.use("/api/admin/*", ...)`: workerd serves unmatched paths
 * through Hono's single-handler fast path, where only `*`-registered
 * middleware runs — a path-pattern middleware is silently skipped there,
 * which would let unknown admin paths answer 404 unauthenticated. Under
 * the `*` mount the key check runs before routing for every admin path,
 * known or not: an unauthenticated request answers 401, and only an
 * authenticated one reaches a 404.
 */
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (!isAllowedPath(path)) {
    return c.json({ detail: "Not found" }, 404);
  }
  if (path.startsWith(ADMIN_PREFIX)) {
    await adminKey(c, next);
    return;
  }
  await next();
});

/** WHAT: the 404 for an allowed group with no matching route. */
app.notFound((c) => c.json({ detail: "Not found" }, 404));

/**
 * WHAT: turn a thrown error into the `{detail}` envelope.
 *
 * WHY `ApiError` first: it is the port of FastAPI's `HTTPException` — the
 * routers threw it with the status and detail Python would have used, and
 * this handler renders it (a string for semantic errors, a list for
 * validation failures). Everything else is unexpected: log the traceback
 * and answer 500, keeping the same shape so the SPA's error parsing never
 * sees a bare text body.
 */
app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json(
      { detail: error.detail },
      error.status as ContentfulStatusCode,
    );
  }
  console.error(error);
  return c.json({ detail: "Internal Server Error" }, 500);
});

app.route("/", health);
app.route("/", adminNodes);
app.route("/", adminInboundLinks);
app.route("/", adminNames);
app.route("/", adminUsers);
app.route("/", adminReality);
app.route("/", adminCerts);
app.route("/", nodeApi);
app.route("/", subRouter);
