import { describe, expect, it } from "vitest";
import {
  certTone,
  daysUntilIso,
  expiryText,
  isStaging,
  nearestCert,
} from "./cert";

const NOW = new Date("2026-03-01T00:00:00Z");
const iso = (days: number) =>
  new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

describe("daysUntilIso", () => {
  it("floors whole days and grades tones", () => {
    expect(daysUntilIso(iso(45), NOW)).toBe(45);
    expect(daysUntilIso(iso(-1), NOW)).toBe(-1);
    expect(daysUntilIso(iso(0.5), NOW)).toBe(0);
    expect(daysUntilIso("not-a-date", NOW)).toBeNull();
  });

  it("certTone tiers mirror the lint rules", () => {
    expect(certTone(null)).toBe("idle");
    expect(certTone(-1)).toBe("bad");
    expect(certTone(0)).toBe("bad");
    expect(certTone(6)).toBe("warn");
    expect(certTone(7)).toBe("ok");
    expect(certTone(45)).toBe("ok");
  });

  it("expiryText", () => {
    expect(expiryText(null)).toBe("—");
    expect(expiryText(-1)).toBe("expired");
    expect(expiryText(15)).toBe("15d");
  });

  it("isStaging", () => {
    expect(isStaging("staging")).toBe(true);
    expect(isStaging("production")).toBe(false);
  });

  it("nearestCert picks the smallest positive/negative day count", () => {
    const certs = [
      { domain: "a.example.com", not_after: iso(20) },
      { domain: "b.example.com", not_after: iso(3) },
      { domain: "gone.example.com", not_after: "garbage" },
    ];
    expect(nearestCert(certs, NOW)).toEqual({ domain: "b.example.com", days: 3 });
    expect(nearestCert([], NOW)).toBeNull();
  });
});
