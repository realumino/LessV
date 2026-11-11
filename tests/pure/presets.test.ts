/**
 * The preset merge and the fragment builders, without a database.
 *
 * WHY pure tests: merging is a deterministic document transformation and
 * every preset's shape is its contract — the HTTP layer only adds routing
 * and error mapping on top.
 */

import { describe, expect, it } from "vitest";

import {
  BASE_CONFIG,
  buildPreset,
  geoBlockRules,
  mergeArrays,
  mergeFragment,
  presetDescriptors,
  realityInboundFragment,
  splitTokens,
} from "../../src/services/preset_service";

/** WHAT: a small authored document for merge tests. */
function document(): Record<string, unknown> {
  return {
    log: { loglevel: "warning", access: "" },
    inbounds: [
      { tag: "reality", protocol: "vless", port: 443 },
      { tag: "ws", protocol: "vless", port: 8080 },
    ],
    outbounds: [
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "direct", protocol: "freedom" },
    ],
    routing: { rules: [{ type: "field", domain: ["geosite:cn"], outboundTag: "direct" }] },
  };
}

describe("mergeFragment", () => {
  it("keeps the base skeleton's BLOCK fallback first", () => {
    const outbounds = BASE_CONFIG["outbounds"] as unknown[];
    expect(outbounds).toEqual([{ tag: "BLOCK", protocol: "blackhole" }]);
    const inbounds = BASE_CONFIG["inbounds"] as unknown[];
    expect(inbounds).toEqual([]);
  });

  it("replaces an array item by tag and appends a new one", () => {
    const merged = mergeFragment(document(), {
      inbounds: [
        { tag: "reality", port: 8443 },
        { tag: "grpc", protocol: "vless", port: 9443 },
      ],
    });
    const inbounds = merged["inbounds"] as Array<Record<string, unknown>>;
    expect(inbounds.map((entry) => entry["tag"])).toEqual(["reality", "ws", "grpc"]);
    expect(inbounds[0]).toMatchObject({ tag: "reality", protocol: "vless", port: 8443 });
  });

  it("appends rules without duplicating an identical one", () => {
    const rule = { type: "field", domain: ["geosite:cn"], outboundTag: "direct" };
    const merged = mergeFragment(document(), { routing: { rules: [rule, { type: "field", ip: ["geoip:cn"], outboundTag: "BLOCK" }] } });
    const rules = (merged["routing"] as Record<string, unknown>)["rules"] as unknown[];
    expect(rules).toHaveLength(2);
    expect(rules[1]).toEqual({ type: "field", ip: ["geoip:cn"], outboundTag: "BLOCK" });
  });

  it("merges objects recursively and never mutates the input", () => {
    const original = document();
    const merged = mergeFragment(original, { log: { loglevel: "debug" } });
    expect(merged["log"]).toEqual({ loglevel: "debug", access: "" });
    expect((original["log"] as Record<string, unknown>)["loglevel"]).toBe("warning");
  });

  it("creates a missing top-level key", () => {
    const merged = mergeFragment({ inbounds: [] }, { dns: { servers: ["1.1.1.1"] } });
    expect(merged["dns"]).toEqual({ servers: ["1.1.1.1"] });
  });

  it("replaces scalar arrays and merges object arrays", () => {
    const merged = mergeFragment(
      { alpn: ["h2", "http/1.1"], rules: [{ id: 1 }] },
      { alpn: ["h3"], rules: [{ id: 2 }] },
    );
    expect(merged["alpn"]).toEqual(["h3"]);
    expect(merged["rules"]).toEqual([{ id: 1 }, { id: 2 }]);
    expect(mergeArrays(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("the REALITY inbound preset", () => {
  it("produces an inbound fragment, not a whole config", () => {
    const [fragment, warnings] = realityInboundFragment({
      tag: "reality",
      domain: "vpn.example.org",
      socket: "/dev/shm/lessv-decoy.sock",
      shortId: "1234abcd",
      flow: "xtls-rprx-vision",
    });
    expect(warnings).toEqual([]);
    expect(Object.keys(fragment)).toEqual([
      "tag",
      "listen",
      "port",
      "protocol",
      "settings",
      "streamSettings",
    ]);
    expect(fragment).toMatchObject({
      tag: "reality",
      port: 443,
      protocol: "vless",
      settings: { clients: [], decryption: "none", flow: "xtls-rprx-vision" },
      streamSettings: {
        security: "reality",
        realitySettings: {
          dest: "/dev/shm/lessv-decoy.sock",
          serverNames: ["vpn.example.org"],
          privateKey: "",
          shortIds: ["1234abcd"],
          settings: { fingerprint: "chrome", spiderX: "/" },
        },
      },
    });
  });

  it("warns about an empty or plain-IP domain and a bad socket/shortId", () => {
    const [, warnings] = realityInboundFragment({
      domain: "203.0.113.5",
      socket: "tmp/decoy.sock",
      shortId: "abc",
    });
    expect(warnings).toEqual(
      expect.arrayContaining([
        "203.0.113.5 is an IP address — self-steal needs a domain plus a certificate",
        "nginx socket 'tmp/decoy.sock' must be an absolute path",
        "shortId 'abc' must be even-length hex",
      ]),
    );
    const [, empty] = realityInboundFragment({});
    expect(empty[0]).toContain("domain is empty");
  });
});

describe("the geo-block routing preset", () => {
  it("emits one ip rule and one domain rule", () => {
    const [rules, warnings] = geoBlockRules({
      countries: "cn, RU",
      categories: "category-ads-all, geolocation-!cn",
      target: "BLOCK",
    });
    expect(warnings).toEqual([]);
    expect(rules).toEqual([
      { type: "field", ip: ["geoip:cn", "geoip:ru"], outboundTag: "BLOCK" },
      {
        type: "field",
        domain: ["geosite:category-ads-all", "geosite:geolocation-!cn"],
        outboundTag: "BLOCK",
      },
    ]);
  });

  it("drops invalid tokens and warns when nothing remains", () => {
    expect(splitTokens("cn, c/../n, us", /^[A-Za-z0-9-]{1,16}$/)).toEqual([
      "cn",
      "us",
    ]);
    const [rules, warnings] = geoBlockRules({ countries: "!!", categories: "" });
    expect(rules).toEqual([]);
    expect(warnings).toContain("no valid countries or categories given; nothing was added");
  });

  it("warns when the target outbound is not declared", async () => {
    const [merged, warnings] = await buildPreset(
      "geo_block",
      document(),
      { countries: "cn", target: "nope" },
      fetch,
      new Date(),
    );
    expect(warnings.join(" ")).toContain("target outbound 'nope' is not declared");
    expect((merged["routing"] as Record<string, unknown>)["rules"]).toHaveLength(2);
  });

  it("starts from the base skeleton when no document is given", async () => {
    const [merged] = await buildPreset(
      "geo_block",
      null,
      { countries: "cn" },
      fetch,
      new Date(),
    );
    expect(merged["outbounds"]).toEqual([{ tag: "BLOCK", protocol: "blackhole" }]);
    expect((merged["routing"] as Record<string, unknown>)["rules"]).toHaveLength(1);
  });
});

describe("the preset catalog", () => {
  it("uses the node address as the REALITY domain default", () => {
    const presets = presetDescriptors("tokyo.example.org");
    const reality = presets.find((preset) => preset.id === "reality");
    expect(reality?.defaults["domain"]).toBe("tokyo.example.org");
    expect(reality?.defaults["shortId"]).toMatch(/^[0-9a-f]{8}$/);
    expect(presets.map((preset) => preset.id)).toEqual([
      "reality",
      "warp",
      "geo_block",
    ]);
  });
});
