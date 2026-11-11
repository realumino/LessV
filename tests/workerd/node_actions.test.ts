/**
 * Node maintenance actions: request, advertise, execute, report.
 *
 * WHY over HTTP: the action queue is part of the node contract — an admin
 * request must reach the node on its next heartbeat and the reported outcome
 * must leave the fleet view without a pending command. The node-side
 * download itself is covered by the Rust tests; here the fake node plays the
 * node's role exactly as protocol 3 defines it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { NodeActionOut, NodeSyncOut } from "../../src/models";
import { planeJson, uid } from "../helpers";

/** WHAT: one heartbeat response as the endpoint returns it. */
type HeartbeatOut = { desired_hash: string | null; actions: Array<Record<string, unknown>> };

describe("node maintenance actions", () => {
  let node: string;
  let token: string;

  beforeEach(async () => {
    node = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Node",
    });
    expect(created.status).toBe(201);
    const minted = await planeJson("POST", `/api/admin/nodes/${node}/token`);
    token = ((await minted.json()) as { token: string }).token;
  });

  function auth(): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "X-Lessv-Node": node };
  }

  async function heartbeat(
    extra: Record<string, unknown> = {},
  ): Promise<HeartbeatOut> {
    const response = await planeJson(
      "POST",
      "/api/node/heartbeat",
      { protocol: 3, ...extra },
      auth(),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as HeartbeatOut;
  }

  async function sync(): Promise<NodeSyncOut> {
    const response = await planeJson("GET", `/api/admin/nodes/${node}/sync`);
    expect(response.status).toBe(200);
    return (await response.json()) as NodeSyncOut;
  }

  async function report(body: Record<string, unknown>): Promise<Response> {
    return planeJson("POST", "/api/node/action", { protocol: 3, ...body }, auth());
  }

  it("advertises a requested Xray update until it is reported", async () => {
    expect((await heartbeat()).actions).toEqual([]);

    const requested = await planeJson("POST", `/api/admin/nodes/${node}/xray-update`, {
      version: "latest",
    });
    expect(requested.status, await requested.clone().text()).toBe(201);
    const actions = (await requested.json()) as NodeActionOut[];
    expect(actions).toEqual([
      expect.objectContaining({
        action: "update_xray",
        state: "pending",
        target: "latest",
      }),
    ]);

    expect((await heartbeat()).actions).toEqual([
      { action: "update_xray", version: "latest" },
    ]);

    const reported = await report({
      action: "update_xray",
      ok: true,
      version: "v26.11.9",
    });
    expect(reported.status, await reported.clone().text()).toBe(200);

    // The node's next heartbeat repeats the fact; the plane adopts it.
    const beat = await heartbeat({ xray_version: "v26.11.9" });
    expect(beat.actions).toEqual([]);
    const state = await sync();
    expect(state.xray_version).toBe("v26.11.9");
    expect(state.actions).toEqual([
      expect.objectContaining({ action: "update_xray", state: "ok", message: null }),
    ]);
  });

  it("keeps a failed update's version and surfaces its message", async () => {
    await planeJson("POST", `/api/admin/nodes/${node}/xray-update`, {
      version: "v26.11.9",
    });
    await heartbeat({ xray_version: "v25.1.1" });

    const reported = await report({
      action: "update_xray",
      ok: false,
      error: "sha256 mismatch",
    });
    expect(reported.status).toBe(200);

    const state = await sync();
    expect(state.xray_version).toBe("v25.1.1");
    expect(state.actions).toEqual([
      expect.objectContaining({
        action: "update_xray",
        state: "failed",
        message: "sha256 mismatch",
      }),
    ]);
    // A finished action is history, not a command.
    expect((await heartbeat()).actions).toEqual([]);
  });

  it("runs the same lifecycle for a geodata refresh", async () => {
    const requested = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/geodata-update`,
    );
    expect(requested.status, await requested.clone().text()).toBe(201);
    expect((await heartbeat()).actions).toEqual([{ action: "update_geodata" }]);

    const reported = await report({
      action: "update_geodata",
      ok: true,
      version: "20261110230135",
    });
    expect(reported.status).toBe(200);

    const state = await sync();
    expect(state.geodata_version).toBe("20261110230135");
    expect((await heartbeat()).actions).toEqual([]);
  });

  it("replaces a previous request instead of stacking a second one", async () => {
    await planeJson("POST", `/api/admin/nodes/${node}/xray-update`, {
      version: "v26.11.9",
    });
    await planeJson("POST", `/api/admin/nodes/${node}/xray-update`, {
      version: "latest",
    });

    expect((await heartbeat()).actions).toEqual([
      { action: "update_xray", version: "latest" },
    ]);
    const state = await sync();
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]).toMatchObject({ state: "pending", target: "latest" });
  });

  it("rejects a malformed version and an unknown node", async () => {
    const bad = await planeJson("POST", `/api/admin/nodes/${node}/xray-update`, {
      version: "nightly",
    });
    expect(bad.status).toBe(422);

    const missing = await planeJson(
      "POST",
      "/api/admin/nodes/ghost/xray-update",
      { version: "latest" },
    );
    expect(missing.status).toBe(404);
  });

  it("401s an action report with no node credentials", async () => {
    const response = await planeJson("POST", "/api/node/action", {
      protocol: 3,
      action: "update_geodata",
      ok: true,
    });
    expect(response.status).toBe(401);
  });
});
