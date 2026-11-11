/**
 * The pure model behind the user form's per-node access editor.
 *
 * WHY this is a separate, tested module: the access map a user form
 * submits is *authoritative* — a node left out of it loses its access row
 * on the server. That makes "which nodes are in the payload" the riskiest
 * piece of frontend logic in the app, so it lives here as plain functions
 * with no React and no fetch, and the vitest suite pins it.
 *
 * The rule the admin should never have to remember: sections are keyed and
 * labelled by node, the checkboxes are the node's *registered* endpoints
 * (id + label), and the blackhole route is never offered — it is the
 * fallback for unmatched traffic, not an exit anyone can be assigned.
 */

import type {
  AccessIn,
  AccessOut,
  InboundOut,
  NodeOut,
  OutboundOut,
} from "../types";

/** One node's section in the access editor (lists of registered ids). */
export interface NodeAccessSection {
  authorized: boolean;
  allowedInbounds: string[];
  allowedOutbounds: string[];
}

/** The whole form's access state, keyed by node id. */
export type AccessForm = Record<string, NodeAccessSection>;

/** One node's registered endpoints, as the editor offers them. */
export interface NodeEndpoints {
  inbounds: InboundOut[];
  outbounds: OutboundOut[];
}

/** The endpoint lists of every node, keyed by node id. */
export type EndpointsByNode = Record<string, NodeEndpoints>;

/** One checkbox: a registered endpoint, or a stored id the config lost. */
export interface AccessOption {
  id: string;
  label: string;
  detail: string;
  /** True when the stored id no longer resolves against the config. */
  missing: boolean;
}

/** Build a form with every node present but unauthorized (create mode). */
export function emptyAccessForm(nodes: NodeOut[]): AccessForm {
  const form: AccessForm = {};
  for (const node of nodes) {
    form[node.id] = {
      authorized: false,
      allowedInbounds: [],
      allowedOutbounds: [],
    };
  }
  return form;
}

/**
 * WHAT: build a form from an existing user, marking the nodes they belong
 * to and dropping the block route from their outbounds.
 *
 * WHY only nodes in the list: the payload's keys must be nodes that still
 * exist (a stale access row would 404 the save); the node list is the
 * authority for what exists. Stored ids are copied verbatim (including ones
 * the config no longer declares) so an edit never silently drops access —
 * the editor shows those as missing instead.
 *
 * WHY block ids are dropped: they are not exits. Keeping them in the form
 * would resubmit a payload the server now rejects, so a legacy row is
 * cleaned up by the next save.
 */
export function formFromUser(
  user: { access: Record<string, AccessOut> },
  nodes: NodeOut[],
  endpoints: EndpointsByNode,
): AccessForm {
  const form: AccessForm = {};
  for (const node of nodes) {
    const entry = user.access[node.id];
    const blockIds = new Set(
      (endpoints[node.id]?.outbounds ?? [])
        .filter((outbound) => outbound.kind === "block")
        .map((outbound) => outbound.id),
    );
    form[node.id] = entry
      ? {
          authorized: true,
          allowedInbounds: [...entry.allowed_inbounds],
          allowedOutbounds: entry.allowed_outbounds.filter(
            (id) => !blockIds.has(id),
          ),
        }
      : { authorized: false, allowedInbounds: [], allowedOutbounds: [] };
  }
  return form;
}

/** Flip one node's membership without touching its selections. */
export function toggleNode(form: AccessForm, nodeId: string): AccessForm {
  const section = form[nodeId];
  if (!section) {
    return form;
  }
  return { ...form, [nodeId]: { ...section, authorized: !section.authorized } };
}

/** Add or remove one registered id from one node's inbound or outbound list. */
export function toggleOption(
  form: AccessForm,
  nodeId: string,
  list: "inbound" | "outbound",
  id: string,
): AccessForm {
  const section = form[nodeId];
  if (!section) {
    return form;
  }
  const key = list === "inbound" ? "allowedInbounds" : "allowedOutbounds";
  const current = section[key];
  const next = current.includes(id)
    ? current.filter((item) => item !== id)
    : [...current, id];
  return { ...form, [nodeId]: { ...section, [key]: next } };
}

/**
 * WHAT: convert the form into the authoritative access payload.
 *
 * WHY unauthorized nodes are omitted: their absence is what deletes the
 * server-side access row. An authorized node with empty lists is still a
 * member — it simply has nothing allocated yet.
 */
export function toAccessPayload(form: AccessForm): Record<string, AccessIn> {
  const payload: Record<string, AccessIn> = {};
  for (const [nodeId, section] of Object.entries(form)) {
    if (!section.authorized) {
      continue;
    }
    payload[nodeId] = {
      allowed_inbounds: [...section.allowedInbounds],
      allowed_outbounds: [...section.allowedOutbounds],
    };
  }
  return payload;
}

/**
 * WHAT: the checkboxes one list offers for one node.
 *
 * WHY stored-but-unregistered ids appear: the payload is authoritative, so
 * a stale id would be resubmitted forever (and rejected once the node has a
 * config) unless the admin can see and uncheck it. Registered rows come
 * first, in config order; the stragglers follow, marked missing.
 *
 * WHY block outbounds are absent: the server refuses to assign them, and
 * offering a checkbox that always fails would be a trap.
 */
export function optionsFor(
  kind: "inbound" | "outbound",
  endpoints: NodeEndpoints | undefined,
  selected: string[],
): AccessOption[] {
  const options: AccessOption[] = [];
  const seen = new Set<string>();
  if (kind === "inbound") {
    for (const inbound of endpoints?.inbounds ?? []) {
      seen.add(inbound.id);
      options.push({
        id: inbound.id,
        label: inbound.label,
        detail: inbound.tag,
        missing: false,
      });
    }
  } else {
    for (const outbound of endpoints?.outbounds ?? []) {
      if (outbound.kind === "block") {
        continue;
      }
      seen.add(outbound.id);
      options.push({
        id: outbound.id,
        label: outbound.label,
        detail: outbound.tag,
        missing: false,
      });
    }
  }
  for (const id of selected) {
    if (!seen.has(id)) {
      options.push({ id, label: id, detail: "not in config", missing: true });
    }
  }
  return options;
}
