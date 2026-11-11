/**
 * The preset API: catalog, merge, and the WARP registration route.
 *
 * WHY over HTTP: the SPA sends the editor's draft and receives the merged
 * document, so the request shape (base skeleton, per-node defaults, 404 for
 * an unknown preset) is the contract the config page relies on. The WARP
 * registration is answered by the test outbound mock with a canned device.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { planeJson, uid } from "../helpers";

/** WHAT: one preset build response. */
type PresetBuildOut = {
  config: Record<string, unknown>;
  warnings: string[];
};

/** WHAT: the preset catalog response. */
type PresetListOut = {
  base: Record<string, unknown>;
  presets: Array<{
    id: string;
    label: string;
    summary: string;
    fields: Array<{ name: string; label: string }>;
    defaults: Record<string, string>;
  }>;
};

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("the preset catalog", () => {
  let node: string;

  beforeEach(async () => {
    node = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: node,
      label: "Node",
      address: "tokyo.example.org",
    });
    expect(created.status).toBe(201);
  });

  it("describes the presets and the base skeleton", async () => {
    const response = await planeJson("GET", `/api/admin/nodes/${node}/presets`);
    expect(response.status, await response.clone().text()).toBe(200);
    const catalog = await body<PresetListOut>(response);

    expect(catalog.base).toEqual({
      log: { loglevel: "warning" },
      inbounds: [],
      outbounds: [{ tag: "BLOCK", protocol: "blackhole" }],
      routing: { rules: [] },
    });
    expect(catalog.presets.map((preset) => preset.id)).toEqual([
      "reality",
      "warp",
      "geo_block",
    ]);
    const reality = catalog.presets[0];
    expect(reality.defaults["domain"]).toBe("tokyo.example.org");
    expect(reality.fields.map((field) => field.name)).toEqual([
      "tag",
      "domain",
      "socket",
      "shortId",
      "flow",
    ]);
  });

  it("404s the catalog for an unknown node", async () => {
    const response = await planeJson("GET", "/api/admin/nodes/ghost/presets");
    expect(response.status).toBe(404);
  });

  it("builds a REALITY inbound onto the base skeleton", async () => {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/reality`,
      {
        config: null,
        options: {
          tag: "reality",
          domain: "tokyo.example.org",
          socket: "/dev/shm/lessv-decoy.sock",
          shortId: "1234abcd",
          flow: "xtls-rprx-vision",
        },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);

    expect(result.warnings).toEqual([]);
    expect(result.config["outbounds"]).toEqual([
      { tag: "BLOCK", protocol: "blackhole" },
    ]);
    const inbounds = result.config["inbounds"] as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]).toMatchObject({
      tag: "reality",
      port: 443,
      streamSettings: {
        realitySettings: { serverNames: ["tokyo.example.org"], privateKey: "" },
      },
    });
  });

  it("replaces the same inbound tag instead of appending a duplicate", async () => {
    const first = await body<PresetBuildOut>(
      await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
        config: null,
        options: { tag: "reality", domain: "one.example.org", shortId: "aa" },
      }),
    );
    const second = await body<PresetBuildOut>(
      await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
        config: first.config,
        options: { tag: "reality", domain: "two.example.org", shortId: "bb" },
      }),
    );
    const inbounds = second.config["inbounds"] as Array<Record<string, unknown>>;
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]["streamSettings"]).toMatchObject({
      realitySettings: { serverNames: ["two.example.org"], shortIds: ["bb"] },
    });
  });

  it("adds geo-block rules next to the document's own rules", async () => {
    const authored = {
      inbounds: [],
      outbounds: [
        { tag: "BLOCK", protocol: "blackhole" },
        { tag: "direct", protocol: "freedom" },
      ],
      routing: { rules: [{ type: "field", domain: ["geosite:cn"], outboundTag: "direct" }] },
    };
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/geo_block`,
      {
        config: authored,
        options: { countries: "cn", categories: "category-ads-all", target: "BLOCK" },
      },
    );
    expect(response.status).toBe(200);
    const result = await body<PresetBuildOut>(response);
    const rules = (result.config["routing"] as Record<string, unknown>)[
      "rules"
    ] as unknown[];
    expect(rules).toHaveLength(3);
    expect(rules[1]).toEqual({
      type: "field",
      ip: ["geoip:cn"],
      outboundTag: "BLOCK",
    });
    expect(rules[2]).toEqual({
      type: "field",
      domain: ["geosite:category-ads-all"],
      outboundTag: "BLOCK",
    });
    expect(result.warnings).toEqual([]);
  });

  it("registers a WARP device and returns a wireguard outbound", async () => {
    const response = await planeJson(
      "POST",
      `/api/admin/nodes/${node}/presets/warp`,
      { config: null, options: { tag: "warp" } },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await body<PresetBuildOut>(response);
    const outbounds = result.config["outbounds"] as Array<Record<string, unknown>>;
    expect(outbounds.map((entry) => entry["tag"])).toEqual(["BLOCK", "warp"]);
    const warp = outbounds[1] as {
      protocol: string;
      settings: Record<string, unknown>;
    };
    expect(warp.protocol).toBe("wireguard");
    expect(warp.settings["reserved"]).toEqual([81, 81, 220]);
    expect(warp.settings["noKernelTun"]).toBe(true);
    expect(warp.settings["address"]).toEqual([
      "172.16.0.2/32",
      "2606:4700:110:8a78:72d9:6e7f:da52:294f/128",
    ]);
  });

  it("404s an unknown preset and 422s a non-object document", async () => {
    expect(
      (
        await planeJson("POST", `/api/admin/nodes/${node}/presets/nope`, {
          config: null,
          options: {},
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await planeJson("POST", `/api/admin/nodes/${node}/presets/reality`, {
          config: [1, 2],
          options: {},
        })
      ).status,
    ).toBe(422);
  });
});
