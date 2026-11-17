/**
 * Health check route: the cheapest possible proof that the app is alive.
 *
 * WHY this is its own router: `/api/health` is one of the four permanent
 * route groups in AGENTS.md, so it exists in both runtimes from the first
 * commit and is the only route that never depends on a database.
 */

import { Hono } from "hono";

import { PROTOCOL_VERSION } from "./node";

export const health = new Hono();

/**
 * WHAT: answer a constant `{"status": "ok", "protocol": N}` body.
 * WHY: if this responds at all, the app is up; there is nothing to check.
 * WHY the protocol number: the deploy pipeline reads only the status code,
 * so this stays free — but the body tells an operator which contract the
 * live deployment speaks without opening the dashboard.
 */
health.get("/api/health", (c) =>
  c.json({ status: "ok", protocol: PROTOCOL_VERSION }),
);
