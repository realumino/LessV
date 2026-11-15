/**
 * Business rules for nodes: creation facts and config storage.
 *
 * WHY this layer exists: nodes are the fleet's primary resource. Their
 * rules are thin (the server stamps created_at, the config blob is opaque)
 * but they belong here, not in the router — routers do HTTP, services hold
 * rules, `db` holds SQL. Nothing is pushed after a write; agents converge
 * on their next heartbeat.
 */

import * as db from "../db";
import type { NodeCreate, NodeOut, NodeUpdate } from "../models";
import { localTagErrors } from "./qualify_service";
import { loadRegistry } from "./registry_service";

const REPORTED_MAX_LEN = 255;

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * WHAT: true when `value` is an IPv4 literal that is not a private, loopback,
 * link-local, shared or unspecified range.
 *
 * WHY the narrow allow-list: `bytes()` already rejects anything that is not
 * four dotted decimal octets, so this only has to name the ranges a node
 * cannot legitimately own on the public internet.
 */
function isGlobalIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 168) return false; // private 192.168/16
  return true;
}

/**
 * WHAT: expand one IPv6 literal into its eight 16-bit groups, or null when it
 * is not a literal.
 *
 * WHY hand-parsed: there is no IP-literal helper in workerd, and the plane
 * only needs "is this an address, and which range" — a full address type
 * would be a dependency for one display field.
 */
function ipv6Groups(value: string): number[] | null {
  if (value.includes("%")) return null; // a zone id means link-local
  const doubleColons = value.split("::").length - 1;
  if (doubleColons > 1) return null;
  const [head, tail] = doubleColons === 1 ? value.split("::") : [value, null];
  const parse = (text: string): number[] | null => {
    if (text === "") return [];
    const groups: number[] = [];
    const pieces = text.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) return null;
        const octets = piece.split(".").map(Number);
        if (octets.some((octet) => octet > 255)) return null;
        const [a, b, c, d] = octets as [number, number, number, number];
        groups.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };
  const headGroups = parse(head ?? "");
  const tailGroups = tail === null ? [] : parse(tail);
  if (headGroups === null || tailGroups === null) return null;
  const total = headGroups.length + tailGroups.length;
  if (doubleColons === 1) {
    if (total > 7) return null;
    return [...headGroups, ...new Array(8 - total).fill(0), ...tailGroups];
  }
  return total === 8 ? headGroups : null;
}

/**
 * WHAT: true when the report is a globally routable IP literal.
 *
 * WHY: a bridge-networked server detects its container address
 * (`172.17.0.2`), and a NATed host can detect a private one. The plane already
 * receives the public address from the edge, so a private literal is noise,
 * not a fact — falling back keeps the fleet view honest without a server
 * change.
 */
export function isGlobalAddressLiteral(value: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return isGlobalIpv4(value);
  const groups = ipv6Groups(value);
  if (groups === null) return false;
  const first = groups[0] as number;
  const allZero = groups.every((group) => group === 0);
  if (allZero) return false; // unspecified
  if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return false; // ::1
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  // IPv4-mapped (::ffff:a.b.c.d) carries an IPv4 judgement.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const embedded = `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
    return isGlobalIpv4(embedded);
  }
  return true;
}

/** WHAT: the old sanitization: present, bounded, no embedded whitespace. */
function usableAddress(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const value = candidate.trim();
  if (value && value.length <= REPORTED_MAX_LEN && !/\s/.test(value)) {
    return value;
  }
  return null;
}

/**
 * WHAT: pick the reported address to store: the agent's claim when it is a
 * public literal, else the edge observation.
 *
 * WHY the agent's detected_ip usually wins: PROTOCOL.md defines it as the
 * node's own best guess at its public address, and the edge is the fallback
 * for servers that send nothing usable. WHY only a public literal is
 * accepted: under bridge networking the server detects the container address
 * and reports it verbatim, which is not a fact about the node's reachability.
 * The edge header keeps the old sanitization only — it is not user input.
 */
export function reportedAddressFor(
  detectedIp: string | null | undefined,
  connectingIp: string | null | undefined,
): string | null {
  const detected = usableAddress(detectedIp);
  if (detected !== null && isGlobalAddressLiteral(detected)) {
    return detected;
  }
  return usableAddress(connectingIp);
}

