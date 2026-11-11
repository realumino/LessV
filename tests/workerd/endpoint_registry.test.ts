/**
 * The endpoint registry: stable ids, editable names, BLOCK, and rebinding.
 *
 * WHY these are HTTP tests: the registry's promises are visible through the
 * admin API — an id that survives a config tag rename, an exit that can
 * never be assigned, a name that changes the generated link remark. The
 * store-level pieces are covered by `db.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with one REALITY inbound and a BLOCK + exit pair. */
function config(exitTag = "niigata"): Record<string, unknown> {
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
      { tag: exitTag, protocol: "freedom" },
    ],
  };
}

type InboundOut = {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  network: string;
  security: string;
};

type OutboundOut = {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  kind: string;
};

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the endpoint registry", () => {
  /** WHAT: create one node and optionally paste a config. */
  async function makeNode(
    nodeConfig: Record<string, unknown> | null = config(),
  ): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(response.status, await response.clone().text()).toBe(201);
    if (nodeConfig !== null) {
      const put = await planeJson(
        "PUT",
        `/api/admin/nodes/${node}/config`,
        nodeConfig,
      );
      expect(put.status, await put.clone().text()).toBe(200);
    }
    return node;
  }

  /** WHAT: read one node's registered inbounds. */
  async function inbounds(node: string): Promise<InboundOut[]> {
    const response = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbounds`,
    );
    return body<InboundOut[]>(response);
  }

  /** WHAT: read one node's registered outbounds. */
  async function outbounds(node: string): Promise<OutboundOut[]> {
    const response = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/outbounds`,
    );
    return body<OutboundOut[]>(response);
  }

  it("registers every declared endpoint with an id and a readable name", async () => {
    const node = await makeNode();

    expect(await inbounds(node)).toEqual([
      {
        id: "reality",
        tag: "reality",
        label: "REALITY",
        protocol: "vless",
        network: "raw",
        security: "reality",
      },
    ]);
    expect(await outbounds(node)).toEqual([
      {
        id: "BLOCK",
        tag: "BLOCK",
        label: "BLOCK",
        protocol: "blackhole",
        kind: "block",
      },
      {
        id: "niigata",
        tag: "niigata",
        label: "Niigata",
        protocol: "freedom",
        kind: "direct",
      },
    ]);
  });

  it("refuses to assign the block route to a user", async () => {
    const node = await makeNode();
    const response = await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: {
        [node]: { allowed_inbounds: ["reality"], allowed_outbounds: ["BLOCK"] },
      },
    });

    expect(response.status).toBe(422);
    const detail = (await body<{ detail: string[] }>(response)).detail;
    expect(detail[0]).toContain("block route");
  });

  it("rejects access that names an unregistered endpoint", async () => {
    const node = await makeNode();
    const badInbound = await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: {
        [node]: { allowed_inbounds: ["ghost"], allowed_outbounds: ["niigata"] },
      },
    });
    const badOutbound = await planeJson("POST", "/api/admin/users", {
      username: uid("bob"),
      access: {
        [node]: { allowed_inbounds: ["reality"], allowed_outbounds: ["ghost"] },
      },
    });

    expect(badInbound.status).toBe(422);
    expect(badOutbound.status).toBe(422);
  });

  it("keeps a user assigned while the inbound is renamed and rebinding the row", async () => {
    const node = await makeNode();
    const user = uid("alice");
    const created = await planeJson("POST", "/api/admin/users", {
      username: user,
      access: {
        [node]: { allowed_inbounds: ["reality"], allowed_outbounds: ["niigata"] },
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);

    // The operator renames the tag in the authoured document. The old row is
    // orphaned; the new tag gets a fresh, unreferenced row.
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, {
      ...config(),
      inbounds: [
        {
          tag: "reality2",
          protocol: "vless",
          port: 443,
          settings: { clients: [] },
          streamSettings: {
            network: "raw",
            security: "reality",
            realitySettings: { serverNames: ["apple.com"], shortIds: ["1234"] },
          },
        },
      ],
    });
    const renamed = await inbounds(node);
    // Config order first (the new tag), the orphaned row last.
    expect(renamed.map((row) => [row.id, row.tag])).toEqual([
      ["reality2", "reality2"],
      ["reality", "reality"],
    ]);

    // Rebinding the old row to the new tag takes over the empty row; the
    // user's access (stored by id) still resolves.
    const patched = await planeJson(
      "PATCH",
      `/api/admin/nodes/${node}/inbounds/reality`,
      { tag: "reality2" },
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await body<InboundOut>(patched)).tag).toBe("reality2");
    expect((await inbounds(node)).map((row) => [row.id, row.tag])).toEqual([
      ["reality", "reality2"],
    ]);

    const runtime = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/config/runtime`,
    );
    const configBody = await body<{
      config: { inbounds: { tag: string; settings: { clients: unknown[] } }[] };
      warnings: string[];
    }>(runtime);
    expect(configBody.warnings).toEqual([]);
    expect(configBody.config.inbounds[0]!.tag).toBe(`reality2-${node}`);
    expect(configBody.config.inbounds[0]!.settings.clients).toHaveLength(1);
  });

  it("refuses to steal a tag another referenced row still owns", async () => {
    const second = {
      tag: "reality2",
      protocol: "vless",
      port: 444,
      settings: { clients: [] },
      streamSettings: { network: "raw", security: "reality", realitySettings: {} },
    };
    const node = await makeNode({
      ...config(),
      inbounds: [(config().inbounds as unknown[])[0], second],
    });
    await planeJson("POST", "/api/admin/users", {
      username: uid("alice"),
      access: {
        [node]: { allowed_inbounds: ["reality"], allowed_outbounds: ["niigata"] },
      },
    });

    const response = await planeJson(
      "PATCH",
      `/api/admin/nodes/${node}/inbounds/reality2`,
      { tag: "reality" },
    );

    expect(response.status).toBe(422);
    const detail = (await body<{ detail: string[] }>(response)).detail;
    expect(detail[0]).toContain("still has access");
  });

  it("deletes an orphaned row only when nothing holds it", async () => {
    const node = await makeNode();
    const declared = await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/inbounds/reality`,
    );
    expect(declared.status).toBe(409);

    // Render once: the choke point mints the panel-owned REALITY key.
    await planeJson("GET", `/api/admin/nodes/${node}/config/runtime`);
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, {
      ...config(),
      inbounds: [],
    });
    expect((await inbounds(node)).map((row) => row.tag)).toEqual(["reality"]);

    const referenced = await planeJson(
      "DELETE",
      `/api/admin/nodes/${node}/inbounds/reality`,
    );
    expect(referenced.status).toBe(409);
    expect((await body<{ detail: string[] }>(referenced)).detail[0]).toContain(
      "REALITY key",
    );

    // A row nothing references goes away: no key was ever minted here.
    const clean = await makeNode();
    await planeJson("PUT", `/api/admin/nodes/${clean}/config`, {
      ...config(),
      inbounds: [],
    });
    const deleted = await planeJson(
      "DELETE",
      `/api/admin/nodes/${clean}/inbounds/reality`,
    );
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    expect(await inbounds(clean)).toEqual([]);
  });

  it("renames an exit label and reflects it in generated links", async () => {
    const node = await makeNode();
    const user = uid("alice");
    await planeJson("POST", "/api/admin/users", {
      username: user,
      access: {
        [node]: { allowed_inbounds: ["reality"], allowed_outbounds: ["niigata"] },
      },
    });
    const before = await planeJson(
      "GET",
      `/api/admin/users/${user}/links`,
    );
    expect(
      (await body<{ links: { label: string }[] }>(before)).links[0]!.label,
    ).toBe("Tokyo 01 · REALITY → Niigata");

    const patched = await planeJson(
      "PATCH",
      `/api/admin/nodes/${node}/outbounds/niigata`,
      { label: "Osaka exit" },
    );
    expect(patched.status, await patched.clone().text()).toBe(200);

    const after = await planeJson("GET", `/api/admin/users/${user}/links`);
    expect(
      (await body<{ links: { label: string }[] }>(after)).links[0]!.label,
    ).toBe("Tokyo 01 · REALITY → Osaka exit");
  });

  it("422s a tag the config does not declare", async () => {
    const node = await makeNode();
    const response = await planeJson(
      "PATCH",
      `/api/admin/nodes/${node}/inbounds/reality`,
      { tag: "ghost" },
    );

    expect(response.status).toBe(422);
    expect((await body<{ detail: string[] }>(response)).detail[0]).toContain(
      "unknown inbound tag",
    );
  });

  it("serves 503 when a node has no config yet", async () => {
    const node = await makeNode(null);
    const response = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/inbounds`,
    );
    expect(response.status).toBe(503);
  });
});
