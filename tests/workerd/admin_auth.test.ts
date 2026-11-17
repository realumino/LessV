/**
 * Tests for the admin bearer key, over a real plane.
 *
 * WHY HTTP: the contract is "authentication precedes routing" — every
 * /api/admin/* path answers 401 to an unauthenticated caller (unknown
 * paths included, so the path space leaks nothing), while /api/health,
 * /sub/*, and the node plane behave exactly as before. Pinned against a
 * live plane and the fail-closed middleware in src/auth/admin_key.ts.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { planeFetch, planeJson, TEST_ADMIN_KEY, uid } from "../helpers";

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

  // WHY byte identity: a caller that can tell "no key" from "wrong key" (or an
  // unknown admin path from a known one) learns which guesses are getting
  // closer. The three answers must be the same bytes, not merely the same
  // status.
  it("answers missing, wrong, and unknown-path requests identically", async () => {
    const missing = await planeFetch("/api/admin/nodes", noKey());
    const wrong = await planeFetch("/api/admin/nodes", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    const unknown = await planeFetch("/api/admin/nope", noKey());
    const shape = async (response: Response) => ({
      status: response.status,
      type: response.headers.get("content-type"),
      body: await response.text(),
    });
    const [a, b, c] = await Promise.all([shape(missing), shape(wrong), shape(unknown)]);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
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
    expect(await health.json()).toEqual({ status: "ok", protocol: 3 });

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

describe("admin key identities", () => {
  /** WHAT: parse one response body. */
  async function body<T>(response: Response): Promise<T> {
    return (await response.json()) as T;
  }

  /** WHAT: mint one admin key through the API and return its row. */
  async function mint(label: string) {
    const response = await planeJson("POST", "/api/admin/keys", { label });
    expect(response.status, await response.clone().text()).toBe(201);
    return body<{
      id: string;
      label: string;
      created_at: number;
      token: string;
    }>(response);
  }

  it("mints a key, shows the token once, and lists no token ever again", async () => {
    const created = await mint("operator");
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.label).toBe("operator");

    const list = await body<Array<Record<string, unknown>>>(
      await planeJson("GET", "/api/admin/keys"),
    );
    const row = list.find((key) => key.id === created.id);
    expect(row).toMatchObject({ label: "operator", disabled_at: null });
    // Byte-level: neither the plaintext nor its storage form may appear.
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(JSON.stringify(list)).not.toContain("key_hash");
  });

  it("authenticates a second key through the same middleware", async () => {
    // WHY: one principal was the old model; the point of identities is a
    // second one working beside ADMIN_KEY, with no role distinction yet.
    const created = await mint("second");
    const response = await planeJson("GET", "/api/admin/keys", undefined, {
      Authorization: `Bearer ${created.token}`,
    });
    expect(response.status).toBe(200);
  });

  it("answers a disabled key with the same 401 body as a wrong key", async () => {
    const created = await mint("revoked");
    const deleted = await planeJson(
      "DELETE",
      `/api/admin/keys/${created.id}`,
    );
    expect(deleted.status, await deleted.clone().text()).toBe(200);

    const disabled = await planeJson("GET", "/api/admin/keys", undefined, {
      Authorization: `Bearer ${created.token}`,
    });
    const wrong = await planeJson("GET", "/api/admin/keys", undefined, {
      Authorization: "Bearer wrong-key",
    });
    expect(disabled.status).toBe(401);
    expect(await disabled.clone().text()).toBe(await wrong.clone().text());

    // The list still shows the revocation as history.
    const list = await body<Array<{ id: string; disabled_at: number | null }>>(
      await planeJson("GET", "/api/admin/keys"),
    );
    expect(list.find((key) => key.id === created.id)?.disabled_at).not.toBeNull();
  });

  it("still accepts the ADMIN_KEY binding (break-glass this release)", async () => {
    // WHY: identities must never lock the operator out before the binding
    // path is removed; TEST_ADMIN_KEY resolves through the env binding.
    const response = await planeJson("GET", "/api/admin/keys");
    expect(response.status).toBe(200);
  });

  it("404s the revoke of an unknown key id", async () => {
    const response = await planeJson(
      "DELETE",
      `/api/admin/keys/${uid("k")}`,
    );
    expect(response.status).toBe(404);
  });

  it("422s a mint without a label", async () => {
    const response = await planeJson("POST", "/api/admin/keys", {});
    expect(response.status).toBe(422);
  });

  it("keeps working when a stored row's hash is tampered", async () => {
    // WHY: the middleware looks the hash up in D1; a corrupt row must not
    // break the admin surface — the binding path still answers, and the
    // stored key just fails like any unknown token.
    const created = await mint("tampered");
    await env.DB.prepare(
      "UPDATE admin_keys SET key_hash = 'deadbeef' WHERE id = ?",
    )
      .bind(created.id)
      .run();

    const withRow = await planeJson("GET", "/api/admin/keys", undefined, {
      Authorization: `Bearer ${created.token}`,
    });
    expect(withRow.status).toBe(401);

    const withBinding = await planeJson("GET", "/api/admin/keys");
    expect(withBinding.status).toBe(200);
  });
});