/**
 * WHAT: project a db node row to the NodeOut shape.
 *
 * WHY has_config: a list view must learn which nodes have a config without
 * fetching every config blob.
 */
export function toOut(node: db.NodeRow): NodeOut {
  return {
    id: node.id,
    label: node.label,
    address: node.address,
    reported_address: node.reported_address,
    cert_environment: node.cert_environment,
    created_at: node.created_at,
    has_config: node.config_json !== null,
  };
}

/**
 * WHAT: create a node row; no config and no token yet.
 *
 * WHY no token: the bearer token is minted separately (POST .../token) so
 * creation and credential issuance stay distinct operator actions — the
 * plaintext is shown once at mint time.
 */
export async function createNode(
  conn: D1Database,
  data: NodeCreate,
): Promise<NodeOut> {
  await db.createNode(conn, {
    id: data.id,
    label: data.label,
    address: data.address,
    created_at: nowSeconds(),
  });
  return toOut((await db.getNode(conn, data.id)) as db.NodeRow);
}

/**
 * WHAT: merge a partial update (null = unchanged); null when missing.
 *
 * WHY no sync here: label, address, and the cert environment never change a
 * rendered config — the address only feeds share links (derived at request
 * time) and the environment only selects which current certificate the
 * manifest serves. Renaming a label can never break a client.
 */
export async function updateNode(
  conn: D1Database,
  nodeId: string,
  data: NodeUpdate,
): Promise<NodeOut | null> {
  const node = await db.getNode(conn, nodeId);
  if (node === null) {
    return null;
  }
  if (data.label !== null) {
    node.label = data.label;
  }
  if (data.address !== null) {
    node.address = data.address;
  }
  if (data.cert_environment !== null) {
    node.cert_environment = data.cert_environment;
  }
  await db.replaceNode(conn, node);
  return toOut((await db.getNode(conn, nodeId)) as db.NodeRow);
}

/**
 * WHAT: delete one node and everything scoped to it; false when it is gone.
 *
 * WHY the existence check comes first: the caller maps "nothing deleted" to
 * a 404, and a 404 must not touch anything else. Deleting the row revokes
 * the node's bearer token with it — there is no separate revocation step.
 */
export async function deleteNode(
  conn: D1Database,
  nodeId: string,
): Promise<boolean> {
  if ((await db.getNode(conn, nodeId)) === null) {
    return false;
  }
  await db.deleteNode(conn, nodeId);
  return true;
}

/** WHAT: NodeOut-shaped object, or null when missing. */
export async function getNodeOut(
  conn: D1Database,
  nodeId: string,
): Promise<NodeOut | null> {
  const node = await db.getNode(conn, nodeId);
  return node !== null ? toOut(node) : null;
}

/** WHAT: every node in the NodeOut shape, id-ordered. */
export async function listNodesOut(conn: D1Database): Promise<NodeOut[]> {
  return (await db.listNodes(conn)).map(toOut);
}

/**
 * WHAT: replace a node's opaque config, when its tags are valid.
 *
 * WHY the object is stored untouched: the config is opaque — the plane
 * never validates or interprets its structure, except for tag-name
 * validation at paste time. The tuple separates a missing node from an
 * invalid payload: `[false, []]` means 404, `[true, errors]` means 422, and
 * `[true, []]` means the config was saved. Nothing is pushed: each node's
 * agent picks the new render up on its next heartbeat.
 *
 * WHY the registry loads right after saving: every endpoint the document
 * declares must get an id before anything can reference it, and doing it
 * here means the first render after a paste already resolves.
 */
export async function saveConfig(
  conn: D1Database,
  nodeId: string,
  payload: Record<string, unknown>,
): Promise<[boolean, string[]]> {
  const node = await db.getNode(conn, nodeId);
  if (node === null) {
    return [false, []];
  }
  const errors = localTagErrors(payload, nodeId);
  if (errors.length > 0) {
    return [true, errors];
  }
  await db.setNodeConfig(conn, nodeId, payload);
  node.config_json = payload;
  await loadRegistry(conn, node);
  return [true, []];
}
