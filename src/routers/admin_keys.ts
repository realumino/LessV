/**
 * Admin endpoints for panel identities: list, mint, revoke.
 *
 * WHY a separate router: admin keys are the fourth resource (nodes, users,
 * certificates, keys). No SQL and no crypto live here — endpoints translate
 * between HTTP and the service layer, and the plaintext appears exactly
 * once, in the 201 body of the mint call.
 *
 * WHY the middleware is not here: authentication is one fail-closed check
 * in `src/auth/admin_key.ts` ahead of routing; these endpoints only shape
 * responses for an already-authenticated caller.
 */

import { Hono } from "hono";

import { ApiError, AdminKeyCreateIn, parseJsonBody } from "../models";
import * as adminKeyService from "../services/admin_key_service";
import { now } from "../services/node_state_service";

export const adminKeys = new Hono<{ Bindings: Env }>();

adminKeys.get("/api/admin/keys", async (c) => {
  return c.json(await adminKeyService.listKeys(c.env.DB));
});

adminKeys.post("/api/admin/keys", async (c) => {
  const payload = await parseJsonBody(c.req.raw, AdminKeyCreateIn);
  const created = await adminKeyService.createAdminKey(
    c.env.DB,
    payload.label,
    now(),
  );
  return c.json(created, 201);
});

adminKeys.delete("/api/admin/keys/:id", async (c) => {
  const disabled = await adminKeyService.disableAdminKey(
    c.env.DB,
    c.req.param("id"),
    now(),
  );
  if (!disabled) {
    throw new ApiError(404, "key not found");
  }
  return c.json({});
});
