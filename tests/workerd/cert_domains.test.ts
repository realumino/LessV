/**
 * HTTP-tier tests for the certificate admin endpoints: zones, domain CRUD,
 * wildcard overlap, deletion semantics.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { planeFetch, planeJson, uid } from "../helpers";
import { seedIssueRun } from "../cert/support/fixtures";

/**
 * WHY a local seed helper: the cert tier's fixtures live beside its tests;
 * the workerd tier re-creates the small parts it needs here.
 */
async function seedDomain(
  name?: string,
  status: "active" | "paused" = "active",
  includeWildcard = false,
) {
  const id = crypto.randomUUID();
  const name0 = name ?? `dom-${crypto.randomUUID().slice(0, 6)}.example.com`;
  await env.DB.prepare(
    `INSERT INTO cert_domains (
       id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
       status, last_error, created_at, updated_at
     ) VALUES (?, ?, 'zone-test', ?, 'tlsserver', NULL, ?, NULL, ?, ?)`,
  ).bind(id, name0, includeWildcard ? 1 : 0, status, new Date().toISOString(), new Date().toISOString()).run();
  return { id, name: name0 };
}

describe("GET /api/admin/zones", () => {
  it("lists the zones the DNS token can read", async () => {
    const response = await planeFetch("/api/admin/zones");
    expect(response.status).toBe(200);
    const zones = (await response.json()) as Array<{ id: string; name: string }>;
    expect(zones.some((zone) => zone.name === "example.com")).toBe(true);
  });

  it("requires the admin key", async () => {
    const response = await planeFetch("/api/admin/zones", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(response.status).toBe(401);
  });
});

describe("cert domain CRUD", () => {
  it("creates a domain, normalizing the name; duplicates 409", async () => {
    const base = `c${crypto.randomUUID().slice(0, 8)}`;
    const response = await planeJson("POST", "/api/admin/cert-domains", {
      name: base.toUpperCase() + ".example.com",
      zone_id: "zone-test",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: `${base}.example.com`,
      path: `${base}.example.com`,
      include_wildcard: false,
      acme_profile: "tlsserver",
      status: "active",
      production_certificate: null,
      staging_certificate: null,
    });

    const duplicate = await planeJson("POST", "/api/admin/cert-domains", {
      name: `${base}.example.com`,
      zone_id: "zone-test",
    });
    expect(duplicate.status).toBe(409);
  });

  it("rejects invalid names with 400", async () => {
    const response = await planeJson("POST", "/api/admin/cert-domains", {
      name: "192.0.2.1",
      zone_id: "zone-test",
    });
    expect(response.status).toBe(422);
  });

  it("wildcard overlap conflicts 409", async () => {
    const base = uid("o");
    await seedDomain(`${base}.example.com`, "active", true);
    // Apex row with include_wildcard issues `*.${base}.example.com`; a
    // dedicated wildcard row for the same SAN collides.
    const response = await planeJson("POST", "/api/admin/cert-domains", {
      name: `*.${base}.example.com`,
      zone_id: "zone-test",
    });
    expect(response.status).toBe(409);

    const apexWildcard = await planeJson("POST", "/api/admin/cert-domains", {
      name: `${base}2.example.com`,
      zone_id: "zone-test",
      include_wildcard: true,
    });
    expect(apexWildcard.status).toBe(201);
  });

  it("patches profile, renew days reset, and pause", async () => {
    const domain = await seedDomain();
    const patched = await planeJson("PATCH", `/api/admin/cert-domains/${domain.id}`, {
      acme_profile: "classic",
      renew_before_days: null,
      status: "paused",
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      acme_profile: "classic",
      renew_before_days: null,
      status: "paused",
    });

    const paused = await planeJson("POST", `/api/admin/cert-domains/${domain.id}/issue`, {
      confirm: domain.name,
    });
    expect(paused.status).toBe(409);
  });

  it("rejects the wildcard toggle on wildcard-only rows", async () => {
    const base = uid("w");
    const created = await planeJson("POST", "/api/admin/cert-domains", {
      name: `*.${base}.example.com`,
      zone_id: "zone-test",
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; include_wildcard: boolean };
    expect(body.include_wildcard).toBe(false);
    const patched = await planeJson("PATCH", `/api/admin/cert-domains/${body.id}`, {
      include_wildcard: true,
    });
    expect(patched.status).toBe(400);
  });

  it("delete: active run 409; otherwise soft delete clears assignments", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    const blocked = await planeFetch(`/api/admin/cert-domains/${domain.id}`, {
      method: "DELETE",
    });
    expect(blocked.status).toBe(409);

    const domain2 = await seedDomain();
    const ok = await planeFetch(`/api/admin/cert-domains/${domain2.id}`, {
      method: "DELETE",
    });
    expect(ok.status).toBe(200);
    const detail = await planeFetch(`/api/admin/cert-domains/${domain2.id}`);
    expect(detail.status).toBe(404);
    // The row is soft-deleted, not gone.
    const row = await env.DB.prepare("SELECT status FROM cert_domains WHERE id = ?")
      .bind(domain2.id).first<{ status: string }>();
    expect(row?.status).toBe("deleted");
  });

  it("unknown domain 404", async () => {
    const response = await planeFetch(`/api/admin/cert-domains/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });
});
