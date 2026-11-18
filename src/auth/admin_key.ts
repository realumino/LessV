/**
 * The admin bearer key for `/api/admin/*`.
 *
 * WHY one source: every identity is a row in `admin_keys`, minted and
 * revoked at runtime through the panel. There is no env fallback, so a
 * plane with zero rows accepts nothing — which is the honest state of a
 * plane nobody has provisioned yet. `scripts/admin_key.mjs create` is the
 * bootstrap and the recovery path in one: it inserts the row straight into
 * D1, so it works when the panel cannot be opened at all (no rows, or every
 * key disabled).
 *
 * WHY a database read on the hot path: the row is the only truth, so a D1
 * outage is a lockout. That is deliberate — the alternative is a static
 * credential that no revocation reaches.
 *
 * A request without the right key answers 401
 * `{detail: "admin key required"}` — fail closed, before routing, so
 * unknown admin paths leak nothing either.
 */

import type { MiddlewareHandler } from "hono";

import { ApiError } from "../models";
import * as adminKeyService from "../services/admin_key_service";

export const adminKey: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const presented = bearer(c.req.header("Authorization") ?? "");
  if (!presented) {
    throw new ApiError(401, "admin key required");
  }
  if (!(await adminKeyService.verifyAdminKey(c.env.DB, presented))) {
    throw new ApiError(401, "admin key required");
  }
  await next();
};

/**
 * WHAT: the token out of an `Authorization` header value.
 *
 * WHY strict: the scheme is case-insensitive per RFC 7235, but an empty
 * token or a missing scheme counts as absent rather than a wrong key —
 * both must 401, and neither must reach the digest comparison.
 */
function bearer(header: string): string | null {
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") {
    return null;
  }
  const token = header.slice(space + 1).trim();
  return token === "" ? null : token;
}
