/**
 * All database access lives behind this module.
 *
 * D1 is the only backend, and this file is the only place it is spoken to.
 * Callers pass the `env.DB` binding in explicitly and never see SQL: every
 * function here takes `(db, ...)` and returns plain decoded objects.
 *
 * WHY async everywhere: D1 has no synchronous API, so every read and write
 * is a promise. The asymmetry is the convention, not an accident: pure code
 * (core/, the pure services) stays synchronous; anything that touches a
 * binding is async.
 *
 * WHY this is the only file containing SQL: the data model lives in
 * `migrations/*.sql`, but every query that reads or writes it lives here,
 * so schema and access patterns are findable in exactly two places. Reads
 * use `.all()` (rows), writes use `.run()` (nothing to return).
 *
 * There is no second backend and no fallback: the app runs only under
 * workerd, and the binding is typed and present or the request never
 * reaches a handler.
 */

/** WHAT: one raw row as D1 hands it back (column name -> storage value). */
export type Row = Record<string, unknown>;

/** WHAT: a value D1 accepts as a bound parameter. */
type Param = string | number | null;

/** WHAT: one node row, with the opaque config already decoded. */
export type NodeRow = {
  id: string;
  label: string;
  address: string;
  config_json: Record<string, unknown> | null;
  token_hash: string | null;
  applied_hash: string | null;
  last_seen: number | null;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  /** The Xray-rules-dat release the node last installed, NULL until known. */
  geodata_version: string | null;
  last_error: string | null;
  /** Agent-reported nginx health: NULL unknown, 0 failed, 1 ok. */
  nginx_ok: number | null;
  nginx_error: string | null;
  /** The certificate-manifest ETag the node last synced successfully. */
  cert_etag: string | null;
  /** Unix seconds of the last successful certificate sync. */
  cert_synced_at: number | null;
  /** Which ACME environment's current certificates this node receives. */
  cert_environment: "production" | "staging";
  /** The protocol the node last declared at enroll or heartbeat; NULL until
   * then, and the reader defaults a missing column to NULL so a deploy whose
   * migration lagged is harmless. Compared against PROTOCOL_VERSION in the
   * sync view's skew warning. */
  protocol: number | null;
  created_at: number;
};

/** WHAT: one global user row. */
export type UserRow = {
  username: string;
  status: string;
  expire: number | null;
  note: string | null;
  /** The subscription capability token, plaintext. */
  sub_token: string | null;
  sub_token_created_at: number | null;
  created_at: number;
};

/** WHAT: one (user, node) access row with its JSON columns decoded. */
export type AccessRow = {
  username: string;
  node_id: string;
  allowed_inbounds: string[];
  allowed_outbounds: string[];
  uuids: Record<string, string>;
};

/** WHAT: one stored REALITY key row (the columns `listRealityKeys` reads). */
export type RealityKeyRow = {
  inbound_id: string;
  private_key: string;
  created_at: number;
};

/** WHAT: one registered inbound: plane identity plus its current config tag. */
export type NodeInboundRow = {
  node_id: string;
  id: string;
  tag: string;
  label: string;
  created_at: number;
};

/** WHAT: one registered outbound: plane identity plus its current config tag. */
export type NodeOutboundRow = NodeInboundRow;

/**
 * WHAT: the two maintenance actions a node action row can name.
 *
 * WHY `update_xray` stays in the list even though nothing requests it: rows
 * written before the action was withdrawn are still read, and a server may
 * still report a result for one of them. `update_geodata` is the only
 * requestable action.
 */
export const NODE_ACTIONS = ["update_xray", "update_geodata"] as const;
export type NodeAction = (typeof NODE_ACTIONS)[number];

/** WHAT: one node maintenance action row, as stored. */
export type NodeActionRow = {
  node_id: string;
  action: NodeAction;
  target: string | null;
  state: "pending" | "ok" | "failed";
  message: string | null;
  requested_at: number;
  finished_at: number | null;
};

/** WHAT: one link variant row with its overrides decoded. */
export type InboundLinkRow = {
  node_id: string;
  id: string;
  inbound_id: string;
  label: string;
  overrides: Record<string, string | number>;
  created_at: number;
};

