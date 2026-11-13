/**
 * Admin endpoints for naming: the link-name template, the subscription
 * title, and the per-combination overrides.
 *
 * WHY its own router: naming is one resource with two kinds of write (a
 * fleet-wide template and a literal exception) and one read (the rendered
 * result everywhere). Keeping it apart from nodes and links means the page
 * loads one snapshot instead of stitching three endpoints.
 *
 * WHY the write endpoints re-render the whole view: the admin must see the
 * consequence of a template (or an override) in every combination, and the
 * renderer lives on this side — a client-side preview would be a second
 * implementation that can drift.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ApiError,
  LinkNameOverrideIn,
  NamingUpdate,
  parseJsonBody,
} from "../models";
import * as namingService from "../services/naming_service";
import { loadRegistry } from "../services/registry_service";
import { savePlaneSettings, validateSettings } from "../services/settings_service";

export const adminNames = new Hono<{ Bindings: Env }>();

const PREFIX = "/api/admin/naming";

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** WHAT: return the templates and every node's rendered combinations. */
adminNames.get(PREFIX, async (c) => {
  return c.json(await namingService.namingView(c.env.DB));
});

/** WHAT: update one template and return the re-rendered view. */
adminNames.put(PREFIX, async (c) => {
  const payload = await parseJsonBody(c.req.raw, NamingUpdate);
  const errors = validateSettings(payload);
  if (errors.length > 0) {
    throw new ApiError(422, errors);
  }
  await savePlaneSettings(c.env.DB, payload);
  return c.json(await namingService.namingView(c.env.DB));
});

/**
 * WHAT: set (or clear, with `label: null`) one combination's literal name.
 *
 * WHY every reference is checked before writing: a name row is addressed by
 * (node, inbound view, exit), and a typo must be a 422 rather than a row that
 * nothing will ever read.
 */
adminNames.put(`${PREFIX}/overrides`, async (c) => {
  const payload = await parseJsonBody(c.req.raw, LinkNameOverrideIn);
  const node = await db.getNode(c.env.DB, payload.node_id);
  if (node === null) {
    throw new ApiError(404, "node not found");
  }
  if (payload.label !== null && payload.label === "") {
    throw new ApiError(422, "label must not be empty");
  }
  const registry = await loadRegistry(c.env.DB, node);
  const inbound = registry.inboundById.get(payload.inbound_id);
  if (inbound === undefined) {
    throw new ApiError(422, `unknown inbound '${payload.inbound_id}'`);
  }
  if (payload.link_id !== "") {
    const link = registry.links.find((entry) => entry.id === payload.link_id);
    if (link === undefined || link.inbound_id !== inbound.id) {
      throw new ApiError(
        422,
        `unknown link '${payload.link_id}' for inbound '${payload.inbound_id}'`,
      );
    }
  }
  const outbound = registry.outboundById.get(payload.outbound_id);
  if (outbound === undefined) {
    throw new ApiError(422, `unknown outbound '${payload.outbound_id}'`);
  }
  if (outbound.kind === "block") {
    throw new ApiError(422, `outbound '${payload.outbound_id}' is the block route`);
  }
  if (payload.label === null) {
    await db.deleteLinkName(
      c.env.DB,
      node.id,
      inbound.id,
      payload.link_id,
      outbound.id,
    );
  } else {
    await db.upsertLinkName(c.env.DB, {
      node_id: node.id,
      inbound_id: inbound.id,
      link_id: payload.link_id,
      outbound_id: outbound.id,
      label: payload.label,
      created_at: nowSeconds(),
    });
  }
  return c.json(await namingService.namingView(c.env.DB));
});
