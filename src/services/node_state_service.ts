/**
 * Rules for node liveness, apply reports, and drift display.
 *
 * WHY this layer exists: heartbeats must be cheap (no write on every poll),
 * reports must translate stage+ok into stored health without touching the
 * applied hash on failure, and the admin sync view must combine a live
 * render with stored facts. Routers do HTTP; `db` does SQL; the decisions
 * live here. Pure helpers stay synchronous so they unit-test without a
 * database; the drift view is async because it renders live.
 */

import * as db from "../db";
import type { ActionReportIn, HeartbeatIn, NodeActionOut, NodeSyncOut, ReportIn } from "../models";
import { configHash, desiredConfig } from "./render_service";
import { certLintWarnings, type LintCert } from "../cert/lint";
import { listNodeAssignedDomains } from "../cert/store/d1";
import { certPathName } from "../cert/models";

export const HEARTBEAT_STALE_AFTER = 60;
export const SUCCESS_STAGES = ["applied", "started"] as const;

/** WHAT: the liveness columns one heartbeat or report wants stored. */
export type LivenessValues = {
  last_seen: number;
  health: string | null;
  agent_version: string | null;
  xray_version: string | null;
  geodata_version: string | null;
  last_error: string | null;
  applied_hash: string | null;
};

/** WHAT: the stored columns these rules compare against (no config, no id). */
type LivenessRow = Pick<
  db.NodeRow,
  | "last_seen"
  | "health"
  | "agent_version"
  | "xray_version"
  | "geodata_version"
  | "last_error"
  | "applied_hash"
>;

/** WHAT: Unix seconds from the plane's clock (the time authority). */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * WHAT: compute the liveness columns one heartbeat wants stored.
 *
 * WHY applied_hash and versions are adopted but health/last_error are
 * preserved: the dashboard shows "as last reported", and the heartbeat is
 * the freshest claim of what runs — health is a diagnosis only a report may
 * set or clear. A version is adopted only when the heartbeat carries one:
 * a missing field means "nothing to report", never "forget it".
 */
export function heartbeatValues(
  node: LivenessRow,
  payload: HeartbeatIn,
  at: number,
): LivenessValues {
  return {
    last_seen: at,
    health: node.health,
    agent_version: payload.agent_version ?? node.agent_version,
    xray_version: payload.xray_version ?? node.xray_version,
    geodata_version: payload.geodata_version ?? node.geodata_version,
    last_error: node.last_error,
    applied_hash: payload.applied_hash,
  };
}

/**
 * WHAT: return true when a heartbeat's values deserve a database write.
 *
 * WHY the 60s staleness rule: at fleet scale an unconditional write per 30s
 * poll is hundreds of writes a minute for no information gain. A write
 * happens only when liveness went stale or a fact actually changed —
 * heartbeats stay cheap.
 */
export function shouldTouch(
  node: LivenessRow,
  values: LivenessValues,
  at: number,
): boolean {
  if (node.last_seen === null) {
    return true;
  }
  if (at - node.last_seen > HEARTBEAT_STALE_AFTER) {
    return true;
  }
  const facts = [
    "health",
    "agent_version",
    "xray_version",
    "geodata_version",
    "last_error",
    "applied_hash",
  ] as const;
  for (const key of facts) {
    if (values[key] !== node[key]) {
      return true;
    }
  }
  return false;
}

/**
 * WHAT: compute the liveness columns one apply report wants stored.
 *
 * WHY a failed apply never moves applied_hash: the node rolled back to
 * last-good, so what runs is still the old hash — recording the failed one
 * would hide the drift the dashboard must show. Success on
 * `applied`/`started` adopts the hash and clears the error; success on
 * earlier stages only clears nothing and moves nothing.
 *
 * WHY stage=cert never writes a diagnosis: a cert-stage report carries
 * nginx/cert facts only (they go to the cert columns); letting it set
 * health/last_error would overwrite Xray state with a process-status
 * claim. Only last_seen moves.
 */