/** WHAT: one literal name for an (inbound view, exit) combination. */
export type LinkNameRow = {
  node_id: string;
  inbound_id: string;
  link_id: string;
  outbound_id: string;
  label: string;
  created_at: number;
};

/** WHAT: the plane's naming knobs, as stored (a missing row means default). */
export type PlaneSettingsRow = {
  link_name_template: string;
  subscription_title_template: string;
  updated_at: number;
};

const ACCESS_JSON_COLS = ["allowed_inbounds", "allowed_outbounds", "uuids"];
const LINK_JSON_COLS = ["overrides"];

/**
 * WHAT: run one read statement and return all rows.
 *
 * WHY a helper per direction: reads need `.all()` and writes need `.run()`,
 * and keeping that split in two three-line helpers means no caller ever
 * chooses the wrong one.
 */
async function selectRows(
  db: D1Database,
  sql: string,
  params: Param[] = [],
): Promise<Row[]> {
  const result = await db.prepare(sql).bind(...params).all();
  return (result.results ?? []) as Row[];
}

/** WHAT: run one write statement, discarding its meta. */
async function executeWrite(
  db: D1Database,
  sql: string,
  params: Param[] = [],
): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

/**
 * WHAT: decode JSON-text columns of one row into real structures.
 *
 * WHY this lives here: SQLite (and D1) have no list/dict column types, so
 * lists and maps are stored as JSON text; this is the single spot that
 * turns them back into real structures.
 */
export function rowToDictWithJson(row: Row, jsonCols: readonly string[]): Row {
  const decoded = { ...row };
  for (const col of jsonCols) {
    decoded[col] = JSON.parse(decoded[col] as string) as unknown;
  }
  return decoded;
}

/**
 * WHAT: decode one node row; `config_json` NULL means "no config yet".
 *
 * WHY decode here and not in callers: the config blob is opaque, but
 * "is it set?" is a decision every node endpoint makes, and a decoded
 * object (or null) is the shape the service layer compares against.
 */
function nodeRow(row: Row): NodeRow {
  const node = { ...row } as unknown as NodeRow;
  node.config_json =
    row["config_json"] === null || row["config_json"] === undefined
      ? null
      : (JSON.parse(row["config_json"] as string) as Record<string, unknown>);
  // WHY the coalesce: SELECT * returns the column only when the migration
  // has run; a reader that never throws on a lagging schema is what makes
  // the migration safe to apply through the deploy pipeline.
  node.protocol =
    row["protocol"] === undefined || row["protocol"] === null
      ? null
      : Number(row["protocol"]);
  return node;
}

/** WHAT: decode one access row's JSON columns into real lists/dicts. */
function accessRow(row: Row): AccessRow {
  return rowToDictWithJson(row, ACCESS_JSON_COLS) as unknown as AccessRow;
}

/** WHAT: decode one link variant's JSON overrides into a real object. */
function inboundLinkRow(row: Row): InboundLinkRow {
  return rowToDictWithJson(row, LINK_JSON_COLS) as unknown as InboundLinkRow;
}

/** WHAT: return every node, id-ordered (deterministic lists for the UI). */
export async function listNodes(db: D1Database): Promise<NodeRow[]> {
  const rows = await selectRows(db, "SELECT * FROM nodes ORDER BY id");
  return rows.map(nodeRow);
}

/** WHAT: fetch one node by id, or null when missing. */
export async function getNode(
  db: D1Database,
  nodeId: string,
): Promise<NodeRow | null> {
  const rows = await selectRows(db, "SELECT * FROM nodes WHERE id = ?", [nodeId]);
  return rows.length > 0 ? nodeRow(rows[0] as Row) : null;
}

/**
 * WHAT: insert one complete node row (server-generated fields included).
 *
 * WHY it takes a complete object: deciding what values a new node gets is
 * business logic that belongs to the service layer; this function only
 * knows how to store what it is given. Agent-facing columns start as NULL —
 * nothing is filled until an agent reports. `cert_environment` starts at
 * production: consuming staging certificates is a deliberate per-node
 * switch, never a default.
 */
