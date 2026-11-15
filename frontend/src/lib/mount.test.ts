/**
 * The admin mount rule and the inert fallback document.
 *
 * WHY these assertions exist: the control plane's privacy is a property of
 * two files that never run in the app's own tests — the mount predicate in
 * main.tsx and the fallback document the edge serves to navigation misses.
 * A regression in either one puts a titled Vela page at the site root, so
 * both are pinned here.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADMIN_TITLE, isAdminMount } from "./mount";

const FALLBACK = readFileSync(
  fileURLToPath(new URL("../../spa-fallback.html", import.meta.url)),
  "utf8",
);

describe("isAdminMount", () => {
  it("accepts the mount and everything under it", () => {
    expect(isAdminMount("/admin")).toBe(true);
    expect(isAdminMount("/admin/")).toBe(true);
    expect(isAdminMount("/admin/nodes/tokyo01/config")).toBe(true);
    expect(isAdminMount("/adminx")).toBe(false);
  });

  it("rejects every other path", () => {
    expect(isAdminMount("/")).toBe(false);
    expect(isAdminMount("/foo")).toBe(false);
    expect(isAdminMount("/sub/token")).toBe(false);
    expect(isAdminMount("/api/health")).toBe(false);
    expect(isAdminMount("/api/admin/nodes")).toBe(false);
    expect(isAdminMount("/Administration")).toBe(false);
    expect(isAdminMount("")).toBe(false);
  });

  it("keeps the product name out of the site-root title", () => {
    expect(ADMIN_TITLE).toContain("Vela");
  });
});

describe("the SPA fallback document", () => {
  it("has an empty title and no product name", () => {
    expect(FALLBACK).toMatch(/<title>\s*<\/title>/);
    expect(FALLBACK).not.toMatch(/Vela/i);
  });

  it("names no bundle, only the shell it fetches inside the mount", () => {
    // A reference to a hashed asset here would let a probe of / fetch the
    // panel's bundle; the mount path and the shell path are the only paths.
    expect(FALLBACK).not.toMatch(/assets\//);
    expect(FALLBACK).not.toMatch(/\.js(["'?])/);
    expect(FALLBACK).toContain('"/admin/"');
  });

  it("gates the shell load on the mount path", () => {
    expect(FALLBACK).toContain('path !== "/admin"');
    expect(FALLBACK).toContain('path.indexOf("/admin/") !== 0');
  });
});
