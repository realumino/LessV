/**
 * The admin bearer key for `/api/admin/*`.
 *
 * WHY a shared secret and not an identity system: the admin surface has
 * exactly one principal (the operator) and one client (the SPA login
 * form), so a constant-time-compared bearer key is the whole model. The
 * key arrives as the `ADMIN_KEY` binding; a request without the right
 * key answers 401 `{detail: "admin key required"}` — fail closed, before
 * routing, so unknown admin paths leak nothing either.
 */

import type { MiddlewareHandler } from "hono";

import { ApiError } from "../models";

export const adminKey: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  const presented = bearer(c.req.header("Authorization") ?? "");
  const expected = c.env.ADMIN_KEY;
  if (!presented || !expected || !(await sameKey(expected, presented))) {
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

/**
 * WHAT: constant-time equality for two key strings.
 *
 * WHY digest first: strings differ in length and content, and a direct
 * compare leaks both. Hashing each side to a fixed 32 bytes makes the
 * XOR-accumulate loop a constant number of steps regardless of what was
 * presented, so the only thing the comparison reveals is equality.
 */
export async function sameKey(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const da = new Uint8Array(left);
  const db = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i]! ^ db[i]!;
  }
  return diff === 0;
}
