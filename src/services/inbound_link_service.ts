/**
 * Business rules for inbound link variants.
 *
 * WHY this layer exists: every inbound's default view is the inbound row
 * itself (its label names the generated link). A variant is an *extra*
 * client-side view of the same inbound — CDN fronting, another port — and
 * attaches to the registered inbound id, never to a raw tag, so a tag rename
 * keeps it attached. Variants never enter the rendered runtime config, so
 * writing one never syncs a node.
 */

import * as db from "../db";
import type { InboundLinkIn, InboundLinkOut, InboundLinkUpdate } from "../models";
import type { Registry } from "./registry_service";

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** WHAT: project a database row to the InboundLinkOut shape. */
function toOut(link: db.InboundLinkRow): InboundLinkOut {
  return {
    id: link.id,
    inbound_id: link.inbound_id,
    label: link.label,
    overrides: link.overrides,
    created_at: link.created_at,
  };
}

/** WHAT: return semantic errors for a new variant, without touching storage. */
export function validateCreate(
  node: db.NodeRow,
  registry: Registry,
  data: InboundLinkIn,
): string[] {
  if (node.config_json === null) {
    return ["node has no config to attach a link to"];
  }
  if (!registry.inboundById.has(data.inbound_id)) {
    return [`unknown inbound '${data.inbound_id}'`];
  }
  return [];
}

/** WHAT: return semantic errors for a variant update, without storage. */
export function validateUpdate(
  node: db.NodeRow,
  registry: Registry,
  data: InboundLinkUpdate,
): string[] {
  if (data.inbound_id === null) {
    return [];
  }
  if (node.config_json === null) {
    return ["node has no config to attach a link to"];
  }
  if (!registry.inboundById.has(data.inbound_id)) {
    return [`unknown inbound '${data.inbound_id}'`];
  }
  return [];
}

/** WHAT: return one node's variants in deterministic display order. */
export async function listLinks(
  conn: D1Database,
  nodeId: string,
): Promise<InboundLinkOut[]> {
  return (await db.listInboundLinks(conn, nodeId)).map(toOut);
}

/** WHAT: return one variant in API shape, or null when missing. */
export async function getLink(
  conn: D1Database,
  nodeId: string,
  linkId: string,
): Promise<InboundLinkOut | null> {
  const link = await db.getInboundLink(conn, nodeId, linkId);
  return link !== null ? toOut(link) : null;
}

/** WHAT: store one validated variant and stamp its creation time. */
export async function createLink(
  conn: D1Database,
  nodeId: string,
  data: InboundLinkIn,
): Promise<InboundLinkOut> {
  const link: db.InboundLinkRow = {
    node_id: nodeId,
    id: data.id,
    inbound_id: data.inbound_id,
    label: data.label,
    overrides: { ...data.overrides },
    created_at: nowSeconds(),
  };
  await db.createInboundLink(conn, link);
  return toOut(link);
}

/** WHAT: merge a partial variant update; null when it does not exist. */
export async function updateLink(
  conn: D1Database,
  nodeId: string,
  linkId: string,
  data: InboundLinkUpdate,
): Promise<InboundLinkOut | null> {
  const stored = await db.getInboundLink(conn, nodeId, linkId);
  if (stored === null) {
    return null;
  }
  if (data.inbound_id !== null) {
    stored.inbound_id = data.inbound_id;
  }
  if (data.label !== null) {
    stored.label = data.label;
  }
  if (data.overrides !== null) {
    stored.overrides = { ...data.overrides };
  }
  await db.updateInboundLink(conn, stored);
  return toOut((await db.getInboundLink(conn, nodeId, linkId)) as db.InboundLinkRow);
}

/** WHAT: remove one variant; false when it did not exist. */
export async function deleteLink(
  conn: D1Database,
  nodeId: string,
  linkId: string,
): Promise<boolean> {
  if ((await db.getInboundLink(conn, nodeId, linkId)) === null) {
    return false;
  }
  await db.deleteInboundLink(conn, nodeId, linkId);
  return true;
}