export async function createNode(
  db: D1Database,
  node: {
    id: string;
    label: string;
    address: string;
    created_at: number;
    config_json?: Record<string, unknown> | null;
  },
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO nodes (id, label, address, config_json, cert_environment, created_at)
        VALUES (?, ?, ?, ?, 'production', ?)
        `,
    [
      node.id,
      node.label,
      node.address,
      node.config_json != null ? JSON.stringify(node.config_json) : null,
      node.created_at,
    ],
  );
}

/**
 * WHAT: overwrite the editable columns (label, address, cert environment)
 * of one node.
 *
 * WHY these three only: the id is the identity (never renamed via update)
 * and `config_json` has its own setter — `setNodeConfig` — because saving a
 * config is a distinct act that also triggers a sync. `cert_environment` is
 * written from the row the service merged, so an update that does not
 * mention it keeps the stored value instead of resetting it.
 */
export async function replaceNode(
  db: D1Database,
  node: {
    id: string;
    label: string;
    address: string;
    cert_environment: "production" | "staging";
  },
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE nodes SET label = ?, address = ?, cert_environment = ? WHERE id = ?",
    [node.label, node.address, node.cert_environment, node.id],
  );
}

/**
 * WHAT: delete one node and every row scoped to it, atomically.
 *
 * WHY one batch: D1 has no interactive transactions here, and a half-deleted
 * node (children gone, row left, or the reverse) would either look alive
 * while being unusable or leave orphan rows nothing can reach. `batch` runs
 * the statements as one unit.
 *
 * WHY children first: the row goes last, so a failure before it leaves a node
 * whose scoped state is already gone and can simply be deleted again — never
 * a live node pointing at missing access or keys.
 */
export async function deleteNode(db: D1Database, nodeId: string): Promise<void> {
  const statements = [
    "DELETE FROM user_node_access WHERE node_id = ?",
    "DELETE FROM reality_keys WHERE node_id = ?",
    "DELETE FROM inbound_links WHERE node_id = ?",
    "DELETE FROM link_names WHERE node_id = ?",
    "DELETE FROM node_inbounds WHERE node_id = ?",
    "DELETE FROM node_outbounds WHERE node_id = ?",
    "DELETE FROM node_cert_domains WHERE node_id = ?",
    "DELETE FROM node_actions WHERE node_id = ?",
    "DELETE FROM nodes WHERE id = ?",
  ].map((sql) => db.prepare(sql).bind(nodeId));
  await db.batch(statements);
}

/**
 * WHAT: store (or clear, with null) one node's opaque authored config.
 *
 * WHY JSON text: the config is an object the plane never interprets; it is
 * stored verbatim so a render reads back exactly what was pasted.
 */
export async function setNodeConfig(
  db: D1Database,
  nodeId: string,
  config: Record<string, unknown> | null,
): Promise<void> {
  const text = config !== null ? JSON.stringify(config) : null;
  await executeWrite(db, "UPDATE nodes SET config_json = ? WHERE id = ?", [
    text,
    nodeId,
  ]);
}

/**
 * WHAT: store one node's bearer-token hash, replacing any previous one.
 *
 * WHY a replace and not a history: rotation invalidates immediately — the
 * old hash dies the moment the new one is stored, so there is exactly one
 * valid token per node at any time.
 */
export async function setTokenHash(
  db: D1Database,
  nodeId: string,
  tokenHash: string,
): Promise<void> {
  await executeWrite(db, "UPDATE nodes SET token_hash = ? WHERE id = ?", [
    tokenHash,
    nodeId,
  ]);
}

/**
 * WHAT: overwrite one node's agent-reported liveness columns in one statement.
 *
 * WHY one fixed statement: the service layer computes the complete desired
 * values first (including the heartbeat cheap-write decision), so the SQL
 * never needs a dynamic column list — same reasoning as `replaceUser`.
 * `last_seen` NULL means "never contacted" (pending).
 */
export async function touchNode(
  db: D1Database,
  nodeId: string,
  lastSeen: number | null,
  health: string | null,
  agentVersion: string | null,
  xrayVersion: string | null,
  geodataVersion: string | null,
  lastError: string | null,
  appliedHash: string | null,
  protocol: number | null,
): Promise<void> {
  await executeWrite(
    db,
    `
        UPDATE nodes
        SET last_seen = ?, health = ?, agent_version = ?,
            xray_version = ?, geodata_version = ?, last_error = ?,
            applied_hash = ?, protocol = ?
        WHERE id = ?
        `,
    [
      lastSeen,
      health,
      agentVersion,
      xrayVersion,
      geodataVersion,
      lastError,
      appliedHash,
      protocol,
      nodeId,
    ],
  );
}

/** WHAT: return one node's maintenance actions, action-name ordered. */
export async function listNodeActions(
  db: D1Database,
  nodeId: string,
): Promise<NodeActionRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM node_actions WHERE node_id = ? ORDER BY action",
    [nodeId],
  );
  return rows as unknown as NodeActionRow[];
}

/**
 * WHAT: record (or replace) one pending action request for a node.
 *
 * WHY replace: asking twice for the same action means "do it again" — the
 * previous outcome, success or failure, is superseded rather than stacked.
 *
 * WHY generic over the action name: the row type still admits `update_xray`
 * so historical rows stay readable; `update_geodata` is the only action the
 * plane creates.
 */
export async function requestNodeAction(
  db: D1Database,
  nodeId: string,
  action: NodeAction,
  target: string | null,
  requestedAt: number,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO node_actions (node_id, action, target, state, message, requested_at, finished_at)
        VALUES (?, ?, ?, 'pending', NULL, ?, NULL)
        ON CONFLICT(node_id, action) DO UPDATE SET
            target = excluded.target,
            state = 'pending',
            message = NULL,
            requested_at = excluded.requested_at,
            finished_at = NULL
        `,
    [nodeId, action, target, requestedAt],
  );
}

