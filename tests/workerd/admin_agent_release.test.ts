/**
 * The plane-hosted agent release endpoint, over a real plane and the real
 * (miniflare) R2 binding.
 *
 * WHY HTTP: the contract is "admin key first, then the bucket" — the
 * auth assertions pin the fail-closed middleware for this path, and the
 * 200 assertions pin the served bytes and headers against the exact
 * object the test puts in `CERTS`, so a header regression can never hide
 * behind a happy-path GET. Ported shape follows tests/workerd/admin_auth.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { planeFetch, TEST_ADMIN_KEY } from "../helpers";

const VERSION = "0.2.1";
const TARBALL_KEY = `agent/lessv-agent-${VERSION}.tar.gz`;
const SHA256_KEY = `${TARBALL_KEY}.sha256`;

function noKey(): RequestInit {
  return { headers: { Authorization: "" } };
}

/** WHAT: fixed bytes the fake release objects carry. */
function fakeReleaseBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("GET /api/admin/agent-release", () => {
  it("answers 401 without a key", async () => {
    const response = await planeFetch(
      `/api/admin/agent-release?version=${VERSION}`,
      noKey(),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "admin key required" });
  });

  it("answers 401 with a wrong key", async () => {
    const response = await planeFetch(
      `/api/admin/agent-release?version=${VERSION}`,
      { headers: { Authorization: "Bearer wrong-key" } },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: "admin key required" });
  });

  it("answers 404 with the release envelope when the bucket holds nothing", async () => {
    await env.CERTS.delete(TARBALL_KEY);

    const response = await planeFetch(
      `/api/admin/agent-release?version=${VERSION}`,
      { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "release not found" });
  });

  it("streams the tarball from CERTS with the attachment headers", async () => {
    // Fixed bytes, not a tar archive: the endpoint is a bucket proxy, and
    // byte identity is the assertion a real archive would blur.
    const bytes = fakeReleaseBytes("fake agent release payload\n");
    await env.CERTS.delete(TARBALL_KEY);
    await env.CERTS.put(TARBALL_KEY, bytes);

    const response = await planeFetch(
      `/api/admin/agent-release?version=${VERSION}`,
      { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/gzip");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="lessv-agent-${VERSION}.tar.gz"`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Length")).toBe(
      bytes.byteLength.toString(),
    );
    expect(response.headers.get("ETag")).toBeTruthy();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("streams the sha256 sidecar as text with its filename", async () => {
    const bytes = fakeReleaseBytes(
      "540a4c4e3a1fcd74199428df60dda4cda2d69dd2f50ec4f3b043dcaba8c37080  lessv-agent-0.2.1.tar.gz\n",
    );
    await env.CERTS.delete(SHA256_KEY);
    await env.CERTS.put(SHA256_KEY, bytes);

    const response = await planeFetch(
      `/api/admin/agent-release?version=${VERSION}&sha256`,
      { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="lessv-agent-${VERSION}.tar.gz.sha256"`,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Length")).toBe(
      bytes.byteLength.toString(),
    );
    expect(response.headers.get("ETag")).toBeTruthy();
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it("answers 404 for a version that is not a release, even by regex", async () => {
    const response = await planeFetch(
      "/api/admin/agent-release?version=9.9.9",
      { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "release not found" });
  });
});
