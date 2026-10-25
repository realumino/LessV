/**
 * HTTP-tier tests for GET /api/node/certs: ETag stability, 304, staging
 * exclusion, per-node isolation, artifact-missing 500, and assignment
 * effects on the ETag.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { planeFetch, planeJson, uid } from "../helpers";
import { seedIssueRun } from "../cert/support/fixtures";
import { seedCertificate } from "../cert/support/fixtures";

async function seedNode(id: string) {
  await env.DB.prepare(
    "INSERT INTO nodes (id, label, address, created_at) VALUES (?, ?, 'a.example.com', ?)",
  ).bind(id, id, Date.now()).run();
}

async function mintToken(nodeId: string) {
  const response = await planeJson("POST", `/api/admin/nodes/${nodeId}/token`, {});
  const body = (await response.json()) as { token?: string };
  return body.token ?? null;
}

async function authedFetch(nodeId: string, token: string, path: string, headers: Record<string, string> = {}) {
  return planeFetch(path, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Lessv-Node": nodeId,
      ...headers,
    },
  });
}

async function seedDomain(name?: string) {
  const id = crypto.randomUUID();
  const name0 = name ?? `del-${crypto.randomUUID().slice(0, 6)}.example.com`;
  await env.DB.prepare(
    `INSERT INTO cert_domains (
       id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
       status, last_error, created_at, updated_at
     ) VALUES (?, ?, 'zone-test', 0, 'tlsserver', NULL, 'active', NULL, ?, ?)`,
  ).bind(id, name0, new Date().toISOString(), new Date().toISOString()).run();
  return { id, name: name0 };
}

async function assign(nodeId: string, domainId: string) {
  const response = await planeJson("PUT", `/api/admin/nodes/${nodeId}/cert-domains`, {
    domain_ids: [domainId],
  });
  expect(response.status).toBe(200);
}

describe("GET /api/node/certs", () => {
  it("serves the assigned production current manifest with a stable quoted ETag", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mintToken(nodeId);
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
      sans: [domain.name],
    });
    await assign(nodeId, domain.id);

    const response = await authedFetch(nodeId, token!, "/api/node/certs");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const manifest = (await response.json()) as {
      etag: string;
      certs: Array<Record<string, unknown>>;
    };
    expect(manifest.etag).toBe(etag);
    expect(manifest.certs).toHaveLength(1);
    expect(manifest.certs[0]).toMatchObject({
      domain: domain.name,
      path: domain.name,
      sans: [domain.name],
      profile: "tlsserver",
    });
    expect(String(manifest.certs[0]["fullchain_pem"])).toContain("FULLCHAIN");
    expect(String(manifest.certs[0]["private_key_pem"])).toContain("PRIVATE KEY");

    // 304 on a match, no body.
    const cached = await authedFetch(nodeId, token!, "/api/node/certs", {
      "If-None-Match": etag!,
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    expect(cached.headers.get("etag")).toBe(etag);

    // Mismatch serves 200 again.
    const stale = await authedFetch(nodeId, token!, "/api/node/certs", {
      "If-None-Match": '"deadbeef"',
    });
    expect(stale.status).toBe(200);
  });

  it("never serves staging certificates", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mintToken(nodeId);
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "test", "staging");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "staging",
      current: true,
      sans: [domain.name],
    });
    await assign(nodeId, domain.id);

    const response = await authedFetch(nodeId, token!, "/api/node/certs");
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as { certs: unknown[] };
    expect(manifest.certs).toEqual([]);
  });

  it("isolates nodes: assignment is per node", async () => {
    const nodeA = uid("n");
    const nodeB = uid("n");
    await seedNode(nodeA);
    await seedNode(nodeB);
    const tokenA = await mintToken(nodeA);
    const tokenB = await mintToken(nodeB);
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
    });
    await assign(nodeA, domain.id);

    const a = await authedFetch(nodeA, tokenA!, "/api/node/certs");
    expect(((await a.json()) as { certs: unknown[] }).certs).toHaveLength(1);
    const b = await authedFetch(nodeB, tokenB!, "/api/node/certs");
    expect(((await b.json()) as { certs: unknown[] }).certs).toHaveLength(0);
  });

  it("assignment changes move the ETag only when the certificate set changes", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mintToken(nodeId);
    const domain1 = await seedDomain();
    const domain2 = await seedDomain();
    await seedIssueRun(env.DB, domain1.id, "manual", "production");
    await seedIssueRun(env.DB, domain2.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain1.id, {
      domainName: domain1.name,
      environment: "production",
      current: true,
    });
    await seedCertificate(env.DB, env.CERTS, domain2.id, {
      domainName: domain2.name,
      environment: "production",
      current: true,
    });
    await assign(nodeId, domain1.id);
    const etag1 = (await (await authedFetch(nodeId, token!, "/api/node/certs")).json() as { etag: string }).etag;

    await planeJson("PUT", `/api/admin/nodes/${nodeId}/cert-domains`, {
      domain_ids: [domain1.id, domain2.id],
    });
    const etag2 = (await (await authedFetch(nodeId, token!, "/api/node/certs")).json() as { etag: string }).etag;
    expect(etag2).not.toBe(etag1);

    // Same set in a different order: the ETag is unchanged.
    await planeJson("PUT", `/api/admin/nodes/${nodeId}/cert-domains`, {
      domain_ids: [domain2.id, domain1.id],
    });
    const etag3 = (await (await authedFetch(nodeId, token!, "/api/node/certs")).json() as { etag: string }).etag;
    expect(etag3).toBe(etag2);
  });

  it("answers 500 when an artifact is missing and 401 without credentials", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);
    const token = await mintToken(nodeId);
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    const cert = await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
      storeArtifacts: false,
    });
    await assign(nodeId, domain.id);

    const response = await authedFetch(nodeId, token!, "/api/node/certs");
    expect(response.status).toBe(500);
    const detail = (await response.json()) as { detail?: string };
    expect(detail.detail).toContain(cert.r2_prefix);

    const anonymous = await planeFetch("/api/node/certs");
    expect(anonymous.status).toBe(401);
  });
});