/** WHAT: finish one action with its outcome; a missing row is a no-op. */
export async function finishNodeAction(
  db: D1Database,
  nodeId: string,
  action: string,
  state: "ok" | "failed",
  message: string | null,
  finishedAt: number,
): Promise<void> {
  // WHY the action is a string, not the NodeAction union: a newer server may
  // report an action name this plane has never requested; the WHERE then
  // matches no row and the report is an idempotent no-op (the liveness
  // touch that records last_seen happens in the caller either way).
  await executeWrite(
    db,
    `
        UPDATE node_actions
        SET state = ?, message = ?, finished_at = ?
        WHERE node_id = ? AND action = ?
        `,
    [state, message, finishedAt, nodeId, action],
  );
}

/**
 * WHAT: store one node's agent-reported certificate/nginx status columns.
 *
 * WHY a separate setter from `touchNode`: the cert stage report must
 * not touch `applied_hash`/`health`/`last_error` — a `stage=cert` report
 * carries nginx/cert facts only, and one statement per concern keeps that
 * separation mechanically true. `cert_etag` is stored in the quoted form
 * the agent sent ("\"<hex>\"").
 */
export async function setNodeCertStatus(
  db: D1Database,
  nodeId: string,
  values: {
    nginx_ok: number | null;
    nginx_error: string | null;
    cert_etag: string | null;
    cert_synced_at: number | null;
  },
): Promise<void> {
  await executeWrite(
    db,
    `
        UPDATE nodes
        SET nginx_ok = ?, nginx_error = ?, cert_etag = ?, cert_synced_at = ?
        WHERE id = ?
        `,
    [values.nginx_ok, values.nginx_error, values.cert_etag, values.cert_synced_at, nodeId],
  );
}

/** WHAT: return every user's global row, username-ordered. */
export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const rows = await selectRows(db, "SELECT * FROM users ORDER BY username");
  return rows as unknown as UserRow[];
}

/**
 * WHAT: fetch one user's global row by username, or null when not found.
 *
 * WHY global fields only: status/expire/note are user-wide; the per-node
 * access lives in `user_node_access` and is joined by the services that
 * need it.
 */
