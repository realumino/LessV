/**
 * The node endpoint registry: plane-side identity for inbounds and outbounds.
 *
 * WHY this layer exists: the authored config is the operator's document and
 * stays opaque, but everything the plane stores *about* an endpoint — user
 * access, REALITY keys, link variants — needs a handle that survives the
 * operator renaming a tag. So each inbound/outbound gets a registry row: the
 * row owns the identity (`id`), the config owns the current name (`tag`), and
 * a renamed tag is repaired by rebinding the row, not by re-creating it.
 *
 * WHY the registry is derived, not authored: the config remains the single
 * source of truth for what exists. The sync below only adds rows for tags it
 * has never seen; rows whose tag disappeared are kept (orphaned) so the
 * operator can rebind them and keep every reference.
 *
 * WHY ids are minted from tags: a tag that already looks like an id becomes
 * the id verbatim, which is what makes existing databases migrate with no
 * rewrite at all. Only exotic tags (spaces, over-long) get a slug.
 */

import * as db from "../db";
import {
  inboundSummaries,
  outboundSummaries,
  realityInboundTags,
} from "./config_service";
import { prettyTag } from "./labels";

/** WHAT: a JSON object carrying authored config data. */
type Dict = Record<string, unknown>;

/**
 * WHAT: what an outbound does, as the plane needs to know it.
 *
 * WHY derived and not stored: the config already says it. A stored copy
 * could only drift. `block` is the one kind with a rule attached — it is the
 * fallback route, never an exit a user may be assigned to.
 */
export type OutboundKind = "block" | "direct" | "proxy";

/** WHAT: one registered inbound with the current config's description. */
export type InboundView = {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  network: string;
  security: string;
};

/** WHAT: one registered outbound with the current config's description. */
export type OutboundView = {
  id: string;
  tag: string;
  label: string;
  protocol: string;
  kind: OutboundKind;
};

/** WHAT: everything one request needs to resolve ids and tags. */
export type Registry = {
  inbounds: InboundView[];
  outbounds: OutboundView[];
  /** Variant rows; grouping them by inbound tag is the link builder's job. */
  links: db.InboundLinkRow[];
  /** Literal combination names; the link builder keys them by view and exit. */
  names: db.LinkNameRow[];
  inboundById: Map<string, InboundView>;
  outboundById: Map<string, OutboundView>;
  inboundByTag: Map<string, InboundView>;
  outboundByTag: Map<string, OutboundView>;
  /** Inbounds declaring `realitySettings`, in config order. */
  realityInboundIds: string[];
  warnings: string[];
};

/** WHAT: an id a tag may take verbatim (URL-safe, bounded). */
const VERBATIM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SLUG_BODY = 48;

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** WHAT: turn an arbitrary tag into a lowercase, URL-safe id body. */
function slug(tag: string): string {
  const body = tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_BODY);
  return body || "endpoint";
}

/**
 * WHAT: mint an id for a tag that is not registered yet.
 *
 * WHY `taken` holds tags as well as ids: an id must never collide with
 * another row's *tag* either, or a legacy `tag -> id` reference resolution
 * would be ambiguous.
 */
