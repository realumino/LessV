/**
 * The admin naming view: the templates plus every (view, exit) combination.
 *
 * WHY this exists: a name is derived at render time from the stored template,
 * the registry labels, and any explicit combination override. The admin needs
 * to see exactly that result — not a second implementation of it — so this
 * service renders through the same `linkNameFields`/`resolveLinkName` pair the
 * subscription and the share links use.
 *
 * WHY every node in one response: the template is fleet-wide, so the page that
 * edits it must show its effect everywhere at once. The registry load is the
 * same read the per-node endpoint pages already perform (including the lazy
 * endpoint sync), just repeated per node.
 */

import { compareCodePoints } from "../core/python_json";
import * as db from "../db";
import {
  DEFAULT_LINK_NAME_TEMPLATE,
  LINK_NAME_FIELDS,
  linkNameFields,
  resolveLinkName,
  type LinkNameParts,
} from "./labels";
import { loadRegistry, type Registry } from "./registry_service";
import { loadPlaneSettings, type PlaneSettings } from "./settings_service";

/** WHAT: one combination as the naming page shows it. */
export type NamingCombination = {
  inbound_id: string;
  inbound_tag: string;
  inbound_label: string;
  /** Empty for the inbound's default view. */
  link_id: string;
  link_label: string | null;
  outbound_id: string;
  outbound_tag: string;
  outbound_label: string;
  /** The name a client would see right now. */
  name: string;
  /** The stored literal name, or null when the template produces it. */
  override: string | null;
};

/** WHAT: one node's combinations. */
export type NamingNode = {
  id: string;
  label: string;
  has_config: boolean;
  combinations: NamingCombination[];
};

/** WHAT: the whole naming payload the admin page loads. */
export type NamingView = {
  templates: { link_name_template: string };
  defaults: { link_name_template: string };
  fields: { link_name: readonly string[] };
  nodes: NamingNode[];
};

/** WHAT: the map key of one stored override row. */
function overrideKey(inboundId: string, linkId: string, outboundId: string): string {
  return `${inboundId}\u0000${linkId}\u0000${outboundId}`;
}

/**
 * WHAT: return every combination of one node, in registry order.
 *
 * WHY the default view comes first: it is the link every inbound always has,
 * so a table that lists variants first would read as if the default were
 * missing.
 */
export function combinationsFor(
  node: db.NodeRow,
  registry: Registry,
  settings: PlaneSettings,
): NamingCombination[] {
  const overrides = new Map<string, string>();
  for (const row of registry.names) {
    overrides.set(overrideKey(row.inbound_id, row.link_id, row.outbound_id), row.label);
  }
  const outbounds = registry.outbounds.filter((entry) => entry.kind !== "block");
  const combinations: NamingCombination[] = [];
  for (const inbound of registry.inbounds) {
    const views: Array<{ id: string; label: string | null }> = [
      { id: "", label: null },
      ...registry.links
        .filter((link) => link.inbound_id === inbound.id)
        .sort((left, right) => compareCodePoints(left.id, right.id))
        .map((link) => ({ id: link.id, label: link.label })),
    ];
    for (const view of views) {
      for (const outbound of outbounds) {
        const parts: LinkNameParts = {
          node: { id: node.id, label: node.label },
          inbound: {
            tag: inbound.tag,
            label: inbound.label,
            protocol: inbound.protocol,
          },
          link: view.id === "" ? null : { id: view.id, label: view.label ?? view.id },
          outbound: { tag: outbound.tag, label: outbound.label },
        };
        const override =
          overrides.get(overrideKey(inbound.id, view.id, outbound.id)) ?? null;
        combinations.push({
          inbound_id: inbound.id,
          inbound_tag: inbound.tag,
          inbound_label: inbound.label,
          link_id: view.id,
          link_label: view.label,
          outbound_id: outbound.id,
          outbound_tag: outbound.tag,
          outbound_label: outbound.label,
          name: resolveLinkName({
            template: settings.link_name_template,
            fields: linkNameFields(parts),
            override,
            inboundTag: inbound.tag,
            outboundTag: outbound.tag,
          }),
          override,
        });
      }
    }
  }
  return combinations;
}

/**
 * WHAT: return the templates and every node's combinations.
 *
 * WHY it loads settings once: the template is the same for every node, and
 * the response must show one snapshot rather than one read per node.
 */
export async function namingView(conn: D1Database): Promise<NamingView> {
  const settings = await loadPlaneSettings(conn);
  const nodes: NamingNode[] = [];
  for (const node of await db.listNodes(conn)) {
    const registry = await loadRegistry(conn, node);
    nodes.push({
      id: node.id,
      label: node.label,
      has_config: node.config_json !== null,
      combinations: combinationsFor(node, registry, settings),
    });
  }
  return {
    templates: { link_name_template: settings.link_name_template },
    defaults: { link_name_template: DEFAULT_LINK_NAME_TEMPLATE },
    fields: { link_name: [...LINK_NAME_FIELDS] },
    nodes,
  };
}
