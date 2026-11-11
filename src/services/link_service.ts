/**
 * Generate one node's qualified share links from stored state.
 *
 * WHY this layer exists: links combine five node-scoped inputs — access,
 * authored config, the endpoint registry, REALITY keys, and link variants —
 * and all of them are stored local. This module qualifies them consistently,
 * resolves registry ids to the tags the URI actually names, builds readable
 * labels, and delegates URI assembly to the pure share service. It never
 * writes, renders, or syncs: link generation is read-only.
 *
 * WHY ids resolve to tags here: access rows, variants, and keys are stored
 * against registered ids so a config tag rename keeps them; every generated
 * URI and email must still use the tag, because that is what Xray routes on.
 */

import { compareCodePoints } from "../core/python_json";
import * as db from "../db";
import {
  qualifiedInboundTag,
  qualifiedOutboundTag,
  qualifyConfig,
  qualifyKeys,
  qualifyUsers,
} from "./qualify_service";
import { keyMap } from "./reality_service";
import { userShape } from "./render_service";
import { loadRegistry, type Registry } from "./registry_service";
import {
  hasUsableAddress,
  type LinkUser,
  linksForUser,
  type ShareLink,
} from "./share_service";

/** WHAT: a JSON object carrying authored or qualified config data. */
type Dict = Record<string, unknown>;

/**
 * WHAT: one generated link after its owning node id is stamped on.
 *
 * WHY the node id rides on each link: a subscription joins links from
 * several nodes, and each link must carry its own node's address and key
 * derivation. Warnings are prefixed with the node id so a multi-node list
 * stays readable.
 */
export type LinkOut = ShareLink & { node: string };

/** WHAT: an access row paired with the node it points at (null if deleted). */
type AccessPair = [db.AccessRow, db.NodeRow | null];

/** WHAT: a config-bearing entry ready for link generation. */
type LinkEntry = [db.AccessRow, db.NodeRow, Registry];

/**
 * WHAT: everything the two link presentations (admin JSON, subscription
 * body) need from one aggregation pass.
 *
 * WHY counts instead of pre-thrown errors: the admin route maps them to
 * 503/409 and the subscription route ignores them — the aggregation itself
 * must not know HTTP.
 */
export type UserLinks = {
  links: LinkOut[];
  warnings: string[];
  /** Access rows on the user, regardless of node state. */
  accessCount: number;
  /** Rows whose node exists and has a config. */
  configCount: number;
  /** Config-bearing nodes that can produce at least one link. */
  addressableCount: number;
};

/**
 * WHAT: map the registry's readable names onto qualified tags.
 *
 * WHY qualified keys: the link builder sees the qualified config, so it
 * looks labels up by the same qualified names it uses everywhere else.
 * Unknown-language fallbacks (`prettyTag`) are gone: a registered inbound
 * always has a label, because the registry mints one from the tag.
 */
function qualifiedLabels(registry: Registry, nodeId: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const inbound of registry.inbounds) {
    names[qualifiedInboundTag(inbound.tag, nodeId) as string] = inbound.label;
  }
  for (const outbound of registry.outbounds) {
    names[qualifiedOutboundTag(outbound.tag, nodeId) as string] = outbound.label;
  }
  return names;
}

/**
 * WHAT: group link variants by the qualified tag of their inbound.
 *
 * WHY grouping by tag: `linksForUser` walks the qualified config, so a
 * variant must be findable from the tag the config currently uses. Sorting
 * keys and ids keeps the link list deterministic across engines.
 */
function qualifiedVariants(
  registry: Registry,
  nodeId: string,
): Record<string, Dict[]> {
  const grouped: Record<string, Dict[]> = {};
  for (const link of registry.links) {
    const inbound = registry.inboundById.get(link.inbound_id);
    if (inbound === undefined) {
      continue;
    }
    const key = qualifiedInboundTag(inbound.tag, nodeId) as string;
    (grouped[key] ??= []).push({
      id: link.id,
      label: link.label,
      overrides: { ...link.overrides },
    });
  }
  for (const entries of Object.values(grouped)) {
    entries.sort((left, right) =>
      compareCodePoints(String(left["id"] ?? ""), String(right["id"] ?? "")),
    );
  }
  const sorted: Record<string, Dict[]> = {};
  for (const key of Object.keys(grouped).sort(compareCodePoints)) {
    sorted[key] = grouped[key] as Dict[];
  }
  return sorted;
}

/**
 * WHAT: warn for variants whose inbound row no longer exists.
 *
 * WHY only the missing row: a registered inbound whose tag left the config
 * is already reported by the registry; the variant's problem is narrower —
 * it points at an id nothing owns, so it can never produce a link.
 */
function danglingVariantWarnings(registry: Registry): string[] {
  const warnings: string[] = [];
  const ordered = [...registry.links].sort((left, right) =>
    compareCodePoints(left.id, right.id),
  );
  for (const link of ordered) {
    if (!registry.inboundById.has(link.inbound_id)) {
      warnings.push(
        `link '${link.id}' references unknown inbound '${link.inbound_id}'`,
      );
    }
  }
  return warnings;
}

/**
 * WHAT: return REALITY keys indexed by the tags the runtime config uses.
 *
 * WHY a translation step: storage and the registry speak ids; Xray, the
 * qualifier, and the link builder speak tags. One map here is cheaper than
 * teaching every one of them the second namespace.
 */
function tagKeys(registry: Registry, keys: Record<string, string>): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [inboundId, privateKey] of Object.entries(keys)) {
    const inbound = registry.inboundById.get(inboundId);
    if (inbound !== undefined) {
      mapped[inbound.tag] = privateKey;
    }
  }
  return mapped;
}

