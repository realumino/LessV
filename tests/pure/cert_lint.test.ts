/**
 * Pure tests for cert lint: SAN coverage (exact + wildcard), dest
 * grading, shortIds, expiry tiers, and nginx health.
 */

import { describe, expect, it } from "vitest";
import {
  certLintWarnings,
  destIsLocalSocket,
  realityInbounds,
  sanCovers,
  shortIdsValid,
} from "../../src/cert/lint";

const NOW = new Date("2026-03-01T00:00:00.000Z");
const isoInDays = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

function realityInbound(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: "reality",
    listen: "0.0.0.0",
    port: 443,
    protocol: "vless",
    settings: { clients: [], decryption: "none" },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        dest: "/dev/shm/lessv-decoy.sock",
        serverNames: ["tokyo01.example.com"],
        shortIds: ["abcd1234"],
        privateKey: "x",
        settings: { fingerprint: "chrome", spiderX: "/" },
      },
      ...(overrides.streamSettings ?? {}),
    },
    ...overrides,
  };
}

describe("sanCovers", () => {
  it("matches exact names case-insensitively", () => {
    expect(sanCovers("Tokyo01.Example.com", "tokyo01.example.com")).toBe(true);
    expect(sanCovers("a.example.com", "b.example.com")).toBe(false);
  });

  it("wildcards cover exactly one label", () => {
    expect(sanCovers("a.example.com", "*.example.com")).toBe(true);
    expect(sanCovers("example.com", "*.example.com")).toBe(false);
    expect(sanCovers("a.b.example.com", "*.example.com")).toBe(false);
  });
});

describe("REALITY field checks", () => {
  it("accepts a self-steal inbound with no warnings", () => {
    const warnings = certLintWarnings({
      config: { inbounds: [realityInbound()] },
      certs: [{ domain: "tokyo01.example.com", sans: ["tokyo01.example.com"], not_after: isoInDays(30) }],
      node: { nginx_ok: 1, nginx_error: null },
      now: NOW,
    });
    expect(warnings).toEqual([]);
  });

  it("flags empty serverNames, public dests, and bad shortIds", () => {
    const config = {
      inbounds: [
        realityInbound({
          streamSettings: {
            network: "tcp",
            security: "reality",
            realitySettings: {
              dest: "www.microsoft.com:443",
              serverNames: [],
              shortIds: ["xyz"], // odd length
            },
          },
        }),
      ],
    };
    const warnings = certLintWarnings({
      config,
      certs: [],
      node: { nginx_ok: 1, nginx_error: null },
      now: NOW,
    });
    expect(warnings).toEqual([
      "reality inbound 'reality' has no serverNames",
      "reality inbound 'reality' dest 'www.microsoft.com:443' is not the local Unix socket the decoy listens on",
      "reality inbound 'reality' has invalid shortIds",
    ]);
  });

  it("flags serverNames not covered by assigned certificates", () => {
    const warnings = certLintWarnings({
      config: { inbounds: [realityInbound({ tag: "r2" })] },
      certs: [{ domain: "other.example.com", sans: ["other.example.com"], not_after: isoInDays(30) }],
      node: { nginx_ok: 1, nginx_error: null },
      now: NOW,
    });
    expect(warnings).toEqual([
      "serverNames 'tokyo01.example.com' is not covered by an assigned certificate",
    ]);
  });

  it("wildcard SAN covers the serverName", () => {
    const warnings = certLintWarnings({
      config: { inbounds: [realityInbound()] },
      certs: [{ domain: "*.example.com", sans: ["*.example.com"], not_after: isoInDays(30) }],
      node: { nginx_ok: 1, nginx_error: null },
      now: NOW,
    });
    expect(warnings).toEqual([]);
  });
});

describe("expiry grading", () => {
  it("expired, strong-warn, and info tiers", () => {
    const warnings = certLintWarnings({
      config: null,
      certs: [
        { domain: "a.example.com", sans: [], not_after: isoInDays(-1) },
        { domain: "b.example.com", sans: [], not_after: isoInDays(6) },
        { domain: "c.example.com", sans: [], not_after: isoInDays(14) },
        { domain: "d.example.com", sans: [], not_after: isoInDays(20) },
      ],
      node: { nginx_ok: 1, nginx_error: null },
      now: NOW,
    });
    expect(warnings).toEqual([
      "certificate for 'a.example.com' expired at " + isoInDays(-1),
      "certificate for 'b.example.com' expires in 6 day(s)",
      "certificate for 'c.example.com' expires in 14 day(s)",
    ]);
  });
});

describe("nginx health", () => {
  it("flags a stored nginx failure with its error", () => {
    const warnings = certLintWarnings({
      config: null,
      certs: [],
      node: { nginx_ok: 0, nginx_error: "nginx: configuration file test failed" },
      now: NOW,
    });
    expect(warnings).toEqual([
      "nginx is not healthy: nginx: configuration file test failed",
    ]);
  });

  it("stays silent for nginx_ok null or 1", () => {
    for (const nginx_ok of [null, 1]) {
      expect(
        certLintWarnings({
          config: null,
          certs: [],
          node: { nginx_ok, nginx_error: null },
          now: NOW,
        }),
      ).toEqual([]);
    }
  });
});

describe("helpers", () => {
  it("destIsLocalSocket and shortIdsValid shapes", () => {
    expect(destIsLocalSocket("/dev/shm/lessv-decoy.sock")).toBe(true);
    expect(destIsLocalSocket("/run/../etc/passwd")).toBe(false);
    expect(destIsLocalSocket("127.0.0.1:8443")).toBe(false);
    expect(destIsLocalSocket("localhost:8443")).toBe(false);
    expect(destIsLocalSocket("")).toBe(false);
    expect(shortIdsValid(["abcd1234", "ef", ""])).toBe(true);
    expect(shortIdsValid(["abc"])).toBe(false);
    expect(shortIdsValid("nope")).toBe(false);
    expect(shortIdsValid(["gh"])).toBe(false);
  });

  it("realityInbounds only returns vless+reality entries", () => {
    const config = {
      inbounds: [
        realityInbound(),
        { tag: "plain", protocol: "vless", streamSettings: { network: "tcp" } },
      ],
    };
    expect(realityInbounds(config)).toHaveLength(1);
    expect(realityInbounds(null)).toEqual([]);
  });
});