export async function getUser(
  db: D1Database,
  username: string,
): Promise<UserRow | null> {
  const rows = await selectRows(db, "SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  return rows.length > 0 ? (rows[0] as unknown as UserRow) : null;
}

/**
 * WHAT: fetch one user's global row by subscription token, or null.
 *
 * WHY no constant-time compare (unlike the node token): the token is
 * compared through a unique-index lookup rather than against a stored hash,
 * and 256 bits of entropy make timing side channels worthless — the attacker
 * cannot guess a prefix one byte at a time when every wrong guess is a full
 * 43-character miss. The index is what makes the lookup O(log n).
 */
export async function getUserBySubToken(
  db: D1Database,
  subToken: string,
): Promise<UserRow | null> {
  const rows = await selectRows(db, "SELECT * FROM users WHERE sub_token = ?", [
    subToken,
  ]);
  return rows.length > 0 ? (rows[0] as unknown as UserRow) : null;
}

/**
 * WHAT: store one user's subscription token (and when it was minted).
 *
 * WHY a dedicated setter outside `replaceUser`: the profile edit path
 * overwrites the user's editable columns and must never clobber the token;
 * keeping the token out of that statement makes the blur impossible.
 */
export async function setSubToken(
  db: D1Database,
  username: string,
  subToken: string,
  createdAt: number,
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE users SET sub_token = ?, sub_token_created_at = ? WHERE username = ?",
    [subToken, createdAt, username],
  );
}

/** WHAT: insert the global user row (identity and server facts only). */
export async function createUser(
  db: D1Database,
  user: {
    username: string;
    status: string;
    expire: number | null;
    note: string | null;
    sub_token: string | null;
    sub_token_created_at: number | null;
    created_at: number;
  },
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO users (username, status, expire, note, sub_token,
                           sub_token_created_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
    [
      user.username,
      user.status,
      user.expire,
      user.note,
      user.sub_token,
      user.sub_token_created_at,
      user.created_at,
    ],
  );
}

/**
 * WHAT: overwrite the editable global columns of one user row.
 *
 * WHY a full overwrite of just these columns: the service layer merges
 * partial changes first, so this stays one fixed SQL statement with no
 * dynamic column list — same reasoning as the archived panel.
 */
export async function replaceUser(
  db: D1Database,
  user: { username: string; status: string; expire: number | null; note: string | null },
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE users SET status = ?, expire = ?, note = ? WHERE username = ?",
    [user.status, user.expire, user.note, user.username],
  );
}

/**
 * WHAT: delete one user's access rows and then the user row.
 *
 * WHY access rows first: removing children first means the worst failure
 * case is an orphaned user with no access, never an access row pointing at
 * a missing user.
 */
export async function deleteUser(
  db: D1Database,
  username: string,
): Promise<void> {
  await executeWrite(db, "DELETE FROM user_node_access WHERE username = ?", [
    username,
  ]);
  await executeWrite(db, "DELETE FROM users WHERE username = ?", [username]);
}

/** WHAT: return one user's access rows, node-id ordered (deterministic). */
export async function listAccessForUser(
  db: D1Database,
  username: string,
): Promise<AccessRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE username = ? ORDER BY node_id",
    [username],
  );
  return rows.map(accessRow);
}

/**
 * WHAT: return one node's access rows, username-ordered.
 *
 * WHY username order: the render pipeline consumes this list directly; a
 * deterministic order is what makes two renders of the same database state
 * byte-identical, which content-hash convergence needs.
 */
export async function listAccessForNode(
  db: D1Database,
  nodeId: string,
): Promise<AccessRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE node_id = ? ORDER BY username",
    [nodeId],
  );
  return rows.map(accessRow);
}

/**
 * WHAT: fetch one (user, node) access row, or null when there is none.
 *
 * WHY it exists: the uuid rule needs the row's existing uuid map to keep
 * pairs stable across edits — only genuinely new outbound tags mint a uuid.
 */
export async function getAccess(
  db: D1Database,
  username: string,
  nodeId: string,
): Promise<AccessRow | null> {
  const rows = await selectRows(
    db,
    "SELECT * FROM user_node_access WHERE username = ? AND node_id = ?",
    [username, nodeId],
  );
  return rows.length > 0 ? accessRow(rows[0] as Row) : null;
}

