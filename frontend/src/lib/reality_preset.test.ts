import { describe, expect, it } from "vitest";
import { buildRealityPreset, randomShortId } from "./reality_preset";

describe("buildRealityPreset", () => {
  it("builds the documented self-steal structure", () => {
    const { config, warnings } = buildRealityPreset({ domain: "tokyo01.example.com" });
    expect(warnings).toEqual([]);
    expect(config.log).toEqual({ loglevel: "warning" });
    const inbound = (config.inbounds as Array<Record<string, unknown>>)[0];
    expect(inbound).toMatchObject({
      tag: "reality",
      listen: "0.0.0.0",
      port: 443,
      protocol: "vless",
    });
    // WHAT: flow is the panel's inbound-declared convention (附录 A: inside
    // settings); share_service echoes it into links, the render copies it
    // onto allocated clients.
    expect((inbound.settings as Record<string, unknown>).flow).toBe("xtls-rprx-vision");
    const stream = inbound.streamSettings as Record<string, unknown>;
    const reality = stream.realitySettings as Record<string, unknown>;
    expect(stream).toMatchObject({ network: "tcp", security: "reality" });
    expect(reality).toMatchObject({
      dest: "/dev/shm/lessv-decoy.sock",
      serverNames: ["tokyo01.example.com"],
      privateKey: "",
      shortIds: [expect.stringMatching(/^[0-9a-f]{8}$/)],
    });
    expect(config.outbounds).toEqual([
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "direct", protocol: "freedom" },
    ]);
    expect(config.routing).toEqual({ rules: [] });
  });

  it("honors explicit fields", () => {
    const { config } = buildRealityPreset({
      domain: "a.example.com",
      socketPath: "/run/lessv/decoy.sock",
      shortId: "abcd1234",
      flow: "none",
      tag: "tls-in",
    });
    const inbound = (config.inbounds as Array<Record<string, unknown>>)[0];
    expect(inbound.tag).toBe("tls-in");
    expect((inbound.settings as Record<string, unknown>).flow).toBe("none");
    expect(
      ((inbound.streamSettings as Record<string, unknown>).realitySettings as Record<string, unknown>).dest,
    ).toBe("/run/lessv/decoy.sock");
    expect(
      ((inbound.streamSettings as Record<string, unknown>).realitySettings as Record<string, unknown>).shortIds,
    ).toEqual(["abcd1234"]);
  });

  it("warns on empty domains and IP addresses without blocking", () => {
    const empty = buildRealityPreset({ domain: "" });
    expect(empty.warnings).toHaveLength(1);
    expect(
      ((empty.config.inbounds as Array<Record<string, unknown>>)[0]
        .streamSettings as Record<string, unknown>).realitySettings,
    ).toMatchObject({ serverNames: [] });

    const ip = buildRealityPreset({ domain: "203.0.113.7" });
    expect(ip.warnings[0]).toContain("IP address");
    expect(
      ((ip.config.inbounds as Array<Record<string, unknown>>)[0]
        .streamSettings as Record<string, unknown>).realitySettings,
    ).toMatchObject({ serverNames: ["203.0.113.7"] });
  });

  it("warns on a relative socket path and bad shortIds", () => {
    const badSocket = buildRealityPreset({ domain: "a.example.com", socketPath: "decoy.sock" });
    expect(badSocket.warnings.some((warning) => warning.includes("absolute"))).toBe(true);
    const badSid = buildRealityPreset({ domain: "a.example.com", shortId: "xyz" });
    expect(badSid.warnings.some((warning) => warning.includes("shortId"))).toBe(true);
  });

  it("mints distinct 8-hex shortIds", () => {
    const a = randomShortId();
    const b = randomShortId();
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});
