/**
 * Pure tests for the subscription payload encoder.
 *
 * WHY these assertions matter: the base64 body is the subscription contract
 * — every client decodes it with the standard alphabet and expects a
 * newline-joined URI list. Alphabet, padding, join, and UTF-8 handling are
 * the observable bytes, so they are pinned here without a database.
 */

import { describe, expect, it } from "vitest";

import {
  encodeSubscription,
  profileTitleHeader,
  subscriptionFormat,
} from "../../src/services/subscription_service";

/** WHAT: decode standard base64 into a UTF-8 string (the client's view). */
function decode(body: string): string {
  const binary = atob(body);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

describe("encodeSubscription", () => {
  it("encodes an empty list as the empty string", () => {
    expect(encodeSubscription([])).toBe("");
  });

  it("encodes one URI with no newline", () => {
    const body = encodeSubscription(["vless://a@h:443?x=1#one"]);
    expect(decode(body)).toBe("vless://a@h:443?x=1#one");
  });

  it("joins URIs with newlines and no trailing newline", () => {
    const body = encodeSubscription(["vless://one", "vless://two"]);
    expect(decode(body)).toBe("vless://one\nvless://two");
  });

  it("uses the standard alphabet with padding", () => {
    const body = encodeSubscription(["vless://a", "vless://b"]);
    expect(body).not.toContain("-");
    expect(body).not.toContain("_");
    expect(body.endsWith("=") || body.length % 4 === 0).toBe(true);
  });

  it("encodes non-ASCII as UTF-8 instead of throwing", () => {
    // btoa would throw on this; TextEncoder must not.
    const body = encodeSubscription(["vless://u@exämple.com:443#日本"]);
    expect(decode(body)).toBe("vless://u@exämple.com:443#日本");
  });
});

describe("subscriptionFormat", () => {
  it("picks the format from the user agent", () => {
    expect(subscriptionFormat(null, "clash-verge/v2.4.2")).toBe("clash");
    expect(subscriptionFormat(null, "ClashX Pro/1.9.0.1")).toBe("clash");
    expect(subscriptionFormat(null, "mihomo/1.19.30")).toBe("clash");
    expect(subscriptionFormat(null, "Stash/2.5.2")).toBe("clash");
    expect(subscriptionFormat(null, "v2rayN/6.61")).toBe("uri");
    expect(subscriptionFormat(null, null)).toBe("uri");
  });

  it("lets the target parameter override the user agent", () => {
    expect(subscriptionFormat("clash", "v2rayN/6.61")).toBe("clash");
    expect(subscriptionFormat("mihomo", null)).toBe("clash");
    expect(subscriptionFormat("yaml", null)).toBe("clash");
    expect(subscriptionFormat("uri", "clash-verge/v2.4.2")).toBe("uri");
    expect(subscriptionFormat("base64", "mihomo/1.19.30")).toBe("uri");
    expect(subscriptionFormat("CLASH", null)).toBe("clash");
  });

  it("falls back to the user agent for an unknown target", () => {
    expect(subscriptionFormat("clsh", "clash-verge/v2.4.2")).toBe("clash");
    expect(subscriptionFormat("clsh", "curl/8.7.1")).toBe("uri");
  });
});

describe("profileTitleHeader", () => {
  it("encodes a non-ASCII title as base64 after the marker", () => {
    const header = profileTitleHeader("东京 · alice");
    expect(header).toMatch(/^base64:/);
    const bytes = Uint8Array.from(atob(header!.slice("base64:".length)), (char) =>
      char.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toBe("东京 · alice");
  });

  it("sends no header for an empty or blank title", () => {
    expect(profileTitleHeader("")).toBeNull();
    expect(profileTitleHeader("   ")).toBeNull();
    expect(profileTitleHeader(String.fromCharCode(10))).toBeNull();
  });

  it("keeps a plain ASCII title intact after decoding", () => {
    const header = profileTitleHeader("Tokyo 01 · alice");
    const bytes = Uint8Array.from(atob(header!.slice("base64:".length)), (char) =>
      char.charCodeAt(0),
    );
    expect(new TextDecoder().decode(bytes)).toBe("Tokyo 01 · alice");
  });
});
