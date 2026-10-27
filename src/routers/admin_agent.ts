/**
 * Admin endpoint for plane-hosted agent release artifacts.
 *
 * WHY the plane and not a GitHub release: the release channel must not
 * depend on a third-party account staying available. Objects live in the
 * same `CERTS` bucket the certificate subsystem already uses, under their
 * own `agent/` prefix, and the admin key middleware in src/main.ts covers
 * the endpoint — the auth rules never duplicated here.
 *
 * WHAT: serves the release tarball and its sha256 sidecar from
 * `agent/<name>[.sha256]` with no-store so a patched admin key or a rolled
 * artifact can never be served from a cache.
 */

import { Hono } from "hono";

import { ApiError } from "../models";

export const adminAgent = new Hono<{ Bindings: Env }>();

/**
 * WHAT: the agent versions the bucket is expected to hold.
 *
 * WHY a constant and not a lookup: the plane keeps no release registry;
 * the newest known version is the sensible default for a download without
 * an explicit one, and an explicit version always wins over it.
 */
const KNOWN_VERSIONS = ["0.2.1"] as const;

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function latestKnownVersion(): string {
  return KNOWN_VERSIONS[KNOWN_VERSIONS.length - 1] as string;
}

/**
 * WHAT: resolve the release version to serve.
 *
 * WHY the strict regex: the version is concatenated into the R2 object
 * key, so any character outside x.y.z (spaces, dots, slashes, traversal)
 * must never reach the key — an unmatched version has no release, and
 * says so as the same 404 a missing object gets.
 */
function releaseVersion(version: string | undefined): string {
  const value = version ?? latestKnownVersion();
  if (!VERSION_PATTERN.test(value)) {
    throw new ApiError(404, "release not found");
  }
  return value;
}

adminAgent.get("/api/admin/agent-release", async (c) => {
  const version = releaseVersion(c.req.query("version"));
  const name = `lessv-agent-${version}`;
  const wantSha256 = c.req.query("sha256") !== undefined;

  const extension = wantSha256 ? ".tar.gz.sha256" : ".tar.gz";
  const key = `agent/${name}${extension}`;
  const object = await c.env.CERTS.get(key);
  if (object === null) {
    throw new ApiError(404, "release not found");
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": wantSha256 ? "text/plain" : "application/gzip",
      "Content-Disposition": `attachment; filename="${name}${extension}"`,
      ETag: object.httpEtag,
      "Cache-Control": "no-store",
      "Content-Length": object.size.toString(),
    },
  });
});
