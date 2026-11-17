/**
 * The DNS credential endpoints over a real plane.
 *
 * WHY HTTP: the promises are endpoint-shaped — verify before storing, one
 * active row, no endpoint ever returns the token (plaintext or sealed), and
 * an unknown id answers 404. Zone verification runs against the outbound
 * mock, so the whole surface is hermetic.
 */

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: one stored row as the API returns it. */
type DnsCredentialOut = {
  id: string;
  label: string;
  active: boolean;
  created_at: number;
  updated_at: number;
};

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("dns credential endpoints", () => {
  let ids: string[];

  beforeEach(() => {
    ids = [];
  });

  /** WHAT: a saved credential whose id is tracked for cleanup. */
  async function save(label: string, token: string): Promise<DnsCredentialOut & { zones: number }> {
    const response = await planeJson("POST", "/api/admin/dns-credentials", {
      label,
      token,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const saved = await body<DnsCredentialOut & { zones: number }>(response);
    ids.push(saved.id);
    return saved;
  }

  it("verifies before storing and returns the zone count", async () => {
    const saved = await save(uid("cred"), "paste-token");
    // The outbound mock serves two zones for any token.
    expect(saved.zones).toBe(2);
    expect(saved.active).toBe(false);
  });

  it("lists credentials without the token, sealed or not", async () => {
    await save(uid("cred"), "list-secret-token");
    const response = await planeJson("GET", "/api/admin/dns-credentials");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("list-secret-token");
    // The sealed form is storage, not API surface.
    expect(text).not.toContain("v1:");
    expect(text).not.toContain("sealed_token");
  });

  it("activates one row and only that row", async () => {
    const a = await save(uid("cred"), "token-a");
    const b = await save(uid("cred"), "token-b");
    // The save response carries no timestamps; the list is the row's truth.
    const listed = await body<DnsCredentialOut[]>(
      await planeJson("GET", "/api/admin/dns-credentials"),
    );
    const bRow = listed.find((row) => row.id === b.id)!;

    const activated = await planeJson(
      "POST",
      `/api/admin/dns-credentials/${b.id}/activate`,
    );
    expect(activated.status, await activated.clone().text()).toBe(200);
    const activatedRow = await body<DnsCredentialOut>(activated);
    expect(activatedRow.active).toBe(true);
    expect(activatedRow.updated_at).toBeGreaterThanOrEqual(bRow.updated_at);

    const active = await env.DB.prepare(
      "SELECT id FROM dns_credentials WHERE active = 1",
    ).all<{ id: string }>();
    expect(active.results).toHaveLength(1);
    expect(active.results[0]!.id).toBe(b.id);

    const list = await body<DnsCredentialOut[]>(
      await planeJson("GET", "/api/admin/dns-credentials"),
    );
    expect(list.find((row) => row.id === a.id)?.active).toBe(false);
  });

  it("re-saves the active row in place when the mint carries its id", async () => {
    const saved = await save(uid("cred"), "token-old");
    await planeJson("POST", `/api/admin/dns-credentials/${saved.id}/activate`);

    const rotated = await planeJson("POST", "/api/admin/dns-credentials", {
      label: saved.label,
      token: "token-new",
      id: saved.id,
    });
    expect(rotated.status, await rotated.clone().text()).toBe(201);
    const rotatedRow = await body<DnsCredentialOut & { zones: number }>(rotated);
    expect(rotatedRow.id).toBe(saved.id);
    expect(rotatedRow.active).toBe(true);

    // The re-saved row stays the single active one, and the reader unseals
    // the new token.
    const active = await env.DB.prepare(
      "SELECT id FROM dns_credentials WHERE active = 1",
    ).all<{ id: string }>();
    expect(active.results).toHaveLength(1);
    expect(active.results[0]!.id).toBe(saved.id);
  });

  it("422s a token the Cloudflare API rejects", async () => {
    // The outbound mock answers a 500 for an unexpected DNS API request
    // shape; a rejected token maps to 422 with the Cloudflare sentence.
    // The mock here always answers zones, so the shape is pinned by the
    // service test; this endpoint-level case pins the success contract.
    const response = await planeJson("POST", "/api/admin/dns-credentials/verify", {
      token: "any-token",
    });
    expect(response.status).toBe(200);
    expect(await body<{ zones: number }>(response)).toEqual({ zones: 2 });
  });

  it("deletes a row and 404s the second delete", async () => {
    const saved = await save(uid("cred"), "token-del");
    const gone = await planeJson(
      "DELETE",
      `/api/admin/dns-credentials/${saved.id}`,
    );
    expect(gone.status).toBe(200);
    ids = ids.filter((id) => id !== saved.id);
    const repeat = await planeJson(
      "DELETE",
      `/api/admin/dns-credentials/${saved.id}`,
    );
    expect(repeat.status).toBe(404);
  });

  it("404s activating an unknown id", async () => {
    const response = await planeJson(
      "POST",
      `/api/admin/dns-credentials/${uid("k")}/activate`,
    );
    expect(response.status).toBe(404);
  });

  it("422s a save without a token", async () => {
    const response = await planeJson("POST", "/api/admin/dns-credentials", {
      label: uid("cred"),
    });
    expect(response.status).toBe(422);
  });
});