export function endpointIdFor(tag: string, taken: Set<string>): string {
  const base = VERBATIM_ID.test(tag) ? tag : slug(tag);
  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * WHAT: classify one outbound from its tag and protocol.
 *
 * WHY the tag check as well as the protocol: `BLOCK` is the panel-owned
 * fallback route by convention (the preset writes it, qualification keeps it
 * unprefixed, and the renderer forces it first). Even a misconfigured
 * blackhole under another tag must stay unassignable.
 */
export function outboundKind(tag: string, protocol: unknown): OutboundKind {
  if (tag === "BLOCK" || protocol === "blackhole") {
    return "block";
  }
  if (protocol === "freedom") {
    return "direct";
  }
  return "proxy";
}

/** WHAT: true when a user may be assigned this outbound. */
export function isSelectable(outbound: OutboundView): boolean {
  return outbound.kind !== "block";
}

/**
 * WHAT: return the tag names a config declares, or null when unreadable.
 *
 * WHY null and not an empty list: "the config declares nothing" and "the
 * config is too malformed to read" are different states, and the caller
 * decides which warning to show. Only the shape errors the summarisers raise
 * are swallowed; real bugs still throw.
 */
function tagsOf(
  config: Dict,
  summaries: (config: Dict) => { tag: string }[],
): string[] | null {
  try {
    const entries = summaries(config);
    const tags: string[] = [];
    for (const entry of entries) {
      if (typeof entry.tag === "string" && entry.tag) {
        tags.push(entry.tag);
      }
    }
    return tags;
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

/**
 * WHAT: add a row for every authored tag that has none yet.
 *
 * WHY it writes only for unseen tags: the registry is read on every render
 * and every link request, so a no-op pass must stay a read. A tag that could
 * not keep its own name as an id (spaces, over-long) also moves any legacy
 * `tag`-keyed references — variants and REALITY keys — onto the new id.
 */
async function syncRows(
  conn: D1Database,
  nodeId: string,
  inboundTags: string[] | null,
  outboundTags: string[] | null,
): Promise<void> {
  if (inboundTags !== null) {
    const rows = await db.listNodeInbounds(conn, nodeId);
    const known = new Set(rows.map((row) => row.tag));
    // Ids and tags already in use. The tag being registered is *not* in this
    // set (an existing row for it would have skipped it), so the common case
    // — a tag that already looks like an id — keeps its own name. The other
    // authored tags are added per iteration so a minted id can never shadow
    // a tag that is about to be registered too.
    const taken = new Set<string>([
      ...rows.map((row) => row.id),
      ...rows.map((row) => row.tag),
    ]);
    for (const tag of inboundTags) {
      if (known.has(tag)) {
        continue;
      }
      const candidates = new Set(taken);
      for (const other of inboundTags) {
        if (other !== tag) {
          candidates.add(other);
        }
      }
      const id = endpointIdFor(tag, candidates);
      taken.add(id);
      await db.insertNodeInbound(conn, {
        node_id: nodeId,
        id,
        tag,
        label: prettyTag(tag),
        created_at: nowSeconds(),
      });
      if (id !== tag) {
        await db.remapInboundRefs(conn, nodeId, tag, id);
      }
    }
  }
  if (outboundTags !== null) {
    const rows = await db.listNodeOutbounds(conn, nodeId);
    const known = new Set(rows.map((row) => row.tag));
    const taken = new Set<string>([
      ...rows.map((row) => row.id),
      ...rows.map((row) => row.tag),
    ]);
    for (const tag of outboundTags) {
      if (known.has(tag)) {
        continue;
      }
      const candidates = new Set(taken);
      for (const other of outboundTags) {
        if (other !== tag) {
          candidates.add(other);
        }
      }
      const id = endpointIdFor(tag, candidates);
      taken.add(id);
      await db.insertNodeOutbound(conn, {
        node_id: nodeId,
        id,
        tag,
        label: prettyTag(tag),
        created_at: nowSeconds(),
      });
    }
  }
}

/**
 * WHAT: order rows the way the config declares them, orphans last by tag.
 *
 * WHY config order: the admin reads the plane in the shape of their own
 * document; orphaned rows must not shuffle the ones that still exist.
 */
function inConfigOrder<T extends { tag: string }>(rows: T[], order: string[]): T[] {
  const rank = new Map(order.map((tag, position) => [tag, position]));
  return [...rows].sort((left, right) => {
    const leftRank = rank.get(left.tag);
    const rightRank = rank.get(right.tag);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
    if (leftRank !== undefined) {
      return -1;
    }
    if (rightRank !== undefined) {
      return 1;
    }
    return left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0;
  });
}

/**
 * WHAT: build the registry for one node, syncing rows from its config first.
 *
 * WHY one entry point: render, links, user writes, and the endpoint APIs all
 * need the same id<->tag resolution; one loader keeps them from disagreeing
 * about what an id means.
 */
export async function loadRegistry(
  conn: D1Database,
  node: db.NodeRow,
): Promise<Registry> {
  const config = node.config_json;
  const warnings: string[] = [];
  const inboundTags =
    config === null ? null : tagsOf(config, (value) => inboundSummaries(value));
  const outboundTags =
    config === null ? null : tagsOf(config, (value) => outboundSummaries(value));
  if (config !== null && inboundTags === null) {
    warnings.push("config inbounds are not a list of objects");
  }
  if (config !== null && outboundTags === null) {
    warnings.push("config outbounds are not a list of objects");
  }
  await syncRows(conn, node.id, inboundTags, outboundTags);

  const inboundRows = await db.listNodeInbounds(conn, node.id);
  const outboundRows = await db.listNodeOutbounds(conn, node.id);
  const links = await db.listInboundLinks(conn, node.id);
  const names = await db.listLinkNames(conn, node.id);

  let summaries = new Map<string, ReturnType<typeof inboundSummaries>[number]>();
  if (inboundTags !== null) {
    summaries = new Map(inboundSummaries(config as Dict).map((entry) => [entry.tag, entry]));
  }
  let outSummaries = new Map<string, { tag: string; protocol: string }>();
  if (outboundTags !== null) {
    outSummaries = new Map(
      outboundSummaries(config as Dict).map((entry) => [entry.tag, entry]),
    );
  }

  const orderedInbounds = inConfigOrder(inboundRows, inboundTags ?? []);
  const orderedOutbounds = inConfigOrder(outboundRows, outboundTags ?? []);
  const inbounds: InboundView[] = orderedInbounds.map((row) => {
    const summary = summaries.get(row.tag);
    return {
      id: row.id,
      tag: row.tag,
      label: row.label,
      protocol: summary?.protocol ?? "",
      network: summary?.network ?? "",
      security: summary?.security ?? "",
    };
  });
  const outbounds: OutboundView[] = orderedOutbounds.map((row) => {
    const summary = outSummaries.get(row.tag);
    return {
      id: row.id,
      tag: row.tag,
      label: row.label,
      protocol: summary?.protocol ?? "",
      kind: outboundKind(row.tag, summary?.protocol ?? ""),
    };
  });

  for (const row of orderedInbounds) {
    if (inboundTags !== null && !inboundTags.includes(row.tag)) {
      warnings.push(`inbound '${row.tag}' is not in the config anymore`);
    }
  }
  for (const row of orderedOutbounds) {
    if (outboundTags !== null && !outboundTags.includes(row.tag)) {
      warnings.push(`outbound '${row.tag}' is not in the config anymore`);
    }
  }

  const inboundById = new Map(inbounds.map((entry) => [entry.id, entry]));
  const outboundById = new Map(outbounds.map((entry) => [entry.id, entry]));
  const inboundByTag = new Map(inbounds.map((entry) => [entry.tag, entry]));
  const outboundByTag = new Map(outbounds.map((entry) => [entry.tag, entry]));

  let realityInboundIds: string[] = [];
  if (config !== null) {
    try {
      realityInboundIds = realityInboundTags(config)
        .map((tag) => inboundByTag.get(tag)?.id)
        .filter((id): id is string => id !== undefined);
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
    }
  }

  return {
    inbounds,
    outbounds,
    links,
    names,
    inboundById,
    outboundById,
    inboundByTag,
    outboundByTag,
    realityInboundIds,
    warnings,
  };
}

/**
 * WHAT: what plane-side rows still point at one registered inbound.
 *
 * WHY text and not a boolean: a refused rebind or delete must tell the
 * operator *what* holds the row, or the only recourse is guessing.
 */
async function inboundReferences(
  conn: D1Database,
  nodeId: string,
  inboundId: string,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const row of await db.listAccessForNode(conn, nodeId)) {
    if (row.allowed_inbounds.includes(inboundId)) {
      reasons.push(`access for '${row.username}'`);
    }
  }
  const variants = (await db.listInboundLinks(conn, nodeId)).filter(
    (link) => link.inbound_id === inboundId,
  );
  if (variants.length > 0) {
    reasons.push(
      `link variants ${variants.map((link) => `'${link.id}'`).join(", ")}`,
    );
  }
  if ((await db.listRealityKeys(conn, nodeId))[inboundId] !== undefined) {
    reasons.push("its REALITY key");
  }
  return reasons;
}

/** WHAT: what plane-side rows still point at one registered outbound. */
async function outboundReferences(
  conn: D1Database,
  nodeId: string,
  outboundId: string,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const row of await db.listAccessForNode(conn, nodeId)) {
    if (row.allowed_outbounds.includes(outboundId)) {
      reasons.push(`access for '${row.username}'`);
    } else if (Object.hasOwn(row.uuids, outboundId)) {
      reasons.push(`the uuid of '${row.username}'`);
    }
  }
  return reasons;
}

/**
 * WHAT: return a tag the config declares, or null when it does not.
 *
 * WHY this is the rebind target check: a registry row may only point at a
 * tag the authored config currently declares; anything else would resolve
 * to nothing at render time.
 */
function declaredTag(
  config: Dict | null,
  tag: string,
  field: "inbounds" | "outbounds",
): boolean {
  if (config === null) {
    return false;
  }
  try {
    const entries = config[field];
    if (!Array.isArray(entries)) {
      return false;
    }
    return entries.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Dict)["tag"] === tag,
    );
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return false;
  }
}