/**
 * WHAT: insert or replace one (user, node) access row.
 *
 * WHY replace and not a partial update: the service layer computes the
 * complete desired row (existing uuids merged with new ones) first, so the
 * SQL stays one fixed statement. `ON CONFLICT` covers both first membership
 * and re-saving an existing one.
 */
export async function upsertAccess(
  db: D1Database,
  username: string,
  nodeId: string,
  allowedInbounds: string[],
  allowedOutbounds: string[],
  uuids: Record<string, string>,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO user_node_access
            (username, node_id, allowed_inbounds, allowed_outbounds, uuids)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(username, node_id) DO UPDATE SET
            allowed_inbounds = excluded.allowed_inbounds,
            allowed_outbounds = excluded.allowed_outbounds,
            uuids = excluded.uuids
        `,
    [
      username,
      nodeId,
      JSON.stringify(allowedInbounds),
      JSON.stringify(allowedOutbounds),
      JSON.stringify(uuids),
    ],
  );
}

/** WHAT: remove one (user, node) access row; a missing row is not an error. */
export async function deleteAccess(
  db: D1Database,
  username: string,
  nodeId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM user_node_access WHERE username = ? AND node_id = ?",
    [username, nodeId],
  );
}

/**
 * WHAT: return one node's REALITY keys as {inbound_id: key row}.
 *
 * WHY keyed by the registered inbound id and not the tag: rebinding an
 * inbound to a renamed tag must keep its key, or every client using that
 * inbound would be locked out for no reason.
 */
export async function listRealityKeys(
  db: D1Database,
  nodeId: string,
): Promise<Record<string, RealityKeyRow>> {
  const rows = await selectRows(
    db,
    "SELECT inbound_id, private_key, created_at FROM reality_keys WHERE node_id = ?",
    [nodeId],
  );
  const keys: Record<string, RealityKeyRow> = {};
  for (const row of rows) {
    keys[row["inbound_id"] as string] = row as unknown as RealityKeyRow;
  }
  return keys;
}

/**
 * WHAT: insert or overwrite one node's key for one inbound tag.
 *
 * WHY an upsert: generation (first key for a tag) and rotation (fresh key
 * for an existing tag) are the same storage operation — replace whatever is
 * stored with the given key and timestamp.
 */
export async function upsertRealityKey(
  db: D1Database,
  nodeId: string,
  inboundTag: string,
  privateKey: string,
  createdAt: number,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO reality_keys (node_id, inbound_id, private_key, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(node_id, inbound_id) DO UPDATE SET
            private_key = excluded.private_key,
            created_at = excluded.created_at
        `,
    [nodeId, inboundTag, privateKey, createdAt],
  );
}

/** WHAT: return every registered inbound of one node, tag-ordered. */
export async function listNodeInbounds(
  db: D1Database,
  nodeId: string,
): Promise<NodeInboundRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM node_inbounds WHERE node_id = ? ORDER BY tag",
    [nodeId],
  );
  return rows as unknown as NodeInboundRow[];
}

/**
 * WHAT: register one inbound tag, ignoring a concurrent duplicate.
 *
 * WHY OR IGNORE: the lazy sync runs from read paths, and two requests can
 * race on the same new tag. The unique (node_id, tag) index makes the loser
 * a no-op instead of an error.
 */
export async function insertNodeInbound(
  db: D1Database,
  row: NodeInboundRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT OR IGNORE INTO node_inbounds (node_id, id, tag, label, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
    [row.node_id, row.id, row.tag, row.label, row.created_at],
  );
}

/** WHAT: point one registered inbound at a (possibly renamed) config tag. */
export async function updateNodeInbound(
  db: D1Database,
  nodeId: string,
  inboundId: string,
  tag: string,
  label: string,
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE node_inbounds SET tag = ?, label = ? WHERE node_id = ? AND id = ?",
    [tag, label, nodeId, inboundId],
  );
}

/** WHAT: remove one registered inbound; a missing row is not an error. */
export async function deleteNodeInbound(
  db: D1Database,
  nodeId: string,
  inboundId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM node_inbounds WHERE node_id = ? AND id = ?",
    [nodeId, inboundId],
  );
  await deleteLinkNamesForInbound(db, nodeId, inboundId);
}

