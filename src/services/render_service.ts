/**
 * Render one node's desired runtime config from stored state.
 *
 * WHY this exists: the pipeline "node + access rows + keys -> runtime
 * config" must be a deterministic, per-node function of the database state,
 * so the plane can compute a node's desired hash with no side effects beyond
 * reads and key generation. The archived panel's pure core
 * (`config_service`) is reused untouched; this module only prepares its
 * inputs.
 *
 * This module is the single seam where the qualifier plugs in: the
 * projection below rebuilds the archived user shape with local tags, and
 * qualification rewrites those shapes (and the config's tags) between
 * projection and `buildConfig`. If `buildConfig` or `applyRealityKeys` ever
 * need editing to make multi-node work, the qualifier is doing its job
 * wrong.
 */

import { canonicalJson } from "../core/python_json";
import * as db from "../db";
import {
  applyRealityKeys,
  buildConfig,
  normalizeTransportNetwork,
  type User,
} from "./config_service";
import {
  qualifyConfig,
  qualifyKeys,
  qualifyUsers,
} from "./qualify_service";
import { ensureKeys } from "./reality_service";
import { loadRegistry, type Registry } from "./registry_service";

/** WHAT: a JSON object carrying authored or rendered config data. */
type Dict = Record<string, unknown>;

/** WHAT: one projected user, in the shape the pure core expects. */
export type ProjectedUser = {
  username: string;
  status: string;
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
};

/**
 * WHAT: return true only for a non-empty object (not an array).
 *
 * WHY: config data is arbitrary JSON; every Python `isinstance(x, dict)`
 * check needs a TS counterpart before touching keys.
 */
function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * WHAT: project one access row into the archived user dict the pure core
 * expects, resolving registered ids to the config's current tags.
 *
 * WHY the email is rebuilt here: storage keys uuids by registered outbound
 * id (so a tag rename keeps them), while `buildConfig` and the allocator
 * look clients up by client email (`username@outboundtag`). `qualifyUsers`
 * rewrites exactly this line — the stored key and the pure core never
 * change.
 *
 * WHY unresolvable ids are warnings and not failures: the access row may
 * predate a config edit, and one stale reference must not stop the rest of
 * the render. The warning is what surfaces the drift to the admin.
 */
export function userShape(
  username: string,
  status: string,
  accessRow: db.AccessRow,
  registry: Registry,
): [ProjectedUser, string[]] {
  const warnings: string[] = [];
  const allowedInbounds: string[] = [];
  for (const id of accessRow.allowed_inbounds) {
    const inbound = registry.inboundById.get(id);
    if (inbound === undefined) {
      warnings.push(`access references unknown inbound '${id}'`);
      continue;
    }
    allowedInbounds.push(inbound.tag);
  }
  const allowedOutbounds: string[] = [];
  for (const id of accessRow.allowed_outbounds) {
    const outbound = registry.outboundById.get(id);
    if (outbound === undefined) {
      warnings.push(`access references unknown outbound '${id}'`);
      continue;
    }
    if (outbound.kind === "block") {
      warnings.push(`outbound '${id}' is the block route and was dropped`);
      continue;
    }
    allowedOutbounds.push(outbound.tag);
  }
  const uuids: Record<string, string> = {};
  for (const [id, uuid] of Object.entries(accessRow.uuids)) {
    const outbound = registry.outboundById.get(id);
    if (outbound === undefined) {
      warnings.push(`uuid for unknown outbound '${id}' was dropped`);
      continue;
    }
    uuids[`${username}@${outbound.tag}`] = uuid;
  }
  return [
    {
      username,
      status,
      allowed_inbounds: allowedInbounds,
      allowed_outbounds: allowedOutbounds,
      uuids,
    },
    warnings,
  ];
}

/**
 * WHAT: return one node's access rows in the archived user shape.
 *
 * WHY disabled users pass through: `config_service.userPermissions`
 * filters them out — it is the copied pure core's policy, and keeping this
 * function a dumb shape-shifter avoids a second place that decides who is
 * rendered. Sorted by username (the database does it) for deterministic
 * renders: the same database state must hash identically every time.
 */