/**
 * WHAT: rebind/rename one registered inbound; errors describe why not.
 *
 * WHY a rename in the config can be repaired here: the operator's document
 * is authoritative for what a tag is called, so a tag that disappeared
 * leaves the row orphaned and a brand-new tag gets a brand-new unreferenced
 * row. Pointing the orphan at the new tag (which drops that empty row) is
 * what keeps user access, link variants, and the REALITY key attached.
 *
 * WHY the takeover is refused when the other row is referenced: two rows
 * cannot own one tag, and silently deleting a row someone is assigned to
 * would be data loss. The operator rebinds *that* row instead.
 */
export async function updateInbound(
  conn: D1Database,
  node: db.NodeRow,
  inboundId: string,
  data: { tag: string | null; label: string | null },
): Promise<[InboundView | null, string[]]> {
  const registry = await loadRegistry(conn, node);
  const row = registry.inboundById.get(inboundId);
  if (row === undefined) {
    return [null, []];
  }
  const tag = data.tag !== null ? data.tag : row.tag;
  const label = data.label !== null ? data.label : row.label;
  const errors: string[] = [];
  let takeover: string | null = null;
  if (tag !== row.tag) {
    if (!declaredTag(node.config_json, tag, "inbounds")) {
      errors.push(`unknown inbound tag '${tag}'`);
    }
    const holder = registry.inboundByTag.get(tag);
    if (holder !== undefined && holder.id !== inboundId) {
      const references = await inboundReferences(conn, node.id, holder.id);
      if (references.length > 0) {
        errors.push(
          `tag '${tag}' belongs to inbound '${holder.id}', which still has ` +
            `${references.join(", ")}; rebind that row instead`,
        );
      } else {
        takeover = holder.id;
      }
    }
  }
  if (errors.length > 0) {
    return [null, errors];
  }
  if (takeover !== null) {
    await db.deleteNodeInbound(conn, node.id, takeover);
  }
  await db.updateNodeInbound(conn, node.id, inboundId, tag, label);
  const updated = await loadRegistry(conn, node);
  return [updated.inboundById.get(inboundId) ?? null, []];
}

