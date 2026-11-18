/**
 * Shared test helpers for the workerd tier.
 *
 * WHY this exists: Python's tests/workerd/harness.py booted a real server
 * and spoke HTTP to it. The vitest plugin runs tests and the Worker in the
 * same isolate, so the equivalent is `exports.default.fetch()` — same HTTP
 * surface, no port, no process. Keeping the call in one helper means every
 * ported test reads like the Python client it came from.
 */

import { env, exports } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-plugin";

const ORIGIN = "https://plane.test";

/**
 * WHAT: the admin key the test harness presents to /api/admin/*.
 *
 * WHY a fixed literal: `tests/setup.ts` seeds the hash of exactly this value
 * into `admin_keys`, so it is the token of a row, not a binding — the plane
 * has no env fallback, and production secrets never touch tests.
 */
export const TEST_ADMIN_KEY = "test-admin-key";

/**
 * WHAT: fetch one path from the Worker's default export.
 *
 * WHY the default export and not the Hono app object: the port's spec is
 * the HTTP behavior, so requests must travel the same fetch path workerd
 * serves in production, routing and error handling included.
 *
 * WHY the injection: admin tests care about their scenario's key state,
 * not about carrying a bearer header on every call, so a request under
 * /api/admin/ gets the test key unless the caller set Authorization
 * itself (merged, never overwritten — node-plane tests rely on that).
 */
export function planeFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (path.startsWith("/api/admin/") && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${TEST_ADMIN_KEY}`);
  }
  return exports.default.fetch(new Request(ORIGIN + path, { ...init, headers }));
}

/**
 * WHAT: fetch one path with an optional JSON body.
 *
 * WHY a helper: the Python harness's client spoke `post(path, json=...)`,
 * and every ported admin test uses that shape. A missing body means a
 * bodyless request (GET, DELETE), not the string "undefined".
 */
export function planeJson(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return planeFetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * WHAT: return the migrations the vitest config injected as a binding.
 *
 * WHY a cast: TEST_MIGRATIONS exists only in tests (miniflare bindings),
 * so it is deliberately absent from the generated Cloudflare.Env; the
 * vitest config is the single place that defines it.
 */
export function testMigrations(): D1Migration[] {
  return (env as typeof env & { TEST_MIGRATIONS: D1Migration[] })
    .TEST_MIGRATIONS;
}

/**
 * WHAT: return a unique lowercase alphanumeric id for one test's data.
 *
 * WHY random suffixes: the integration tier shares one D1 (the vitest
 * plugin has no per-test storage isolation), so ids must not collide
 * between tests or between runs. Node ids must be 1-32 chars of
 * `[a-z0-9]` — no hyphens — and hex is safe for usernames too.
 */
export function uid(prefix = ""): string {
  return prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 8);
}
