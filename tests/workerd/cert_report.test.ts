/**
 * HTTP-tier tests for POST /api/node/report cert semantics: stage=cert
 * updates only cert columns; ordinary reports carry cert facts too.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { planeJson, uid } from "../helpers";

async function seedNode(id: string) {
  await env.DB.prepare(
    "INSERT INTO nodes (id, label, address, created_at) VALUES (?, ?, 'a.example.com', ?)",
  ).bind(id, id, Date.now()).run();
}

async function mint(nodeId: string): Promise<string> {
  const response = await planeJson("POST", `/api/admin/nodes/${nodeId}/token`, {});
  return ((await response.json()) as { token: string }).token;
}

function auth(nodeId: string, token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-Vela-Server": nodeId };
}

async function nodeRow(nodeId: string): Promise<Record<string, unknown>> {
  return (await env.DB.prepare("SELECT * FROM nodes WHERE id = ?")
    .bind(nodeId).first()) as Record<string, unknown>;
}

describe("POST /api/node/report", () => {
  it("stage=cert does not move applied/health/last_error", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mint(nodeId);
    const response = await planeJson(
      "POST",
      "/api/node/report",
      {
        protocol: 3,
        hash: "abc",
        ok: false,
        stage: "cert",
        error: "nginx reload failed",
        nginx_ok: false,
        nginx_error: "nginx: test failed",
        cert_etag: '"abc123"',
        cert_synced_at: 1758000000,
      },
      auth(nodeId, token),
    );
    expect(response.status).toBe(200);
    const row = await nodeRow(nodeId);
    expect(row.applied_hash).toBeNull();
    expect(row.health).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.nginx_ok).toBe(0);
    expect(row.nginx_error).toBe("nginx: test failed");
    expect(row.cert_etag).toBe('"abc123"');
    expect(row.cert_synced_at).toBe(1758000000);
  });

  it("ordinary applied report with cert fields writes both kinds", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mint(nodeId);
    const response = await planeJson(
      "POST",
      "/api/node/report",
      {
        protocol: 3,
        hash: "good",
        ok: true,
        stage: "applied",
        nginx_ok: true,
        nginx_error: null,
        cert_etag: '"feed"',
        cert_synced_at: 1758000100,
      },
      auth(nodeId, token),
    );
    expect(response.status).toBe(200);
    const row = await nodeRow(nodeId);
    expect(row.applied_hash).toBe("good");
    expect(row.health).toBe("ok");
    expect(row.nginx_ok).toBe(1);
    expect(row.cert_etag).toBe('"feed"');
  });

  it("rejects old protocol 1 payloads with 400", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mint(nodeId);
    const response = await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 1, hash: "x", ok: true, stage: "applied" },
      auth(nodeId, token),
    );
    expect(response.status).toBe(400);
  });

  it("rejects stage=cert with missing cert fields as schema violations? no — defaults", async () => {
    // A minimal cert report (all cert facts null) is valid; it only moves
    // last_seen. The server must not invent a timestamp.
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mint(nodeId);
    const response = await planeJson(
      "POST",
      "/api/node/report",
      { protocol: 3, hash: "", ok: true, stage: "cert" },
      auth(nodeId, token),
    );
    expect(response.status).toBe(200);
    const row = await nodeRow(nodeId);
    expect(row.cert_etag).toBeNull();
    expect(row.cert_synced_at).toBeNull();
    expect(row.nginx_ok).toBeNull();
  });
});
