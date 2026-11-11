/**
 * Admin endpoints for one node's REALITY keys: list and rotate.
 *
 * WHY a separate router: REALITY keys are the third resource (after nodes
 * and users). No SQL and no key logic live here — endpoints translate
 * between HTTP and the service layer, and never touch a private key: the
 * API returns only derived public keys.
 *
 * WHY inbounds are addressed by registry id: a key belongs to the inbound,
 * not to whatever tag the config calls it today, so a tag rename because of
 * a rebind must not move or orphan the key.
 */

import { Hono } from "hono";

import * as db from "../db";
import { ApiError } from "../models";
import * as realityService from "../services/reality_service";
import { loadRegistry } from "../services/registry_service";

export const adminReality = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the node row with a config, or throw 404.
 *
 * WHY 404 (not 503): mirroring the archived reality router — a node without
 * a config has no REALITY inbounds to list, which is the same "nothing here
 * yet" state the config page renders as empty.
 */
async function realityNodeOr404(env: Env, nodeId: string): Promise<db.NodeRow> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null || node.config_json === null) {
    throw new ApiError(404, "config not found");
  }
  return node;
}

/**
 * WHAT: list every REALITY inbound with its derived public key.
 *
 * WHY the private key is not returned: clients only ever need `pbk`; the
 * private key is visible where it is actually used (the runtime config
 * pane) and nowhere else.
 */
adminReality.get("/api/admin/nodes/:node_id/reality", async (c) => {
  const nodeId = c.req.param("node_id");
  const node = await realityNodeOr404(c.env, nodeId);
  const registry = await loadRegistry(c.env.DB, node);
  return c.json({ keys: await realityService.listKeys(c.env, nodeId, registry) });
});

/**
 * WHAT: rotate the key of every REALITY inbound.
 *
 * WHY one call for all: replacing the whole key set is the operator's
 * "start over" action. Nodes pick the new keys up on their next heartbeat —
 * rotation never pushes.
 */
adminReality.post("/api/admin/nodes/:node_id/reality/rotate", async (c) => {
  const nodeId = c.req.param("node_id");
  const node = await realityNodeOr404(c.env, nodeId);
  const registry = await loadRegistry(c.env.DB, node);
  if (registry.realityInboundIds.length === 0) {
    throw new ApiError(404, "no REALITY inbounds in config");
  }
  for (const inboundId of registry.realityInboundIds) {
    await realityService.rotateKey(c.env, nodeId, inboundId);
  }
  return c.json({ rotated: registry.realityInboundIds });
});

/**
 * WHAT: rotate one REALITY inbound's key.
 *
 * WHY 404 for a non-REALITY inbound: rotating a key that Xray never reads
 * would silently do nothing — the operator must learn the inbound does not
 * exist instead of seeing success.
 */
adminReality.post(
  "/api/admin/nodes/:node_id/reality/:inbound_id/rotate",
  async (c) => {
    const nodeId = c.req.param("node_id");
    const inboundId = c.req.param("inbound_id");
    const node = await realityNodeOr404(c.env, nodeId);
    const registry = await loadRegistry(c.env.DB, node);
    if (!registry.realityInboundIds.includes(inboundId)) {
      throw new ApiError(404, `no REALITY inbound '${inboundId}'`);
    }
    await realityService.rotateKey(c.env, nodeId, inboundId);
    return c.json({
      inbound_id: inboundId,
      public_key: await realityService.publicKey(c.env, nodeId, inboundId),
    });
  },
);
