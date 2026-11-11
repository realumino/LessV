/**
 * Tests for the inbound-link admin API, over a real plane.
 *
 * Variants are validated HTTP resources with their own identity; they are
 * attached to a registered inbound id (not its current tag) and are
 * client-side only — a write never touches any render path.
 */

import { describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with one xhttp inbound and one exit. */
function config(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "xhttp",
        protocol: "vless",
        port: 8080,
        settings: { clients: [] },
        streamSettings: { network: "xhttp" },
      },
    ],
    outbounds: [{ tag: "niigata", protocol: "freedom" }],
  };
}

/** WHAT: a valid CDN-style variant payload. */
function variant(linkId = "cdn", inboundId = "xhttp"): Record<string, unknown> {
  return {
    id: linkId,
    inbound_id: inboundId,
    label: "CDN",
    overrides: {
      address: "cdn.example.com",
      port: 443,
      security: "tls",
      sni: "cdn.example.com",
    },
  };
}

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the inbound-link admin API", () => {
  /** WHAT: create the test's node with a variant-ready config. */
  async function makeNode(): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const put = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/config`,
      config(),
    );
    expect(put.status, await put.clone().text()).toBe(200);
    return node;
  }

  it("round-trips create, get, update, and delete", async () => {
    const node = await makeNode();
    const created = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant(),
    );

    expect(created.status).toBe(201);
    const createdBody = await body<{ id: string; inbound_id: string }>(created);
    expect(createdBody.id).toBe("cdn");
    expect(createdBody.inbound_id).toBe("xhttp");
    const listed = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbound-links`,
    );
    expect((await body<{ id: string }[]>(listed)).map((row) => row.id)).toEqual([
      "cdn",
    ]);
    const fetched = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
    );
    expect((await body<{ label: string }>(fetched)).label).toBe("CDN");

    const updated = await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
      { label: "CDN Edge", overrides: { address: "edge.example.com" } },
    );
    expect(updated.status).toBe(200);
    expect((await body<{ label: string }>(updated)).label).toBe("CDN Edge");

    const deleted = await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
    );
    expect(deleted.status).toBe(204);
    const missing = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
    );
    expect(missing.status).toBe(404);
  });

  it("keeps variant writes client-side only", async () => {
    const node = await makeNode();
    await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant(),
    );
    await planeJson(
      "PUT",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
      { label: "CDN Edge" },
    );
    await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/inbound-links/cdn`,
    );

    const response = await planeJson("GET", `/api/admin/nodes/${node}/sync`);
    const sync = await body<{ applied_hash: string | null; last_seen: number | null }>(
      response,
    );
    expect(sync.applied_hash).toBeNull();
    expect(sync.last_seen).toBeNull();
  });

  it("rejects duplicates, unknown inbounds, and missing variants", async () => {
    const node = await makeNode();
    await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant(),
    );

    const duplicate = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant(),
    );
    const unknownInbound = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant("other", "ghost"),
    );
    const ghostNode = await planeJson(
      "POST",
      "/api/admin/nodes/ghost/inbound-links",
      variant(),
    );
    const missing = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbound-links/ghost`,
    );

    expect(duplicate.status).toBe(409);
    expect(unknownInbound.status).toBe(422);
    expect(ghostNode.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("422s invalid slugs, labels, and overrides", async () => {
    const node = await makeNode();
    const badId = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      variant("Bad ID"),
    );
    const badLabel = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      { ...variant("bad-label"), label: "  " },
    );
    const badOverride = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      { ...variant("bad-override"), overrides: { pbk: "x" } },
    );
    const badValue = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/inbound-links`,
      { ...variant("bad-value"), overrides: { port: true } },
    );

    expect(badId.status).toBe(422);
    expect(badLabel.status).toBe(422);
    expect(badOverride.status).toBe(422);
    expect(badValue.status).toBe(422);
  });
});
