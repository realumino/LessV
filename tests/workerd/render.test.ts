/**
 * Render invariants over the admin runtime pane and the sync view.
 *
 * Ported from tests/workerd/test_render.py with its assertions intact: the
 * render service has no direct API of its own — its output is what the
 * runtime pane shows and what an agent fetches — so the unique invariants
 * carry over as HTTP tests: deterministic hashing, per-node independence,
 * storage stays local, and malformed configs warn instead of breaking.
 */

import { describe, expect, it } from "vitest";

import type { NodeSyncOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/** WHAT: an authored config with local tags, in the shape an admin pastes. */
function config(outboundTag = "niigata"): Record<string, unknown> {
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
          realitySettings: { privateKey: "operator-key" },
        },
      },
    ],
    outbounds: [{ tag: outboundTag, protocol: "freedom" }],
  };
}

/** WHAT: a rendered config as the runtime pane returns it. */
type RuntimeOut = {
  config: {
    inbounds: {
      tag: string;
      settings: { clients: { email: string }[] };
    }[];
    routing: { rules: Record<string, unknown>[] };
  };
  hash: string;
  warnings: string[];
};

/** WHAT: parse one response body as a model shape. */
async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("render invariants", () => {
  /** WHAT: create one node via the API and return its id. */
  async function makeNode(label = "node"): Promise<string> {
    const node = uid("n");
    const response = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: label === "node" ? node : label,
      address: "funky.example.com",
    });
    expect(response.status).toBe(201);
    return node;
  }

  /** WHAT: create a user with reality/niigata access via the API. */
  function makeUser(
    nodeId: string,
    status?: string,
  ): Promise<Response> {
    const payload: Record<string, unknown> = {
      username: uid("alice"),
      access: {
        [nodeId]: {
          allowed_inbounds: ["reality"],
          allowed_outbounds: ["niigata"],
        },
      },
    };
    if (status) {
      payload["status"] = status;
    }
    return planeJson("POST", "/api/admin/users", payload);
  }

  /** WHAT: GET one node's runtime pane body. */
  async function runtime(nodeId: string): Promise<RuntimeOut> {
    const response = await planeJson(
      "GET",
      `/api/admin/nodes/${nodeId}/config/runtime`,
    );
    return body<RuntimeOut>(response);
  }

  it("excludes a disabled user from clients", async () => {
    const node = await makeNode();
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    await makeUser(node, "active");
    const disabled = await makeUser(node, "disabled");

    const pane = await runtime(node);

    expect(disabled.status).toBe(201);
    const clients = pane.config.inbounds[0]!.settings.clients;
    expect(clients).toHaveLength(1);
    expect(clients[0]!.email.endsWith(`@${node}-niigata`)).toBe(true);
  });

  it("copies an inbound-declared flow onto allocated clients", async () => {
    // WHY: Xray enforces VLESS flow per client; the operator declares it
    // once on the inbound (share_service echoes it into links). The render
    // must close that gap or advertised vision links fail handshakes.
    const node = await makeNode();
    const declared = config();
    (declared.inbounds as Array<Record<string, unknown>>)[0]!.settings = {
      clients: [],
      flow: "xtls-rprx-vision",
    };
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, declared);
    await makeUser(node, "active");

    const pane = await runtime(node);

    const clients = pane.config.inbounds[0]!.settings.clients as Array<{
      email: string;
      flow?: string;
    }>;
    expect(clients).toHaveLength(1);
    expect(clients[0]!.flow).toBe("xtls-rprx-vision");
  });

  it("skips a malformed config with a warning", async () => {
    const node = await makeNode();
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, {
      inbounds: "not a list",
    });

    const response = await planeJson("GET", `/api/admin/nodes/${node}/sync`);
    const sync = await body<NodeSyncOut>(response);

    expect(sync.desired_hash).toBeNull();
    expect(sync.warnings).toHaveLength(1);
    expect(sync.warnings[0]).toContain("malformed");
  });

  it("renders per node independently", async () => {
    const node = await makeNode();
    const other = await makeNode();
    await planeJson(
      "PUT",
      `/api/admin/nodes/${other}/config`,
      config("other"),
    );
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    await makeUser(node);
    await makeUser(other);

    const mine = (await runtime(node)).config;
    const theirs = (await runtime(other)).config;

    expect(mine.routing.rules).toEqual([
      { user: [`regexp:.*@${node}-niigata$`], outboundTag: `${node}-niigata` },
    ]);
    expect(theirs.routing.rules).toEqual([
      { user: [`regexp:.*@${other}-other$`], outboundTag: `${other}-other` },
    ]);
  });

  it("keeps storage local and the runtime qualified", async () => {
    const node = await makeNode();
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    await makeUser(node);

    const storedResponse = await planeJson(
      "GET",
      `/api/admin/nodes/${node}/config`,
    );
    const stored = await body<{ inbounds: { tag: string }[] }>(storedResponse);
    const pane = await runtime(node);

    expect(stored.inbounds[0]!.tag).toBe("reality");
    expect(pane.config.inbounds[0]!.tag).toBe(`reality-${node}`);
    expect(JSON.stringify(stored)).not.toContain(`reality-${node}`);
  });

  it("normalises the rendered transport and leaves the authored document alone", async () => {
    // WHY: Xray renamed the transport to `raw`; the plane emits the current
    // name so the node's applied config does not depend on the synonym an
    // operator pasted. The authored document is the operator's text — it must
    // stay exactly as saved, and the hash must cover what is actually served.
    const node = await makeNode();
    const authored = config();
    const inbound = (authored.inbounds as Record<string, unknown>[])[0]!;
    const stream = inbound["streamSettings"] as Record<string, unknown>;
    stream["network"] = "tcp";
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, authored);
    await makeUser(node);

    const stored = await body<{
      inbounds: { streamSettings: { network: string } }[];
    }>(await planeJson("GET", `/api/admin/nodes/${node}/config`));
    expect(stored.inbounds[0]!.streamSettings.network).toBe("tcp");

    const pane = await body<{
      config: { inbounds: { streamSettings: { network: string } }[] };
      hash: string;
    }>(await planeJson("GET", `/api/admin/nodes/${node}/config/runtime`));
    expect(pane.config.inbounds[0]!.streamSettings.network).toBe("raw");

    const sync = await body<NodeSyncOut>(
      await planeJson("GET", `/api/admin/nodes/${node}/sync`),
    );
    expect(sync.desired_hash).toBe(pane.hash);
  });

  it("renders the same hash for the same state", async () => {
    const node = await makeNode();
    await planeJson("PUT", `/api/admin/nodes/${node}/config`, config());
    await makeUser(node);

    const first = await runtime(node);
    const second = await runtime(node);

    expect(first.hash).toBe(second.hash);
  });
});
