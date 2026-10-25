/**
 * Pins for the admin key's browser state: storage round-trip and the
 * change notification the app shell depends on.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  clearAdminKey,
  getAdminKey,
  onAuthChange,
  setAdminKey,
} from "./auth";

/** A Map-backed localStorage stand-in, installed the way tests see it. */
function withStorage<T>(fn: () => T): T {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
  try {
    return fn();
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("admin key state", () => {
  it("round-trips a key through storage", () => {
    withStorage(() => {
      expect(getAdminKey()).toBeNull();
      setAdminKey("k-123");
      expect(getAdminKey()).toBe("k-123");
    });
  });

  it("clear removes the key", () => {
    withStorage(() => {
      setAdminKey("k-123");
      clearAdminKey();
      expect(getAdminKey()).toBeNull();
    });
  });

  it("notifies subscribers on set and clear, and unsubscribe stops it", () => {
    withStorage(() => {
      const seen: string[] = [];
      const stop = onAuthChange(() => seen.push(getAdminKey() ?? "null"));
      setAdminKey("a");
      stop();
      setAdminKey("b");
      clearAdminKey();
      expect(seen).toEqual(["a"]);
    });
  });

  it("degrades to not-signed-in without storage and never throws", () => {
    expect(getAdminKey()).toBeNull();
    expect(() => {
      setAdminKey("k");
      clearAdminKey();
    }).not.toThrow();
  });
});