export async function nodeUsers(
  conn: D1Database,
  nodeId: string,
  registry: Registry,
): Promise<[ProjectedUser[], string[]]> {
  const rows = await db.listAccessForNode(conn, nodeId);
  const users = new Map(
    (await db.listUsers(conn)).map((user) => [user.username, user]),
  );
  const projected: ProjectedUser[] = [];
  const warnings: string[] = [];
  for (const row of rows) {
    const user = users.get(row.username);
    if (user === undefined) {
      continue;
    }
    const [shape, shapeWarnings] = userShape(
      row.username,
      user.status,
      row,
      registry,
    );
    projected.push(shape);
    for (const warning of shapeWarnings) {
      warnings.push(`${row.username}: ${warning}`);
    }
  }
  return [projected, warnings];
}

/**
 * WHAT: raise a TypeError when a config's inbound/outbound lists are
 * unusable.
 *
 * WHY an explicit probe: the Python core leaned on dict methods
 * (`inbound.get(...)`) that raised AttributeError on any non-dict entry, and
 * the render path classified every AttributeError/TypeError/KeyError as
 * "malformed". JS property access on primitives never throws, so without
 * this probe a pasted `{"inbounds": "oops"}` would silently render garbage
 * instead of warning. The probe restates the Python requirement: both lists
 * must be arrays of objects. A missing list is left to the downstream code,
 * which fails on it the same way Python did.
 */
function assertRenderableShape(config: Dict): void {
  for (const field of ["inbounds", "outbounds"] as const) {
    const entries = config[field];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      throw new TypeError(`${field} must be a list`);
    }
    for (const entry of entries) {
      if (!isDict(entry)) {
        throw new TypeError(`${field} entries must be objects`);
      }
    }
  }
}

/**
 * WHAT: return `[runtime_config | null, warnings]` for one node.
 *
 * WHY `[null, ...]` instead of raising: "no config yet" and "config too
 * malformed to render" are states the caller must handle calmly — the
 * archived sync warned and skipped, and a user edit must never turn into a
 * 500. The catch is wider than the archived sync's because key generation
 * now sits inside the same block, and `realityInboundTags` probes the
 * config's structure before `buildConfig` ever runs. Key generation happens
 * here so every path that renders also guarantees a stored key per REALITY
 * inbound (one choke point).
 */
export async function desiredConfig(
  env: Env,
  nodeId: string,
): Promise<[Dict | null, string[]]> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null || node.config_json === null) {
    return [null, []];
  }
  const config = node.config_json;
  try {
    assertRenderableShape(config);
    const registry = await loadRegistry(env.DB, node);
    const [users, userWarnings] = await nodeUsers(env.DB, nodeId, registry);
    const keys = await ensureKeys(env, nodeId, registry);
    // The runtime config keys REALITY by tag (Xray's own vocabulary); the
    // registry keys it by id. One translation here keeps every other layer
    // free of the second namespace.
    const tagKeys: Record<string, string> = {};
    for (const [inboundId, privateKey] of Object.entries(keys)) {
      const inbound = registry.inboundById.get(inboundId);
      if (inbound !== undefined) {
        tagKeys[inbound.tag] = privateKey;
      }
    }
    const qualifiedConfig = qualifyConfig(config, nodeId) as Dict;
    const qualifiedUsers = qualifyUsers(users, nodeId) as User[];
    const qualifiedKeys = qualifyKeys(tagKeys, nodeId) as Record<string, string>;
    const [built, warnings] = buildConfig(qualifiedConfig, qualifiedUsers);
    const realityWarnings = applyRealityKeys(built, qualifiedKeys);
    // Normalisation sits between the last mutation and the return value, so
    // the hash and the delivered bytes are computed from the same document.
    const runtime = normalizeTransportNetwork(built);
    return [
      runtime,
      [...registry.warnings, ...userWarnings, ...warnings, ...realityWarnings],
    ];
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }
    return [null, [`config looks malformed (${String(error)}); skipping render`]];
  }
}

/**
 * WHAT: return the content hash of one rendered config.
 *
 * WHY canonical JSON (sorted keys, no whitespace) and not
 * `JSON.stringify`: the hash must depend on the configuration, never on
 * dict ordering or formatting, so equal states always produce equal hashes
 * — the property the agent's applied-hash comparison rests on. WHY async:
 * WebCrypto's digest is the only SHA-256 in workerd.
 */
export async function configHash(runtime: unknown): Promise<string> {
  const canonical = canonicalJson(runtime);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