/** WHAT: return every registered outbound of one node, tag-ordered. */
export async function listNodeOutbounds(
  db: D1Database,
  nodeId: string,
): Promise<NodeOutboundRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM node_outbounds WHERE node_id = ? ORDER BY tag",
    [nodeId],
  );
  return rows as unknown as NodeOutboundRow[];
}

/** WHAT: register one outbound tag, ignoring a concurrent duplicate. */
export async function insertNodeOutbound(
  db: D1Database,
  row: NodeOutboundRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT OR IGNORE INTO node_outbounds (node_id, id, tag, label, created_at)
        VALUES (?, ?, ?, ?, ?)
        `,
    [row.node_id, row.id, row.tag, row.label, row.created_at],
  );
}

/** WHAT: point one registered outbound at a (possibly renamed) config tag. */
export async function updateNodeOutbound(
  db: D1Database,
  nodeId: string,
  outboundId: string,
  tag: string,
  label: string,
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE node_outbounds SET tag = ?, label = ? WHERE node_id = ? AND id = ?",
    [tag, label, nodeId, outboundId],
  );
}

/** WHAT: remove one registered outbound; a missing row is not an error. */
export async function deleteNodeOutbound(
  db: D1Database,
  nodeId: string,
  outboundId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM node_outbounds WHERE node_id = ? AND id = ?",
    [nodeId, outboundId],
  );
  await deleteLinkNamesForOutbound(db, nodeId, outboundId);
}

/** WHAT: return one node's link variants in deterministic display order. */
export async function listInboundLinks(
  db: D1Database,
  nodeId: string,
): Promise<InboundLinkRow[]> {
  const rows = await selectRows(
    db,
    "SELECT * FROM inbound_links WHERE node_id = ? ORDER BY inbound_id, id",
    [nodeId],
  );
  return rows.map(inboundLinkRow);
}

/** WHAT: fetch one link variant by node and id, or null when missing. */
export async function getInboundLink(
  db: D1Database,
  nodeId: string,
  linkId: string,
): Promise<InboundLinkRow | null> {
  const rows = await selectRows(
    db,
    "SELECT * FROM inbound_links WHERE node_id = ? AND id = ?",
    [nodeId, linkId],
  );
  return rows.length > 0 ? inboundLinkRow(rows[0] as Row) : null;
}

/** WHAT: insert one complete link variant (server facts included). */
export async function createInboundLink(
  db: D1Database,
  link: InboundLinkRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO inbound_links
            (node_id, id, inbound_id, label, overrides, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
    [
      link.node_id,
      link.id,
      link.inbound_id,
      link.label,
      JSON.stringify(link.overrides),
      link.created_at,
    ],
  );
}

/**
 * WHAT: overwrite one variant's inbound, label, and overrides.
 *
 * WHY a fixed update: the service merges partial changes first, so SQL
 * stays one statement. The variant id is never changed here.
 */
export async function updateInboundLink(
  db: D1Database,
  link: InboundLinkRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        UPDATE inbound_links
        SET inbound_id = ?, label = ?, overrides = ?
        WHERE node_id = ? AND id = ?
        `,
    [
      link.inbound_id,
      link.label,
      JSON.stringify(link.overrides),
      link.node_id,
      link.id,
    ],
  );
}

/** WHAT: remove one link variant; a missing row is not an error. */
export async function deleteInboundLink(
  db: D1Database,
  nodeId: string,
  linkId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM inbound_links WHERE node_id = ? AND id = ?",
    [nodeId, linkId],
  );
  await deleteLinkNamesForLink(db, nodeId, linkId);
}

/** WHAT: return one node's combination names in deterministic order. */
export async function listLinkNames(
  db: D1Database,
  nodeId: string,
): Promise<LinkNameRow[]> {
  const rows = await selectRows(
    db,
    `
        SELECT * FROM link_names
        WHERE node_id = ?
        ORDER BY inbound_id, link_id, outbound_id
        `,
    [nodeId],
  );
  return rows as unknown as LinkNameRow[];
}

