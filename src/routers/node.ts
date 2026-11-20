/**
 * Agent-facing endpoints: the PROTOCOL.md v1 pull contract.
 *
 * WHY a separate router: these are the only endpoints that authenticate by
 * node bearer token instead of the admin key, and every one is scoped to
 * the calling node — a node must never read another node's data. No SQL
 * and no liveness rules live here; endpoints translate between HTTP and
 * the service layer.
 */

import { Hono } from "hono";

import * as db from "../db";
import {
  ActionReportIn,
  ApiError,
  EnrollIn,
  HeartbeatIn,
  parseJsonBody,
  REPORT_STAGES,
  ReportIn,
  StatsIn,
} from "../models";
import * as nodeStateService from "../services/node_state_service";
import * as nodeTokenService from "../services/node_token_service";
import * as renderService from "../services/render_service";
import * as certService from "../cert/service";

/**
 * The pull contract's version, and the floor of the accepted window.
 *
 * WHY the constants live here: both repos implement these numbers, and the
 * agent's zero-code-change guarantee against the plane depends on them not
 * drifting silently. Bumping the version means editing this module, the
 * agent, and docs/PROTOCOL.md together. Protocol 2: the certificate
 * endpoint, the cert stage report, and the renamed node-identity header.
 * Protocol 3: structured maintenance actions, version reporting on the
 * heartbeat, and the action-result endpoint.
 *
 * WHY the window: a fleet cannot follow a plane deploy atomically, so the
 * plane accepts [MIN, CURRENT] and names a mismatch on either side (see
 * docs/PROTOCOL.md → Version skew). MIN === CURRENT today: the window is
 * scaffolding until the next bump, which must ship its own N−1 renderer in
 * ACTION_RENDERERS below — that registry is what makes the bump non-flag-day.
 * Raising MIN deletes a renderer and is therefore a protocol bump in its
 * own right, never a routine release.
 */
export const PROTOCOL_VERSION = 3;
export const SUPPORTED_PROTOCOL_MIN = 3;

/**
 * WHAT: one renderer per accepted protocol for the response fields whose
 * shape differs between protocols — today the heartbeat's `actions`.
 *
 * WHY a registry and not an if-chain: the next protocol bump adds its entry
 * beside this one, and tests/pure/protocol_freeze.test.ts fails while any
 * accepted protocol lacks a renderer. That test is what turns "support the
 * previous shape" from a promise into an enforced invariant; deleting the
 * registry would make every bump a flag day again. WHY exported: the freeze
 * test walks the accepted range against it — that is its whole enforcement.
 */
export const ACTION_RENDERERS: Record<
  number,
  (rows: db.NodeActionRow[]) => unknown
> = {
  [PROTOCOL_VERSION]: nodeStateService.pendingActions,
};

/**
 * WHAT: run the renderer the request's declared protocol asks for.
 *
 * WHY no fallback: assertProtocol has already narrowed the protocol into the
 * window, and the freeze test guarantees every accepted protocol has an
 * entry — reaching this error means the registry and the window disagree,
 * which must fail loudly, not silently render protocol CURRENT's shape for
 * an older server.
 */
function renderActions(protocol: number, rows: db.NodeActionRow[]): unknown {
  const render = ACTION_RENDERERS[protocol];
  if (render === undefined) {
    throw new ApiError(
      500,
      `no action renderer registered for protocol ${protocol}`,
    );
  }
  return render(rows);
}

export const nodeApi = new Hono<{ Bindings: Env }>();

/**
 * WHAT: return the authenticated node row, or throw 401.
 *
 * WHY every mismatch looks identical: a missing header, an unknown id, a
 * node with no minted token, and a wrong token must be indistinguishable
 * from the outside, and nothing about the attempt is logged. The node id
 * selects the row (so a valid request can name the node); the bearer token
 * proves it. The split on the first space mirrors Python's
 * `authorization.partition(" ")`, so `Bearer  tok` presents `" tok"` and
 * fails, exactly as it did before the port.
 */
async function requireNode(env: Env, request: Request): Promise<db.NodeRow> {
  const authorization = request.headers.get("Authorization") ?? "";
  // WHY two header names: X-Vela-Server is the contract's name for "which
  // node row this token must prove". X-Lessv-Node is the name a server built
  // before the rename sends, and it stays readable so an older build is not
  // locked out by a header nobody asked it to change.
  const headerNodeId =
    request.headers.get("X-Vela-Server") ??
    request.headers.get("X-Lessv-Node") ??
    "";
  const spaceIndex = authorization.indexOf(" ");
  const scheme =
    spaceIndex < 0 ? authorization : authorization.slice(0, spaceIndex);
  const presented = spaceIndex < 0 ? "" : authorization.slice(spaceIndex + 1);
  const node = headerNodeId ? await db.getNode(env.DB, headerNodeId) : null;
  if (
    node === null ||
    scheme.toLowerCase() !== "bearer" ||
    !presented ||
    !(await nodeTokenService.verifyToken(node.token_hash, presented))
  ) {
    throw new ApiError(401, "invalid node credentials");
  }
  return node;
}

