/**
 * Admin endpoints for nodes: CRUD, config, runtime pane, introspection,
 * status.
 *
 * WHY a separate router: nodes are the fleet's primary resource; config
 * parsing and the runtime pane hang off them. All paths sit under
 * `/api/admin/` (the route group); the admin bearer key is the
 * authentication. No SQL and no business rules live here —
 * endpoints translate between HTTP and the service layer.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  EndpointUpdate,
  NodeCreate,
  NodeUpdate,
  parseJsonBody,
  parseJsonObject,
} from "../models";
import * as nodeService from "../services/node_service";
import * as nodeStateService from "../services/node_state_service";
import * as nodeTokenService from "../services/node_token_service";
import { loadRegistry, deleteInbound, deleteOutbound, updateInbound, updateOutbound } from "../services/registry_service";
import * as renderService from "../services/render_service";

export const adminNodes = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the node row or throw 404.
 *
 * WHY a helper: every node-scoped endpoint starts with the same lookup, and
 * a missing node must be a 404 everywhere — one place keeps that honest.
 */
async function nodeOr404(env: Env, nodeId: string): Promise<db.NodeRow> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return node;
}

/**
 * WHAT: return the node's authored config; 404 for a missing node or
 * config.
 *
 * WHY 404 (not 503): no config yet is the expected state of a fresh node —
 * the config page renders an empty state, matching the archived
 * GET /api/config convention.
 */
async function configOr404(
  env: Env,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const node = await nodeOr404(env, nodeId);
  if (node.config_json === null) {
    throw new ApiError(404, "config not found");
  }
  return node.config_json;
}

/** WHAT: return every node. */
adminNodes.get("/api/admin/nodes", async (c) => {
  return c.json(await nodeService.listNodesOut(c.env.DB));
});

/** WHAT: create a node; 409 when the id is already taken. */
adminNodes.post("/api/admin/nodes", async (c) => {
  const payload = await parseJsonBody(c.req.raw, NodeCreate);
  if ((await db.getNode(c.env.DB, payload.id)) !== null) {
    throw new ApiError(409, "node id already exists");
  }
  return c.json(await nodeService.createNode(c.env.DB, payload), 201);
});

/** WHAT: return one node; 404 when missing. */
adminNodes.get("/api/admin/nodes/:node_id", async (c) => {
  const node = await nodeService.getNodeOut(c.env.DB, c.req.param("node_id"));
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(node);
});

/** WHAT: partially update a node's label/address (null stays unchanged). */
adminNodes.put("/api/admin/nodes/:node_id", async (c) => {
  const payload = await parseJsonBody(c.req.raw, NodeUpdate);
  const node = await nodeService.updateNode(
    c.env.DB,
    c.req.param("node_id"),
    payload,
  );
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(node);
});

/**
 * WHAT: delete one node and every row scoped to it; 404 when it is gone.
 *
 * WHY no "keep as history" option: the fleet view is an inventory of live
 * machines, and a deleted node's evidence (certificates, issue runs) lives in
 * domain-scoped tables that are not touched. The removed node keeps running
 * its last applied config on disk — deletion is a plane-side act, not a
 * remote wipe — so the operator decommissions the machine separately.
 */
adminNodes.delete("/api/admin/nodes/:node_id", async (c) => {
  if (!(await nodeService.deleteNode(c.env.DB, c.req.param("node_id")))) {
    throw new ApiError(404, "node not found");
  }
  return c.body(null, 204);
});

/**
 * WHAT: mint (or rotate) one node's bearer token; plaintext shown once.
 *
 * WHY re-POST rotates with immediate invalidation: the new hash replaces
 * the old in one statement, so there is exactly one valid token per node.
 * The admin copies the plaintext into `agent.toml` (mode 0600) — it is
 * never stored and never returned again.
 */
adminNodes.post("/api/admin/nodes/:node_id/token", async (c) => {
  const nodeId = c.req.param("node_id");
  if ((await db.getNode(c.env.DB, nodeId)) === null) {
    throw new ApiError(404, "node not found");
  }
  const token = nodeTokenService.mintToken();
  await db.setTokenHash(
    c.env.DB,
    nodeId,
    await nodeTokenService.tokenHash(token),
  );
  return c.json(
    {
      node_id: nodeId,
      token,
      created_at: nodeStateService.now(),
    },
    201,
    { "Cache-Control": "no-store" },
  );
});

/** WHAT: return the node's authored config, opaque and untouched. */
adminNodes.get("/api/admin/nodes/:node_id/config", async (c) => {
  return c.json(await configOr404(c.env, c.req.param("node_id")));
});

/**
 * WHAT: replace the node's opaque config; agents converge on next
 * heartbeat.
 *
 * WHY PUT instead of the archived POST: replacing the whole document is
 * idempotent, so a retried request can never double-apply. The body is a
 * plain object because the config is opaque; non-object or malformed JSON
 * bodies are rejected as 422. Pre-qualified local tags are rejected without
 * saving.
 */