/**
 * WHAT: return qualified direct and variant links for one node and access
 * row.
 *
 * WHY the qualification order: the link builder reads qualified tags from
 * the config and looks keys up by qualified tag, so config, user, keys, and
 * variants are all rewritten into the same namespace before any URI is
 * assembled. Warnings from the dangling-variant check are appended after
 * the share-service warnings.
 */
export async function nodeLinks(
  env: Env,
  node: db.NodeRow,
  accessRow: db.AccessRow,
  status: string,
  registry: Registry,
): Promise<[ShareLink[], string[]]> {
  const [shaped, shapeWarnings] = userShape(
    accessRow.username,
    status,
    accessRow,
    registry,
  );
  const qualifiedConfig = qualifyConfig(node.config_json, node.id) as Dict;
  const qualifiedUser = qualifyUsers([shaped], node.id)[0] as LinkUser;
  const storedKeys = await keyMap(env, node.id);
  const qualifiedKeys = qualifyKeys(
    tagKeys(registry, storedKeys),
    node.id,
  ) as Record<string, string>;
  const groupedVariants = qualifiedVariants(registry, node.id);
  const linkLabels = qualifiedLabels(registry, node.id);
  const [links, warnings] = linksForUser(
    qualifiedUser,
    qualifiedConfig,
    node.address,
    qualifiedKeys,
    groupedVariants,
    node.label,
    linkLabels,
  );
  warnings.push(...shapeWarnings, ...danglingVariantWarnings(registry));
  return [links, warnings];
}

/** WHAT: return one user's access rows paired with their node rows. */
async function accessPairs(env: Env, username: string): Promise<AccessPair[]> {
  const pairs: AccessPair[] = [];
  for (const row of await db.listAccessForUser(env.DB, username)) {
    pairs.push([row, await db.getNode(env.DB, row.node_id)]);
  }
  return pairs;
}

/**
 * WHAT: separate configless-node warnings from config-bearing pairs.
 *
 * WHY two outputs: the skipped ids become warnings and the rest flow into
 * link generation, so the aggregation never has to re-walk the pairs. The
 * warning names the node from the access row, so a dangling access row
 * cannot crash the list.
 */
function splitConfigPairs(
  pairs: AccessPair[],
): [string[], [db.AccessRow, db.NodeRow][]] {
  const skipped: string[] = [];
  const withConfig: [db.AccessRow, db.NodeRow][] = [];
  for (const [row, node] of pairs) {
    if (node === null || node.config_json === null) {
      skipped.push(`${row.node_id}: has no config; skipped`);
      continue;
    }
    withConfig.push([row, node]);
  }
  return [skipped, withConfig];
}

/**
 * WHAT: return config-bearing entries that can produce at least one link.
 *
 * WHY the variant addresses are part of the check: a variant may supply the
 * client-facing address even when the node has none, so an entry is
 * addressable if any of its views is.
 */
async function addressableEntries(
  env: Env,
  withConfig: [db.AccessRow, db.NodeRow][],
): Promise<LinkEntry[]> {
  const entries: LinkEntry[] = [];
  for (const [row, node] of withConfig) {
    const registry = await loadRegistry(env.DB, node);
    const variantAddresses = registry.links.map(
      (link) => link.overrides["address"],
    );
    if (
      hasUsableAddress(
        node.config_json as Record<string, unknown>,
        node.address,
        variantAddresses,
      )
    ) {
      entries.push([row, node, registry]);
    }
  }
  return entries;
}

/** WHAT: warn for config-bearing nodes that cannot produce a usable address. */
function unaddressableWarnings(
  withConfig: [db.AccessRow, db.NodeRow][],
  entries: LinkEntry[],
): string[] {
  const addressable = new Set(entries.map(([, node]) => node.id));
  return withConfig
    .filter(([, node]) => !addressable.has(node.id))
    .map(([, node]) => `${node.id}: has no usable address`);
}

/**
 * WHAT: build every link across the user's config-bearing nodes.
 *
 * WHY the per-node prefix on warnings: a multi-node list stays readable
 * when each entry names its node; the order (skipped, per-node,
 * unaddressable) is part of the tested contract.
 */
async function collectLinks(
  env: Env,
  userStatus: string,
  entries: LinkEntry[],
): Promise<[LinkOut[], string[]]> {
  const links: LinkOut[] = [];
  const warnings: string[] = [];
  for (const [row, node, registry] of entries) {
    const [generated, nodeWarnings] = await nodeLinks(
      env,
      node,
      row,
      userStatus,
      registry,
    );
    for (const link of generated) {
      links.push({ ...link, node: node.id });
    }
    warnings.push(...nodeWarnings.map((warning) => `${node.id}: ${warning}`));
  }
  return [links, warnings];
}

/**
 * WHAT: aggregate every link the user is entitled to, across every node.
 *
 * WHY this lives in the service and not the router: the admin links route
 * and the subscription body are two presentations of one list, and keeping
 * the walk here means they can never disagree. It is read-only — generating
 * links must not write, render, or sync. Status codes are the caller's
 * business: the counts expose the same boundaries the router used to compute
 * inline.
 */
export async function userLinks(
  env: Env,
  username: string,
  status: string,
): Promise<UserLinks> {
  const pairs = await accessPairs(env, username);
  const [skipped, withConfig] = splitConfigPairs(pairs);
  const entries = await addressableEntries(env, withConfig);
  const [links, entryWarnings] = await collectLinks(env, status, entries);
  const warnings = [
    ...skipped,
    ...entryWarnings,
    ...unaddressableWarnings(withConfig, entries),
  ];
  return {
    links,
    warnings,
    accessCount: pairs.length,
    configCount: withConfig.length,
    addressableCount: entries.length,
  };
}
