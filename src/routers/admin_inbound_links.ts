/**
 * Admin endpoints for inbound link variants.
 *
 * WHY a separate router: a variant is its own admin-managed resource with an
 * identity and validation. It adds a client-side view of one registered
 * inbound and never changes the rendered runtime config. No SQL and no
 * variant rules live here.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  InboundLinkIn,
  InboundLinkUpdate,
  parseJsonBody,
} from "../models";
import * as inboundLinkService from "../services/inbound_link_service";
import { loadRegistry } from "../services/registry_service";

export const adminInboundLinks = new Hono<{ Bindings: Env }>();

const PREFIX = "/api/admin/nodes/:node_id/inbound-links";

/** WHAT: return the node row or throw 404. */
async function nodeOr404(env: Env, nodeId: string): Promise<db.NodeRow> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  return node;
}

/** WHAT: return one node's variants in display order. */
adminInboundLinks.get(PREFIX, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  return c.json(await inboundLinkService.listLinks(c.env.DB, nodeId));
});

/** WHAT: create a variant attached to one of the node's registered inbounds. */
adminInboundLinks.post(PREFIX, async (c) => {
  const nodeId = c.req.param("node_id");
  // WHY the body is parsed before the node lookup: FastAPI resolved the
  // Pydantic model before the handler ran, so a schema-invalid body beat a
  // 404 even for a missing node.
  const payload = await parseJsonBody(c.req.raw, InboundLinkIn);
  const node = await nodeOr404(c.env, nodeId);
  const registry = await loadRegistry(c.env.DB, node);
  const errors = inboundLinkService.validateCreate(node, registry, payload);
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  if (
    (await inboundLinkService.getLink(c.env.DB, nodeId, payload.id)) !== null
  ) {
    throw new ApiError(409, "link id already exists");
  }
  return c.json(
    await inboundLinkService.createLink(c.env.DB, nodeId, payload),
    201,
  );
});

/** WHAT: return one variant; 404 when the node or variant is missing. */
adminInboundLinks.get(`${PREFIX}/:link_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  const link = await inboundLinkService.getLink(
    c.env.DB,
    nodeId,
    c.req.param("link_id"),
  );
  if (link === null) {
    throw new ApiError(404, "link not found");
  }
  return c.json(link);
});

/** WHAT: partially update a variant; a missing variant is a 404. */
adminInboundLinks.put(`${PREFIX}/:link_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  // WHY the body is parsed first: see the POST handler above.
  const payload = await parseJsonBody(c.req.raw, InboundLinkUpdate);
  const node = await nodeOr404(c.env, nodeId);
  const registry = await loadRegistry(c.env.DB, node);
  const errors = inboundLinkService.validateUpdate(node, registry, payload);
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  const link = await inboundLinkService.updateLink(
    c.env.DB,
    nodeId,
    c.req.param("link_id"),
    payload,
  );
  if (link === null) {
    throw new ApiError(404, "link not found");
  }
  return c.json(link);
});

/** WHAT: delete a variant; a missing variant is a 404. */
adminInboundLinks.delete(`${PREFIX}/:link_id`, async (c) => {
  const nodeId = c.req.param("node_id");
  await nodeOr404(c.env, nodeId);
  if (
    !(await inboundLinkService.deleteLink(
      c.env.DB,
      nodeId,
      c.req.param("link_id"),
    ))
  ) {
    throw new ApiError(404, "link not found");
  }
  return c.body(null, 204);
});