/**
 * WHAT: reject a protocol the plane cannot honor, explicitly, and name the
 * direction of the mismatch.
 *
 * WHY 400 and not 422: the body parsed fine — the plane is refusing to
 * reinterpret a version it does not understand, per PROTOCOL.md. WHY the
 * sentence differs by side: a server older than SUPPORTED_PROTOCOL_MIN has
 * a wire shape this plane cannot even describe, so it gets the generic
 * `unsupported protocol N`; a server newer than PROTOCOL_VERSION is a
 * deployment-order mistake the plane can name exactly, and the sentence
 * tells the operator which side to upgrade first.
 */
function assertProtocol(payload: { protocol: number }): void {
  if (payload.protocol > PROTOCOL_VERSION) {
    throw new ApiError(
      400,
      `plane speaks protocol ${PROTOCOL_VERSION}; node speaks ` +
        `${payload.protocol} — upgrade the plane first`,
    );
  }
  if (payload.protocol < SUPPORTED_PROTOCOL_MIN) {
    throw new ApiError(400, `unsupported protocol ${payload.protocol}`);
  }
}

/**
 * WHAT: first contact — record versions/liveness, return metadata + hash.
 *
 * WHY idempotent: re-running enroll (e.g. after editing agent.toml) is the
 * correct recovery action — it records the same facts and returns the same
 * shape, converging rather than duplicating anything.
 *
 * WHY nothing about the caller's address is stored: the fleet view answers
 * "when did it last report", and the share-link host stays the admin-set
 * domain in `nodes.address`. A server's `detected_ip` is accepted and
 * ignored so an older build is not rejected for sending it.
 */
nodeApi.post("/api/node/enroll", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, EnrollIn);
  assertProtocol(payload);
  const at = nodeStateService.now();
  await nodeStateService.touchFromValues(c.env.DB, node.id, {
    last_seen: at,
    health: node.health,
    agent_version: payload.agent_version || node.agent_version,
    xray_version: payload.xray_version || node.xray_version,
    geodata_version: node.geodata_version,
    last_error: node.last_error,
    applied_hash: node.applied_hash,
    protocol: payload.protocol,
  });
  const [wanted] = await nodeStateService.desiredHash(c.env, node.id);
  const fresh = (await db.getNode(c.env.DB, node.id)) as db.NodeRow;
  // WHY every body names the plane's protocol: the server logs it on change,
  // so the log says which side is old without a deploy on either end.
  return c.json({
    id: fresh.id,
    label: fresh.label,
    address: fresh.address,
    state: "active",
    desired_hash: wanted,
    protocol: PROTOCOL_VERSION,
  });
});

/**
 * WHAT: the 30s poll — compare hashes cheaply, write liveness rarely, and
 * carry any maintenance action the admin requested.
 *
 * WHY the write is conditional: heartbeats are the hottest endpoint in the
 * system and almost always carry no news — persisting every one would be
 * hundreds of pointless writes a minute at fleet scale.
 */
nodeApi.post("/api/node/heartbeat", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, HeartbeatIn);
  assertProtocol(payload);
  const at = nodeStateService.now();
  const [wanted] = await nodeStateService.desiredHash(c.env, node.id);
  const values = nodeStateService.heartbeatValues(node, payload, at);
  if (nodeStateService.shouldTouch(node, values, at)) {
    await nodeStateService.touchFromValues(c.env.DB, node.id, values);
  }
  // The actions are rendered in the shape the request declared, so a server
  // inside the window reads only fields of its own protocol.
  const actions = renderActions(
    payload.protocol,
    await db.listNodeActions(c.env.DB, node.id),
  );
  return c.json({
    desired_hash: wanted,
    actions,
    protocol: PROTOCOL_VERSION,
  });
});

/**
 * WHAT: record the outcome of one maintenance action the plane requested.
 *
 * WHY its own endpoint and not a `report` stage: an action result carries no
 * config hash and must never move `health`/`applied_hash` — it changes the
 * installed versions and the action row only. Idempotent: a report for a row
 * that no longer exists is accepted and changes nothing.
 */
nodeApi.post("/api/node/action", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, ActionReportIn);
  assertProtocol(payload);
  if (!(db.NODE_ACTIONS as readonly string[]).includes(payload.action)) {
    // WHY a log and not an error: the version-skew policy accepts what it
    // understands and ignores the rest. An unknown action name matches no
    // pending row, so the report below is an idempotent no-op either way;
    // the log is how a skew becomes visible server-side.
    console.warn(
      JSON.stringify({
        event: "node.action_unknown",
        nodeId: node.id,
        action: payload.action,
      }),
    );
  }
  const at = nodeStateService.now();
  await nodeStateService.touchFromValues(
    c.env.DB,
    node.id,
    nodeStateService.actionReportValues(node, payload, at),
  );
  await db.finishNodeAction(
    c.env.DB,
    node.id,
    payload.action,
    payload.ok ? "ok" : "failed",
    payload.ok ? null : payload.error,
    at,
  );
  return c.json({ protocol: PROTOCOL_VERSION });
});