/** WHAT: store (or replace) one combination's literal name. */
export async function upsertLinkName(
  db: D1Database,
  row: LinkNameRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO link_names
            (node_id, inbound_id, link_id, outbound_id, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id, inbound_id, link_id, outbound_id)
        DO UPDATE SET label = excluded.label
        `,
    [
      row.node_id,
      row.inbound_id,
      row.link_id,
      row.outbound_id,
      row.label,
      row.created_at,
    ],
  );
}

/** WHAT: remove one combination's name; a missing row is not an error. */
export async function deleteLinkName(
  db: D1Database,
  nodeId: string,
  inboundId: string,
  linkId: string,
  outboundId: string,
): Promise<void> {
  await executeWrite(
    db,
    `
        DELETE FROM link_names
        WHERE node_id = ? AND inbound_id = ? AND link_id = ? AND outbound_id = ?
        `,
    [nodeId, inboundId, linkId, outboundId],
  );
}

/**
 * WHAT: drop the names of one link variant (all its exits).
 *
 * WHY the explicit cascades: the schema has no foreign keys by convention, so
 * deleting the thing a row names is this module's job — same rule the
 * registry applies to variants, keys, and access rows.
 */
export async function deleteLinkNamesForLink(
  db: D1Database,
  nodeId: string,
  linkId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM link_names WHERE node_id = ? AND link_id = ?",
    [nodeId, linkId],
  );
}

/** WHAT: drop the names of every view of one inbound. */
export async function deleteLinkNamesForInbound(
  db: D1Database,
  nodeId: string,
  inboundId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM link_names WHERE node_id = ? AND inbound_id = ?",
    [nodeId, inboundId],
  );
}

/** WHAT: drop every name that targeted one exit. */
export async function deleteLinkNamesForOutbound(
  db: D1Database,
  nodeId: string,
  outboundId: string,
): Promise<void> {
  await executeWrite(
    db,
    "DELETE FROM link_names WHERE node_id = ? AND outbound_id = ?",
    [nodeId, outboundId],
  );
}

/** WHAT: read the plane's naming knobs; null means "never written". */
export async function getPlaneSettings(
  db: D1Database,
): Promise<PlaneSettingsRow | null> {
  const rows = await selectRows(db, "SELECT * FROM plane_settings WHERE id = 1");
  return rows.length > 0 ? (rows[0] as unknown as PlaneSettingsRow) : null;
}

/** WHAT: store the plane's naming knobs (one row, inserted on first write). */
export async function savePlaneSettings(
  db: D1Database,
  settings: PlaneSettingsRow,
): Promise<void> {
  await executeWrite(
    db,
    `
        INSERT INTO plane_settings
            (id, link_name_template, subscription_title_template, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            link_name_template = excluded.link_name_template,
            subscription_title_template = excluded.subscription_title_template,
            updated_at = excluded.updated_at
        `,
    [
      settings.link_name_template,
      settings.subscription_title_template,
      settings.updated_at,
    ],
  );
}

/**
 * WHAT: rewrite references stored against a raw tag into the tag's new id.
 *
 * WHY this exists: before the registry, link variants and REALITY keys were
 * keyed by the config tag. When a tag cannot be an id verbatim (it has
 * spaces, or is very long) the registry mints a slug, and existing rows must
 * follow it or they would silently detach from their inbound. A key that is
 * already stored under the new id wins; the stale copy is dropped.
 */
export async function remapInboundRefs(
  db: D1Database,
  nodeId: string,
  from: string,
  to: string,
): Promise<void> {
  await executeWrite(
    db,
    "UPDATE inbound_links SET inbound_id = ? WHERE node_id = ? AND inbound_id = ?",
    [to, nodeId, from],
  );
  await executeWrite(
    db,
    "UPDATE OR IGNORE reality_keys SET inbound_id = ? WHERE node_id = ? AND inbound_id = ?",
    [to, nodeId, from],
  );
  await executeWrite(
    db,
    "DELETE FROM reality_keys WHERE node_id = ? AND inbound_id = ?",
    [nodeId, from],
  );
}
