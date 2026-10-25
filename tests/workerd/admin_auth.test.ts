/**
 * Tests for the admin bearer key, over a real plane.
 *
 * WHY HTTP: the contract is "authentication precedes routing" — every
 * /api/admin/* path answers 401 to an unauthenticated caller (unknown
 * paths included, so the path space leaks nothing), while /api/health,
 * /sub/*, and the node plane behave exactly as before. Pinned against a
 * live plane and the fail-closed middleware in src/auth/admin_key.ts.
 */

import { describe, expect, it } from "vitest";

import { planeFetch, TEST_ADMIN_KEY } from "../helpers";

describe("admin key auth", () => {
  /**
   * WHAT: a RequestInit with no usable Authorization header.
   *
   * WHY: planeFetch injects the test key into /api/admin/* calls that do
   * not set Authorization themselves, so "no key" must be stated as an
   * explicit empty header — same middleware path as a missing header
   * (bearer() reads an empty value and treats it as absent).
   */
  function noKey(): RequestInit {
    return { headers: { Authorization: "" } };
  }

  it("answers 401 without a key, even on unknown admin paths", async () => {
    const response = await planeFetch("/api/admin/nope", noKey());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "admin key required" });
  });

  it("answers 401 with a wrong key", async () => {
    const response = await planeFetch("/api/admin/nodes", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "admin key required" });
  });

  it("answers 200 on a known path and 404 on an unknown one with the key", async () => {
    const known = await planeFetch("/api/admin/nodes", {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual([]);

    const unknown = await planeFetch("/api/admin/nope", {
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    });
    expect(unknown.status).toBe(404);
  });

  it("leaves health and the subscription surface open", async () => {
    const health = await planeFetch("/api/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    const sub = await planeFetch("/sub/no-such-token");
    expect(sub.status).toBe(200);
    expect(await sub.text()).toBe("");
  });

  it("leaves the node plane on its own credential error", async () => {
    const response = await planeFetch("/api/node/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ applied_hash: "" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      detail: "invalid node credentials",
    });
  });
});