adminNodes.put("/api/admin/nodes/:node_id/config", async (c) => {
  const nodeId = c.req.param("node_id");
  const payload = await parseJsonObject(c.req.raw);
  const [exists, errors] = await nodeService.saveConfig(
    c.env.DB,
    nodeId,
    payload,
  );
  if (!exists) {
    throw new ApiError(404, "node not found");
  }
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  return c.json({ message: "config updated" });
});

/**
 * WHAT: return the config the plane would serve this node right now.
 *
 * WHY a live render and not a file: the plane no longer writes runtime
 * files or runs Xray — the rendered artifact is computed on demand from
 * current database state, so this pane can never go stale. 404 when the
 * node has no renderable config yet.
 */
adminNodes.get("/api/admin/nodes/:node_id/config/runtime", async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  const [runtime, warnings] = await renderService.desiredConfig(c.env, nodeId);
  if (runtime === null) {
    throw new ApiError(404, "runtime config not found");
  }
  return c.json({
    config: runtime,
    hash: await renderService.configHash(runtime),
    warnings,
  });
});

/**
 * WHAT: return drift at a glance: desired vs applied hash plus liveness.
 *
 * WHY desired is computed live: it is a pure function of current database
 * state, so the view is always fresh. `in_sync` is true only when a
 * renderable config exists and the node reported that exact hash — the
 * content-hash convergence property the agent loop rests on. 404 for an
 * unknown node.
 */
adminNodes.get("/api/admin/nodes/:node_id/sync", async (c) => {
  const state = await nodeStateService.syncState(
    c.env,
    c.req.param("node_id"),
  );
  if (state === null) {
    throw new ApiError(404, "node not found");
  }
  return c.json(state);
});

/**
 * WHAT: registered inbounds for one node; 503 when it has no config.
 *
 * WHY 503 and not an empty list: "no config" and "config declares no
 * inbounds" are different states, and the access editor must not render an
 * empty list as if the admin's config had none.
 */
adminNodes.get("/api/admin/nodes/:node_id/inbounds", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  if (node.config_json === null) {
    throw new ApiError(503, "config not loaded for this node");
  }
  return c.json((await loadRegistry(c.env.DB, node)).inbounds);
});

/**
 * WHAT: rename or rebind one registered inbound (label and/or tag).
 *
 * WHY rebinding exists: the operator renames a tag in the authored config;
 * pointing the registry row at the new tag is what keeps user access, REALITY
 * keys, and link variants intact.
 */
adminNodes.patch("/api/admin/nodes/:node_id/inbounds/:inbound_id", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  const payload = await parseJsonBody(c.req.raw, EndpointUpdate);
  const [inbound, errors] = await updateInbound(
    c.env.DB,
    node,
    c.req.param("inbound_id"),
    payload,
  );
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  if (inbound === null) {
    throw new ApiError(404, "inbound not found");
  }
  return c.json(inbound);
});

/** WHAT: registered outbounds for one node; 503 when it has no config. */
adminNodes.get("/api/admin/nodes/:node_id/outbounds", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  if (node.config_json === null) {
    throw new ApiError(503, "config not loaded for this node");
  }
  return c.json((await loadRegistry(c.env.DB, node)).outbounds);
});

/** WHAT: rename or rebind one registered outbound (label and/or tag). */
adminNodes.patch("/api/admin/nodes/:node_id/outbounds/:outbound_id", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  const payload = await parseJsonBody(c.req.raw, EndpointUpdate);
  const [outbound, errors] = await updateOutbound(
    c.env.DB,
    node,
    c.req.param("outbound_id"),
    payload,
  );
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  if (outbound === null) {
    throw new ApiError(404, "outbound not found");
  }
  return c.json(outbound);
});

/**
 * WHAT: delete one registered inbound that the config no longer declares.
 *
 * WHY 409 for a still-declared or still-referenced row: either it would
 * return on the next sync, or its users/keys/links would break. The
 * message names what holds it.
 */
adminNodes.delete("/api/admin/nodes/:node_id/inbounds/:inbound_id", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  const [found, errors] = await deleteInbound(
    c.env.DB,
    node,
    c.req.param("inbound_id"),
  );
  if (!found) {
    throw new ApiError(404, "inbound not found");
  }
  if (errors.length > 0) {
    throw new ApiError(409, errors);
  }
  return c.body(null, 204);
});

/** WHAT: delete one registered outbound that the config no longer declares. */
adminNodes.delete("/api/admin/nodes/:node_id/outbounds/:outbound_id", async (c) => {
  const node = await nodeOr404(c.env, c.req.param("node_id"));
  const [found, errors] = await deleteOutbound(
    c.env.DB,
    node,
    c.req.param("outbound_id"),
  );
  if (!found) {
    throw new ApiError(404, "outbound not found");
  }
  if (errors.length > 0) {
    throw new ApiError(409, errors);
  }
  return c.body(null, 204);
});

/**
 * WHAT: return counts for the admin status bar.
 *
 * WHY only counts: the plane no longer runs Xray, so per-node health lives
 * on the sync endpoint — this stays a cheap composite snapshot.
 */
adminNodes.get("/api/admin/status", async (c) => {
  return c.json({
    node_count: (await db.listNodes(c.env.DB)).length,
    user_count: (await db.listUsers(c.env.DB)).length,
  });
});