/** WHAT: rebind/rename one registered outbound; mirrors `updateInbound`. */
export async function updateOutbound(
  conn: D1Database,
  node: db.NodeRow,
  outboundId: string,
  data: { tag: string | null; label: string | null },
): Promise<[OutboundView | null, string[]]> {
  const registry = await loadRegistry(conn, node);
  const row = registry.outboundById.get(outboundId);
  if (row === undefined) {
    return [null, []];
  }
  const tag = data.tag !== null ? data.tag : row.tag;
  const label = data.label !== null ? data.label : row.label;
  const errors: string[] = [];
  let takeover: string | null = null;
  if (tag !== row.tag) {
    if (!declaredTag(node.config_json, tag, "outbounds")) {
      errors.push(`unknown outbound tag '${tag}'`);
    }
    const holder = registry.outboundByTag.get(tag);
    if (holder !== undefined && holder.id !== outboundId) {
      const references = await outboundReferences(conn, node.id, holder.id);
      if (references.length > 0) {
        errors.push(
          `tag '${tag}' belongs to outbound '${holder.id}', which still has ` +
            `${references.join(", ")}; rebind that row instead`,
        );
      } else {
        takeover = holder.id;
      }
    }
  }
  if (errors.length > 0) {
    return [null, errors];
  }
  if (takeover !== null) {
    await db.deleteNodeOutbound(conn, node.id, takeover);
  }
  await db.updateNodeOutbound(conn, node.id, outboundId, tag, label);
  const updated = await loadRegistry(conn, node);
  return [updated.outboundById.get(outboundId) ?? null, []];
}

/**
 * WHAT: delete one registered inbound that no longer exists in the config.
 *
 * WHY the guards: a row still declared by the document would come straight
 * back on the next sync (losing its label), and a row that access, variants,
 * or keys still point at cannot be removed without breaking them.
 */
export async function deleteInbound(
  conn: D1Database,
  node: db.NodeRow,
  inboundId: string,
): Promise<[boolean, string[]]> {
  const registry = await loadRegistry(conn, node);
  const row = registry.inboundById.get(inboundId);
  if (row === undefined) {
    return [false, []];
  }
  if (declaredTag(node.config_json, row.tag, "inbounds")) {
    return [true, [`inbound '${row.tag}' is still declared by the config`]];
  }
  const references = await inboundReferences(conn, node.id, inboundId);
  if (references.length > 0) {
    return [true, [`inbound '${row.tag}' is still referenced by ${references.join(", ")}`]];
  }
  await db.deleteNodeInbound(conn, node.id, inboundId);
  return [true, []];
}

/** WHAT: delete one registered outbound that no longer exists in the config. */
export async function deleteOutbound(
  conn: D1Database,
  node: db.NodeRow,
  outboundId: string,
): Promise<[boolean, string[]]> {
  const registry = await loadRegistry(conn, node);
  const row = registry.outboundById.get(outboundId);
  if (row === undefined) {
    return [false, []];
  }
  if (declaredTag(node.config_json, row.tag, "outbounds")) {
    return [true, [`outbound '${row.tag}' is still declared by the config`]];
  }
  const references = await outboundReferences(conn, node.id, outboundId);
  if (references.length > 0) {
    return [true, [`outbound '${row.tag}' is still referenced by ${references.join(", ")}`]];
  }
  await db.deleteNodeOutbound(conn, node.id, outboundId);
  return [true, []];
}