/**
 * WHAT: return this node's fully rendered runtime config, exactly as run.
 *
 * WHY `?hash=` returns 409 on mismatch: the agent asks for the hash its
 * heartbeat named, and if the plane moved on since, serving current bytes
 * would let the agent record the wrong hash as applied — so the agent
 * re-heartbeats instead. WHY no-store: the body carries every UUID plus the
 * REALITY private key — it must never sit in a cache. The agent never
 * transforms, merges, or second-guesses it.
 */
nodeApi.get("/api/node/config", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const [runtime] = await renderService.desiredConfig(c.env, node.id);
  if (runtime === null) {
    throw new ApiError(404, "no renderable config");
  }
  const wanted = await renderService.configHash(runtime);
  const presented = c.req.query("hash");
  if (presented !== undefined && presented !== wanted) {
    throw new ApiError(409, {
      message: "desired config moved; re-heartbeat",
      desired_hash: wanted,
    });
  }
  return c.json(
    { hash: wanted, config: runtime, protocol: PROTOCOL_VERSION },
    200,
    { "Cache-Control": "no-store" },
  );
});

/**
 * WHAT: record one apply attempt; failures keep the old applied hash.
 *
 * WHY a missing report is not a problem: the next heartbeat re-syncs
 * reality anyway — reports are for diagnosis and the audit trail, not for
 * correctness. Duplicate reports are safe by construction.
 */
nodeApi.post("/api/node/report", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, ReportIn);
  assertProtocol(payload);
  if (!(REPORT_STAGES as readonly string[]).includes(payload.stage)) {
    // WHY a log and not an error: a newer server may name a stage this
    // plane does not know. reportValues writes last_seen only for it — the
    // liveness columns are never moved by an unguessable stage — and this
    // log is what makes the skew visible server-side.
    console.warn(
      JSON.stringify({
        event: "node.report_unknown_stage",
        nodeId: node.id,
        stage: payload.stage,
      }),
    );
  }
  const values = nodeStateService.reportValues(
    node,
    payload,
    nodeStateService.now(),
  );
  await nodeStateService.touchFromValues(c.env.DB, node.id, values);
  // Certificate/nginx facts ride on cert reports and apply reports alike;
  // absent fields are written as NULL only by stage=cert reports.
  if (payload.stage === "cert" || payload.cert_etag !== null || payload.nginx_ok !== null) {
    await db.setNodeCertStatus(c.env.DB, node.id, {
      nginx_ok: payload.nginx_ok === null ? null : payload.nginx_ok ? 1 : 0,
      nginx_error: payload.nginx_error,
      cert_etag: payload.cert_etag,
      cert_synced_at: payload.cert_synced_at,
    });
  }
  return c.json({ protocol: PROTOCOL_VERSION });
});

/**
 * WHAT: the node's certificate manifest (assigned active domains, the
 * current certificates of the node's cert environment, composite ETag).
 *
 * WHY 304 on If-None-Match: certificate bytes are big and identical almost
 * every poll; the ETag is the cheap question. WHY no-store: the body
 * carries every private key — it must never sit in a cache.
 */
nodeApi.get("/api/node/certs", async (c) => {
  const node = await requireNode(c.env, c.req.raw);
  let manifest;
  try {
    manifest = await certService.nodeCertManifest(c.env, node.id);
  } catch (error) {
    // All-or-nothing: an unreadable artifact is a 5xx with the object path,
    // never a partial manifest (§3.2). The agent keeps its previous files.
    throw new ApiError(
      500,
      error instanceof Error ? error.message : "cert manifest failed",
    );
  }
  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifNoneMatch !== undefined && ifNoneMatch === manifest.etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: manifest.etag, "Cache-Control": "no-store" },
    });
  }
  return c.json(
    { ...manifest, protocol: PROTOCOL_VERSION },
    200,
    {
      ETag: manifest.etag,
      "Cache-Control": "no-store",
    },
  );
});

/**
 * WHAT: accept absolute traffic counters; validate now, accumulate in M7.
 *
 * WHY the counters are not stored: `node_stats` and the max(0, new-old)
 * accumulation do not exist until M7 — but the agent ships
 * absolute-plus-boot-id from v1 so history can start accumulating the day
 * the plane learns to keep it.
 */
nodeApi.post("/api/node/stats", async (c) => {
  await requireNode(c.env, c.req.raw);
  const payload = await parseJsonBody(c.req.raw, StatsIn);
  assertProtocol(payload);
  return c.json({
    accepted: Object.keys(payload.counters).length,
    protocol: PROTOCOL_VERSION,
  });
});