export function reportValues(
  node: LivenessRow,
  payload: ReportIn,
  at: number,
): LivenessValues {
  const values: LivenessValues = {
    last_seen: at,
    health: node.health,
    agent_version: node.agent_version,
    xray_version: node.xray_version,
    geodata_version: node.geodata_version,
    last_error: node.last_error,
    applied_hash: node.applied_hash,
  };
  if (payload.stage === "cert") {
    return values;
  }
  const succeeded =
    payload.ok && (SUCCESS_STAGES as readonly string[]).includes(payload.stage);
  if (succeeded) {
    values.applied_hash = payload.hash;
    values.last_error = null;
    values.health = "ok";
  } else if (!payload.ok) {
    values.last_error = payload.error;
    values.health = `error:${payload.stage}`;
  }
  return values;
}

/** WHAT: write precomputed liveness values through the single db statement. */
export async function touchFromValues(
  conn: D1Database,
  nodeId: string,
  values: LivenessValues,
): Promise<void> {
  await db.touchNode(
    conn,
    nodeId,
    values.last_seen,
    values.health,
    values.agent_version,
    values.xray_version,
    values.geodata_version,
    values.last_error,
    values.applied_hash,
  );
}

/**
 * WHAT: the superseded action rows to advertise on this heartbeat.
 *
 * WHY pending only: a finished action is history the admin reads in the
 * sync view, not a command. An action whose report never arrived stays
 * pending and is re-advertised — the node remembers the last outcome, so a
 * repeated advertisement does not mean a repeated download.
 *
 * WHY a pending `update_xray` row would still be advertised: the plane no
 * longer creates one, but a row written before the action was withdrawn has
 * to reach the server that is still waiting for it. Keeping the row and the
 * advertisement is what makes the removal invisible to a legacy server.
 */
export function pendingActions(
  rows: db.NodeActionRow[],
): Array<{ action: db.NodeAction; version?: string }> {
  const actions: Array<{ action: db.NodeAction; version?: string }> = [];
  for (const row of rows) {
    if (row.state !== "pending") {
      continue;
    }
    if (row.action === "update_xray") {
      actions.push({ action: row.action, version: row.target ?? "latest" });
    } else {
      actions.push({ action: row.action });
    }
  }
  return actions;
}

/**
 * WHAT: apply one action result to the liveness columns.
 *
 * WHY a successful update adopts the reported version here: the node just
 * proved what it installed, and waiting for the next heartbeat to repeat it
 * would leave a window where the panel shows the version the machine no
 * longer runs. Failures change no version — the node rolled back (or never
 * swapped), so the old value is still the truth.
 */
export function actionReportValues(
  node: LivenessRow,
  payload: ActionReportIn,
  at: number,
): LivenessValues {
  const version = payload.ok ? payload.version : null;
  return {
    last_seen: at,
    health: node.health,
    agent_version: node.agent_version,
    xray_version:
      version !== null && payload.action === "update_xray"
        ? version
        : node.xray_version,
    geodata_version:
      version !== null && payload.action === "update_geodata"
        ? version
        : node.geodata_version,
    last_error: node.last_error,
    applied_hash: node.applied_hash,
  };
}

/** WHAT: return the actions of one node in the sync-view shape. */
export async function listActions(
  conn: D1Database,
  nodeId: string,
): Promise<NodeActionOut[]> {
  return (await db.listNodeActions(conn, nodeId)).map((row) => ({
    action: row.action,
    state: row.state,
    target: row.target,
    message: row.message,
    requested_at: row.requested_at,
    finished_at: row.finished_at,
  }));
}

/**
 * WHAT: return `[hex hash | null, warnings]` of one node's desired config.
 *
 * WHY None instead of raising: no config and malformed config are states
 * the agent must ride out calmly — the heartbeat carries null and the agent
 * changes nothing.
 */
