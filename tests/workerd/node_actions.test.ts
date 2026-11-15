/**
 * Node maintenance actions: request, advertise, execute, report.
 *
 * WHY over HTTP: the action queue is part of the node contract — an admin
 * request must reach the node on its next heartbeat and the reported outcome
 * must leave the fleet view without a pending command. The node-side
 * download itself is covered by the server's tests; here a fake node plays
 * the server's role exactly as protocol 3 defines it.
 *
 * WHY `update_xray` appears only as a *report*: Xray ships inside the node
 * image, so the plane stopped requesting binary updates. A deployed 0.6.0
 * server may still answer a row written before that change, and the endpoint
 * has to stay idempotent for it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { NodeSyncOut } from "../../src/models";
import { planeFetch, planeJson, uid } from "../helpers";

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

  it("adopts the versions a heartbeat reports", async () => {
    await heartbeat({
      agent_version: "0.6.0",
      xray_version: "26.11.9",
      geodata_version: "20261110230135",
    });
    const state = await sync();
    expect(state.agent_version).toBe("0.6.0");
    expect(state.xray_version).toBe("26.11.9");
    expect(state.geodata_version).toBe("20261110230135");

    // A missing field is "no report", not "forget it".
    await heartbeat({ applied_hash: state.applied_hash });
    const again = await sync();
    expect(again.agent_version).toBe("0.6.0");
    expect(again.geodata_version).toBe("20261110230135");
  });

  it("runs the lifecycle of a geodata refresh", async () => {
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

  it("keeps a failed geodata refresh's version and surfaces its message", async () => {
    await planeJson("POST", `/api/admin/nodes/${node}/geodata-update`);
    await heartbeat({ geodata_version: "20261110230135", xray_version: "26.11.9" });

    const reported = await report({
      action: "update_geodata",
      ok: false,
      error: "sha256 mismatch",
    });
    expect(reported.status).toBe(200);

    const state = await sync();
    expect(state.geodata_version).toBe("20261110230135");
    expect(state.xray_version).toBe("26.11.9");
    expect(state.actions).toEqual([
      expect.objectContaining({
        action: "update_geodata",
        state: "failed",
        message: "sha256 mismatch",
      }),
    ]);
    // A finished action is history, not a command.
    expect((await heartbeat()).actions).toEqual([]);
  });

  it("replaces a previous request instead of stacking a second one", async () => {
    await planeJson("POST", `/api/admin/nodes/${node}/geodata-update`);
    await planeJson("POST", `/api/admin/nodes/${node}/geodata-update`);

    expect((await heartbeat()).actions).toEqual([{ action: "update_geodata" }]);
    const state = await sync();
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0]).toMatchObject({ state: "pending" });
  });

  it("accepts an update_xray result for an action the plane no longer tracks", async () => {
    const before = await sync();
    expect(before.actions).toEqual([]);

    // Exactly what a 0.6.0 server sends when it finishes a legacy row.
    const reported = await report({
      action: "update_xray",
      ok: true,
      version: "v26.11.9",
    });
    expect(reported.status, await reported.clone().text()).toBe(200);

    // The report is not refused and invents no row.
    const after = await sync();
    expect(after.actions).toEqual([]);
    expect(after.xray_version).toBe("v26.11.9");
    expect((await heartbeat()).actions).toEqual([]);
  });

  it("no longer offers a request endpoint for binary updates", async () => {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/xray-update`,
      { version: "latest" },
    );
    expect(response.status).toBe(404);

    // The admin key gate runs before routing: an unauthenticated call is 401,
    // never a 404 that would confirm the route is gone.
    const anonymous = await planeFetch(
      "/api/admin/nodes/some-node/xray-update",
      { method: "POST", headers: { Authorization: "" } },
    );
    expect(anonymous.status).toBe(401);
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
