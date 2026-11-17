/**
 * Admin endpoints for the certificate subsystem: zones, cert domains,
 * issuance, runs, certificates, and per-node assignment/summary views.
 *
 * WHY errors funnel through `asApiError`: the service raises typed errors
 * (404/409/422/502) and this router renders them — handlers stay
 * declarative and every endpoint shares one status vocabulary.
 */

import { Hono } from "hono";

import {
  activateDnsCredential as activateDnsCredentialRow,
  credentialRowOut,
  deleteDnsCredential as deleteDnsCredentialRow,
  listCredentialRows,
  saveDnsCredential,
  verifyDnsToken,
} from "../cert/credentials";
import { now } from "../services/node_state_service";
import {
  ApiError,
  DnsCredentialSaveIn,
  DnsTokenVerifyIn,
  parseJsonBody,
} from "../models";
import {
  asApiError,
  createDomain,
  deleteDomain,
  downloadCertificate,
  getCertificateOut,
  getDomainOut,
  getRun,
  issueDomain,
  listDomainCertificates,
  listDomainOuts,
  listDomainRuns,
  nodeCertDomainState,
  nodeCertSummaries,
  setNodeAssignment,
  testIssueDomain,
  updateDomain,
  zoneList,
  type DownloadFile,
} from "../cert/service";
import {
  CertDomainCreate,
  CertDomainUpdate,
  NodeCertAssignment,
} from "../cert/models";

export const adminCerts = new Hono<{ Bindings: Env }>();

/**
 * WHAT: run one service call and render its error mapping.
 *
 * WHY a wrapper: every handler needs the same try/catch so the typed
 * errors become 4xx/5xx responses with the `{detail}` envelope.
 */
async function handle(_c: { env: Env }, body: () => Promise<Response>): Promise<Response> {
  try {
    return await body();
  } catch (error) {
    throw asApiError(error);
  }
}

adminCerts.get("/api/admin/zones", async (c) =>
  handle(c, async () => c.json(await zoneList(c.env))),
);

adminCerts.get("/api/admin/cert-domains", async (c) =>
  handle(c, async () => c.json(await listDomainOuts(c.env))),
);

adminCerts.post("/api/admin/cert-domains", async (c) =>
  handle(c, async () => {
    const payload = await parseJsonBody(c.req.raw, CertDomainCreate);
    const created = await createDomain(c.env, payload);
    return c.json(created, 201);
  }),
);

adminCerts.get("/api/admin/cert-domains/:id", async (c) =>
  handle(c, async () => c.json(await getDomainOut(c.env, c.req.param("id")))),
);

adminCerts.patch("/api/admin/cert-domains/:id", async (c) =>
  handle(c, async () => {
    const payload = await parseJsonBody(c.req.raw, CertDomainUpdate);
    return c.json(await updateDomain(c.env, c.req.param("id"), payload));
  }),
);

adminCerts.delete("/api/admin/cert-domains/:id", async (c) =>
  handle(c, async () => {
    await deleteDomain(c.env, c.req.param("id"));
    return c.json({ deleted: true });
  }),
);

adminCerts.post("/api/admin/cert-domains/:id/issue", async (c) =>
  handle(c, async () => {
    const body = await c.req.raw.json().catch(() => ({}));
    const started = await issueDomain(c.env, c.req.param("id"), body);
    return c.json(started, 202);
  }),
);

adminCerts.post("/api/admin/cert-domains/:id/test-issue", async (c) =>
  handle(c, async () => {
    const started = await testIssueDomain(c.env, c.req.param("id"));
    return c.json(started, 202);
  }),
);

adminCerts.get("/api/admin/cert-domains/:id/runs", async (c) =>
  handle(c, async () => c.json(await listDomainRuns(c.env, c.req.param("id")))),
);

adminCerts.get("/api/admin/cert-runs/:id", async (c) =>
  handle(c, async () => c.json(await getRun(c.env, c.req.param("id")))),
);

adminCerts.get("/api/admin/cert-domains/:id/certs", async (c) =>
  handle(c, async () => c.json(await listDomainCertificates(c.env, c.req.param("id")))),
);

adminCerts.get("/api/admin/certificates/:id", async (c) =>
  handle(c, async () => c.json(await getCertificateOut(c.env, c.req.param("id")))),
);

adminCerts.get("/api/admin/certificates/:id/download", async (c) =>
  handle(c, async () => {
    const file = c.req.query("file") ?? "";
    if (!["cert", "chain", "fullchain", "key"].includes(file)) {
      throw new ApiError(422, "file must be one of: cert, chain, fullchain, key");
    }
    const artifact = await downloadCertificate(
      c.env,
      c.req.param("id"),
      file as DownloadFile,
    );
    return new Response(artifact.body, {
      headers: {
        "Content-Type": artifact.contentType,
        "Content-Disposition": `attachment; filename="${c.req.param("id")}.${file}.pem"`,
        "Cache-Control": "no-store",
      },
    });
  }),
);

adminCerts.get("/api/admin/nodes/:id/cert-domains", async (c) =>
  handle(c, async () => c.json(await nodeCertDomainState(c.env, c.req.param("id")))),
);

adminCerts.put("/api/admin/nodes/:id/cert-domains", async (c) =>
  handle(c, async () => {
    const nodeId = c.req.param("id");
    // The node must exist; a body referencing unknown domains is 422.
    await nodeCertDomainState(c.env, nodeId);
    const payload = await parseJsonBody(c.req.raw, NodeCertAssignment);
    await setNodeAssignment(c.env, nodeId, payload.domain_ids);
    return c.json(await nodeCertDomainState(c.env, nodeId));
  }),
);

adminCerts.get("/api/admin/nodes/:id/certs", async (c) =>
  handle(c, async () => c.json(await nodeCertSummaries(c.env, c.req.param("id")))),
);

// ---------------------------------------------------------------- DNS token

adminCerts.get("/api/admin/dns-credentials", async (c) =>
  handle(c, async () => c.json(await listCredentialRows(c.env))),
);

adminCerts.post("/api/admin/dns-credentials/verify", async (c) =>
  handle(c, async () => {
    const payload = await parseJsonBody(c.req.raw, DnsTokenVerifyIn);
    return c.json({ zones: await verifyDnsToken(payload.token) });
  }),
);

adminCerts.post("/api/admin/dns-credentials", async (c) =>
  handle(c, async () => {
    const payload = await parseJsonBody(c.req.raw, DnsCredentialSaveIn);
    const saved = await saveDnsCredential(c.env, payload, now());
    return c.json(saved, 201);
  }),
);

adminCerts.post("/api/admin/dns-credentials/:id/activate", async (c) =>
  handle(c, async () => {
    const id = c.req.param("id");
    await activateDnsCredentialRow(c.env, id, now());
    const row = await credentialRowOut(c.env, id);
    return c.json(row);
  }),
);

adminCerts.delete("/api/admin/dns-credentials/:id", async (c) =>
  handle(c, async () => {
    await deleteDnsCredentialRow(c.env, c.req.param("id"));
    return c.json({});
  }),
);
