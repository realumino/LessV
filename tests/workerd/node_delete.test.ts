/**
 * Deleting a node removes exactly the state scoped to it.
 *
 * WHY HTTP tests: the operation is one admin request whose promise is "the
 * node and everything hanging off it disappear, and nothing else does". A
 * half-delete would leave rows the rest of the app can still reach — access
 * rows pointing at a missing node, registry rows with no owner, a token that
 * authenticates nothing. The child tables are asserted directly because no
 * endpoint exposes them.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { planeFetch, planeJson, uid } from "../helpers";

/** WHAT: one REALITY inbound and one exit — enough to create every child row. */
function config(): Record<string, unknown> {
  return {
    inbounds: [
      {
        tag: "reality",
        protocol: "vless",
        port: 443,
        settings: { clients: [] },
        streamSettings: {
          network: "raw",
          security: "reality",
          realitySettings: {
            serverNames: ["apple.com"],
            privateKey: "operator-key",
            shortIds: ["1234"],
          },
        },
      },
    ],
    outbounds: [
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "niigata", protocol: "freedom" },
    ],
  };
}

/** WHAT: count the rows one node still owns in one child table. */
async function scopedRows(table: string, nodeId: string): Promise<number> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE node_id = ?`,
  )
    .bind(nodeId)
    .all<{ n: number }>();
  return result.results[0]?.n ?? 0;
}

/** WHAT: seed one cert domain row so the node has an assignment to lose. */
async function seedDomain(): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO cert_domains
       (id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
        status, last_error, created_at, updated_at)
     VALUES (?, ?, 'zone-test', 0, 'tlsserver', NULL, 'active', NULL, ?, ?)`,
  )
    .bind(id, `${uid("d")}.example.com`, now, now)
    .run();
  return id;
}

describe("deleting a node", () => {
  /** WHAT: create a node with config, access, keys, a variant, and an assignment. */
  async function makeLoadedNode(): Promise<{
    nodeId: string;
    token: string;
    user: string;
    domainId: string;
    otherNode: string;
  }> {
    const nodeId = uid("n");
    const otherNode = uid("n");
    const user = uid("alice");
    const domainId = await seedDomain();

    for (const id of [nodeId, otherNode]) {
      const created = await planeJson("POST", "/api/admin/nodes", {
        id,
        label: id,
        address: "funky.example.com",
      });
      expect(created.status, await created.clone().text()).toBe(201);
    }
    const put = await planeJson(
      "PUT",
      `/api/admin/nodes/${nodeId}/config`,
      config(),
    );
    expect(put.status, await put.clone().text()).toBe(200);

    const minted = await planeJson("POST", `/api/admin/nodes/${nodeId}/token`);
    const token = ((await minted.json()) as { token: string }).token;

    const created = await planeJson("POST", "/api/admin/users", {
      username: user,
      access: {
        [nodeId]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
        [otherNode]: {
          allowed_inbounds: [],
          allowed_outbounds: [],
        },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);

    // Render once: the choke point mints the panel-owned REALITY key.
    const runtime = await planeJson(
      "GET",
      `/api/admin/nodes/${nodeId}/config/runtime`,
    );
    expect(runtime.status, await runtime.clone().text()).toBe(200);

    const variant = await planeJson(
      "POST",
      `/api/admin/nodes/${nodeId}/inbound-links`,
      { id: "cdn", inbound_id: "reality", label: "CDN", overrides: {} },
    );
    expect(variant.status, await variant.clone().text()).toBe(201);

    const assigned = await planeJson(
      "PUT",
      `/api/admin/nodes/${nodeId}/cert-domains`,
      { domain_ids: [domainId] },
    );
    expect(assigned.status, await assigned.clone().text()).toBe(200);

    return { nodeId, token, user, domainId, otherNode };
  }

  it("removes the node, its token, and every row scoped to it", async () => {
    const { nodeId, token, user, domainId, otherNode } = await makeLoadedNode();
    expect(await scopedRows("user_node_access", nodeId)).toBe(1);
    expect(await scopedRows("reality_keys", nodeId)).toBe(1);
    expect(await scopedRows("inbound_links", nodeId)).toBe(1);
    expect(await scopedRows("node_inbounds", nodeId)).toBe(1);
    expect(await scopedRows("node_outbounds", nodeId)).toBe(2);
    expect(await scopedRows("node_cert_domains", nodeId)).toBe(1);

    const deleted = await planeJson("DELETE", `/api/admin/nodes/${nodeId}`);
    expect(deleted.status, await deleted.clone().text()).toBe(204);

    expect(
      (await planeJson("GET", `/api/admin/nodes/${nodeId}`)).status,
    ).toBe(404);
    const listed = await planeJson("GET", "/api/admin/nodes");
    expect((await listed.json<{ id: string }[]>()).map((row) => row.id)).not.toContain(
      nodeId,
    );
    expect((await planeJson("POST", `/api/admin/nodes/${nodeId}/token`)).status).toBe(404);

    for (const table of [
      "user_node_access",
      "reality_keys",
      "inbound_links",
      "node_inbounds",
      "node_outbounds",
      "node_cert_domains",
    ]) {
      expect(await scopedRows(table, nodeId), table).toBe(0);
    }

    // The user survives; only the deleted node's membership is gone.
    const profile = await planeJson("GET", `/api/admin/users/${user}`);
    const body = (await profile.json()) as { access: Record<string, unknown> };
    expect(body.access).not.toHaveProperty(nodeId);
    expect(body.access).toHaveProperty(otherNode);

    // A deleted node's token authenticates nothing.
    const heartbeat = await planeFetch("/api/node/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Lessv-Node": nodeId,
      },
      body: JSON.stringify({ protocol: 2 }),
    });
    expect(heartbeat.status).toBe(401);

    // The cert domain itself is domain-scoped: it stays.
    const domains = await planeJson("GET", "/api/admin/cert-domains");
    expect(
      (await domains.json<{ id: string }[]>()).map((row) => row.id),
    ).toContain(domainId);

    // The other node keeps its own row and its (empty) membership.
    expect(
      (await planeJson("GET", `/api/admin/nodes/${otherNode}`)).status,
    ).toBe(200);
    expect(await scopedRows("user_node_access", otherNode)).toBe(1);
  });

  it("404s a second delete and an unknown node", async () => {
    const nodeId = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: nodeId,
    });
    expect(created.status).toBe(201);

    expect(
      (await planeJson("DELETE", `/api/admin/nodes/${nodeId}`)).status,
    ).toBe(204);
    expect(
      (await planeJson("DELETE", `/api/admin/nodes/${nodeId}`)).status,
    ).toBe(404);
    expect((await planeJson("DELETE", "/api/admin/nodes/ghost")).status).toBe(404);
  });
});