export async function desiredHash(
  env: Env,
  nodeId: string,
): Promise<[string | null, string[]]> {
  const [runtime, warnings] = await desiredConfig(env, nodeId);
  if (runtime === null) {
    return [null, warnings];
  }
  return [await configHash(runtime), warnings];
}

/**
 * WHAT: return the NodeSyncOut-shaped drift view for one node, or null.
 *
 * WHY the render happens here: drift is desired-vs-applied, and desired is
 * a pure function of current database state — computing it live means the
 * view can never go stale the way a stored column would.
 */
export async function syncState(
  env: Env,
  nodeId: string,
): Promise<NodeSyncOut | null> {
  const node = await db.getNode(env.DB, nodeId);
  if (node === null) {
    return null;
  }
  const [runtime, warnings] = await desiredConfig(env, nodeId);
  // Lint is additive and read-only: its warnings follow the render
  // warnings, its failure (a store hiccup) never hides the render itself.
  let lintWarnings: string[] = [];
  let certSummaries: Array<{ domain: string; not_after: string; profile: string }> = [];
  try {
    const lint = await certLintState(env, nodeId, runtime, node, new Date());
    lintWarnings = lint.warnings;
    certSummaries = lint.certs;
  } catch (error) {
    lintWarnings = [`cert lint failed: ${error instanceof Error ? error.message : String(error)}`];
  }
  return {
    node_id: nodeId,
    state: node.last_seen !== null ? "active" : "pending",
    desired_hash: runtime !== null ? await configHash(runtime) : null,
    applied_hash: node.applied_hash,
    in_sync:
      runtime !== null &&
      node.applied_hash === (await configHash(runtime)),
    last_seen: node.last_seen,
    health: node.health,
    agent_version: node.agent_version,
    xray_version: node.xray_version,
    geodata_version: node.geodata_version,
    last_error: node.last_error,
    warnings: [...warnings, ...lintWarnings],
    actions: await listActions(env.DB, nodeId),
    nginx_ok: node.nginx_ok,
    nginx_error: node.nginx_error,
    cert_synced_at: node.cert_synced_at,
    certs: certSummaries,
  };
}

/**
 * WHAT: lint warnings for one node's assigned certificates plus the
 * per-domain expiry summaries the fleet view renders.
 *
 * WHY the node's cert environment: the lint asks whether the config's
 * serverNames are covered by the certificates this node actually serves,
 * and on a staging node that set is the staging current pointers.
 *
 * WHY the store import and not the service: `cert/service` pulls the
 * render path in, which pulls this module — a cycle. The store + pure lint
 * are all the sync view needs.
 */
export async function certLintState(
  env: Env,
  nodeId: string,
  config: Record<string, unknown> | null,
  node: Pick<db.NodeRow, "nginx_ok" | "nginx_error" | "cert_environment">,
  now: Date,
): Promise<{ warnings: string[]; certs: Array<{ domain: string; not_after: string; profile: string }> }> {
  const rows = await listNodeAssignedDomains(env.DB, nodeId, node.cert_environment);
  const certs: LintCert[] = [];
  const summaries: Array<{ domain: string; not_after: string; profile: string }> = [];
  for (const row of rows) {
    if (row.certificate_id === null) continue;
    let sans: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.certificate_sans_json ?? "[]");
      if (Array.isArray(parsed) && parsed.every((name) => typeof name === "string")) {
        sans = parsed;
      }
    } catch {
      sans = [];
    }
    const notAfter = row.certificate_not_after ?? "";
    certs.push({ domain: row.domain_name, sans, not_after: notAfter });
    summaries.push({
      domain: certPathName(row.domain_name),
      not_after: notAfter,
      profile: row.certificate_profile ?? "",
    });
  }
  return {
    warnings: certLintWarnings({ config, certs, node, now }),
    certs: summaries,
  };
}
