/**
 * HTTP-tier tests for per-node certificate environment selection: one
 * assignment, two environments, and every admin/node view naming the
 * environment it describes.
 *
 * WHY these live together: the feature is a single rule ("deliver the
 * current certificate of the node's own environment") that shows up on
 * three endpoints and the node update path; splitting them would let one
 * view drift back to production unnoticed.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { planeFetch, planeJson, uid } from "../helpers";
import { seedCertificate, seedIssueRun } from "../cert/support/fixtures";

async function seedNode(
  id: string,
  certEnvironment: "production" | "staging" = "production",
) {
  await env.DB.prepare(
    "INSERT INTO nodes (id, label, address, cert_environment, created_at) VALUES (?, ?, 'a.example.com', ?, ?)",
  ).bind(id, id, certEnvironment, Date.now()).run();
}

async function mintToken(nodeId: string): Promise<string> {
  const response = await planeJson("POST", `/api/admin/nodes/${nodeId}/token`, {});
  return ((await response.json()) as { token: string }).token;
}

async function nodeManifest(nodeId: string, token: string) {
  const response = await planeFetch("/api/node/certs", {
    headers: { Authorization: `Bearer ${token}`, "X-Lessv-Node": nodeId },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    etag: string;
    certs: Array<{ domain: string; serial: string; fingerprint_sha256: string }>;
  };
}

async function seedDomain() {
  const id = crypto.randomUUID();
  const name = `env-${crypto.randomUUID().slice(0, 6)}.example.com`;
  await env.DB.prepare(
    `INSERT INTO cert_domains (
       id, name, zone_id, include_wildcard, acme_profile, renew_before_days,
       status, last_error, created_at, updated_at
     ) VALUES (?, ?, 'zone-test', 0, 'tlsserver', NULL, 'active', NULL, ?, ?)`,
  ).bind(id, name, new Date().toISOString(), new Date().toISOString()).run();
  return { id, name };
}

async function assign(nodeId: string, domainId: string) {
  const response = await planeJson("PUT", `/api/admin/nodes/${nodeId}/cert-domains`, {
    domain_ids: [domainId],
  });
  expect(response.status).toBe(200);
}

describe("per-node cert environment", () => {
  it("serves each node the current certificate of its own environment from one assignment", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    const production = await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
      serial: "prod-serial",
    });
    const staging = await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "staging",
      current: true,
      serial: "staging-serial",
    });

    const prodNode = uid("n");
    const stagingNode = uid("n");
    await seedNode(prodNode, "production");
    await seedNode(stagingNode, "staging");
    await assign(prodNode, domain.id);
    await assign(stagingNode, domain.id);

    const productionManifest = await nodeManifest(prodNode, await mintToken(prodNode));
    expect(productionManifest.certs).toHaveLength(1);
    expect(productionManifest.certs[0]).toMatchObject({
      domain: domain.name,
      serial: "prod-serial",
      fingerprint_sha256: production.fingerprint_sha256,
    });

    const stagingManifest = await nodeManifest(stagingNode, await mintToken(stagingNode));
    expect(stagingManifest.certs).toHaveLength(1);
    expect(stagingManifest.certs[0]).toMatchObject({
      domain: domain.name,
      serial: "staging-serial",
      fingerprint_sha256: staging.fingerprint_sha256,
    });

    // Different certificate bytes are different manifests.
    expect(stagingManifest.etag).not.toBe(productionManifest.etag);
  });

  it("gives a staging node an empty manifest when only a production certificate exists", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
    });

    const stagingNode = uid("n");
    await seedNode(stagingNode, "staging");
    await assign(stagingNode, domain.id);

    const manifest = await nodeManifest(stagingNode, await mintToken(stagingNode));
    expect(manifest.certs).toEqual([]);
  });

  it("switches the environment through PUT and rotates the manifest ETag", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
      serial: "prod-serial",
    });
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "staging",
      current: true,
      serial: "staging-serial",
    });

    const nodeId = uid("n");
    await seedNode(nodeId);
    await assign(nodeId, domain.id);
    const token = await mintToken(nodeId);
    const before = await nodeManifest(nodeId, token);
    expect(before.certs[0]?.serial).toBe("prod-serial");

    const updated = await planeJson("PUT", `/api/admin/nodes/${nodeId}`, {
      cert_environment: "staging",
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { cert_environment: string }).cert_environment).toBe(
      "staging",
    );

    const after = await nodeManifest(nodeId, token);
    expect(after.certs[0]?.serial).toBe("staging-serial");
    expect(after.etag).not.toBe(before.etag);

    // A later update that says nothing about the environment keeps it.
    const renamed = await planeJson("PUT", `/api/admin/nodes/${nodeId}`, {
      label: "Renamed",
    });
    expect(renamed.status).toBe(200);
    const kept = (await renamed.json()) as { cert_environment: string; label: string };
    expect(kept.cert_environment).toBe("staging");
    expect(kept.label).toBe("Renamed");
  });

  it("rejects an unknown environment value with 422 and changes nothing", async () => {
    const nodeId = uid("n");
    await seedNode(nodeId);

    const response = await planeJson("PUT", `/api/admin/nodes/${nodeId}`, {
      cert_environment: "letsencrypt",
    });
    expect(response.status).toBe(422);

    const node = await planeJson("GET", `/api/admin/nodes/${nodeId}`);
    expect(((await node.json()) as { cert_environment: string }).cert_environment).toBe(
      "production",
    );
  });

  it("exposes the environment on the node cert summaries and domain state", async () => {
    const domain = await seedDomain();
    await seedIssueRun(env.DB, domain.id, "manual", "production");
    await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "production",
      current: true,
      serial: "prod-serial",
    });
    const staging = await seedCertificate(env.DB, env.CERTS, domain.id, {
      domainName: domain.name,
      environment: "staging",
      current: true,
      serial: "staging-serial",
    });

    const nodeId = uid("n");
    await seedNode(nodeId, "staging");
    await assign(nodeId, domain.id);

    const certs = await planeJson("GET", `/api/admin/nodes/${nodeId}/certs`);
    expect(certs.status).toBe(200);
    const certsBody = (await certs.json()) as {
      cert_environment: string;
      certs: Array<{ domain: string; serial: string; fingerprint_sha256: string }>;
    };
    expect(certsBody.cert_environment).toBe("staging");
    expect(certsBody.certs).toHaveLength(1);
    expect(certsBody.certs[0]).toMatchObject({
      domain: domain.name,
      serial: "staging-serial",
      fingerprint_sha256: staging.fingerprint_sha256,
    });

    const state = await planeJson("GET", `/api/admin/nodes/${nodeId}/cert-domains`);
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as {
      cert_environment: string;
      domains: Array<{
        id: string;
        current_certificate: { environment: string; serial: string } | null;
      }>;
    };
    expect(stateBody.cert_environment).toBe("staging");
    const mine = stateBody.domains.find((entry) => entry.id === domain.id);
    expect(mine?.current_certificate).toMatchObject({
      environment: "staging",
      serial: "staging-serial",
    });
  });

  it("creates every new node on production", async () => {
    const nodeId = uid("n");
    const created = await planeJson("POST", "/api/admin/nodes", {
      id: nodeId,
      label: "Tokyo 01",
      address: "funky.example.com",
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { cert_environment: string }).cert_environment).toBe(
      "production",
    );
  });
});
