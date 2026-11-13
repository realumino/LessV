/**
 * Readable labels used by generated links.
 *
 * Ported from tests/pure/test_labels.py: machine names stay qualified while
 * admins and end users see stable display text.
 *
 * WHY the name is a template: the default composition is the archived
 * `node · subject → exit` line, but an operator whose fleet speaks another
 * language (or wants the exit first, or the protocol in the name) must be able
 * to change it once instead of renaming every endpoint. The default string is
 * therefore the template the code renders and the template the admin sees.
 */

import {
  renderTemplate,
  type TemplateFields,
} from "../core/template";

/** WHAT: the name a generated link gets when no template overrides it. */
export const DEFAULT_LINK_NAME_TEMPLATE = "{node} · {subject} → {outbound}";

/**
 * WHAT: every field a link-name template may reference.
 *
 * WHY `{subject}` exists: it is the archived rule ("the variant's label when
 * it has one, else the inbound's") as a single field, so the default template
 * needs no conditional logic.
 */
export const LINK_NAME_FIELDS = [
  "node",
  "node_id",
  "inbound",
  "inbound_tag",
  "link",
  "link_id",
  "outbound",
  "outbound_tag",
  "subject",
  "protocol",
] as const;

/** WHAT: the parts one generated link is named from. */
export type LinkNameParts = {
  node: { id: string; label: string };
  inbound: { tag: string; label: string; protocol: string };
  link: { id: string; label: string } | null;
  outbound: { tag: string; label: string };
};

/**
 * WHAT: the template field map for one (inbound view, exit) combination.
 *
 * WHY the link id keys nothing here: the caller stores the fields under
 * `linkNameKey`, so this function only translates one combination's parts.
 */
export function linkNameFields(parts: LinkNameParts): TemplateFields {
  const linkLabel = parts.link?.label ?? "";
  return {
    node: parts.node.label,
    node_id: parts.node.id,
    inbound: parts.inbound.label,
    inbound_tag: parts.inbound.tag,
    link: linkLabel,
    link_id: parts.link?.id ?? "",
    outbound: parts.outbound.label,
    outbound_tag: parts.outbound.tag,
    subject: linkLabel || parts.inbound.label,
    protocol: parts.inbound.protocol,
  };
}

/**
 * WHAT: the field map for a caller that has only tags and labels.
 *
 * WHY it exists: the pure tier (and any caller without a registry) still
 * needs the default composition. The result is the same map with the facts it
 * cannot know left empty, so rendering the default template is byte-identical
 * to the archived `linkLabel`.
 */
export function linkNameFieldsFromLabels(
  nodeLabel: string,
  inboundTag: string,
  outboundTag: string,
  labels: Record<string, string>,
  linkLabel?: string | null,
): TemplateFields {
  return linkNameFields({
    node: { id: "", label: nodeLabel },
    inbound: {
      tag: inboundTag,
      label: labels[inboundTag] ?? inboundTag,
      protocol: "",
    },
    link: linkLabel ? { id: "", label: linkLabel } : null,
    outbound: { tag: outboundTag, label: labels[outboundTag] ?? outboundTag },
  });
}

/**
 * WHAT: the map key of one (inbound, link view, exit) combination.
 *
 * WHY the inbound is part of the key: every inbound's *default* view has an
 * empty link id, so without it two inbounds' direct links to the same exit
 * would share one field map — and the last inbound would name them all.
 */
export function linkNameKey(
  inboundTag: string,
  linkId: string,
  outboundTag: string,
): string {
  // WHY a JSON tuple and not a delimiter: tags are operator text and may
  // contain any character, so a delimiter could make two combinations collide.
  return JSON.stringify([inboundTag, linkId, outboundTag]);
}

/**
 * WHAT: resolve one link's readable name.
 *
 * WHY this order: an explicit per-combination name is the operator's most
 * specific instruction; the stored template is the fleet-wide default; the
 * built-in composition is the fallback when the template renders nothing for
 * this combination (a template that only names variants says nothing about a
 * default view); the tag pair is the last resort so a remark is never empty.
 */
export function resolveLinkName(input: {
  template: string;
  fields: TemplateFields;
  override?: string | null;
  inboundTag: string;
  outboundTag: string;
}): string {
  const override = input.override?.trim();
  if (override) {
    return override;
  }
  const rendered = renderTemplate(input.template, input.fields).trim();
  if (rendered) {
    return rendered;
  }
  // WHY the emptiness check before rendering the default line: a caller
  // without any fields would otherwise get a row of separators ("· →"). The
  // tag pair is the last resort that always says something.
  const named = ["node", "subject", "outbound"].some(
    (name) => String(input.fields[name] ?? "").trim() !== "",
  );
  const fallback = named
    ? renderTemplate(DEFAULT_LINK_NAME_TEMPLATE, input.fields).trim()
    : "";
  return fallback || `${input.inboundTag} → ${input.outboundTag}`;
}

/**
 * WHAT: return one local tag in display case, preserving known acronyms.
 *
 * WHY: live tags are the operator's machine names (`reality-tokyo01`); a
 * transport word reads as an acronym, an ordinary word gets sentence case.
 */
const ACRONYMS = new Set([
  "block",
  "grpc",
  "http",
  "httpupgrade",
  "in",
  "reality",
  "tls",
  "trojan",
  "vless",
  "vmess",
  "ws",
  "xhttp",
]);

function displayWord(word: string): string {
  if (!word) {
    return "";
  }
  const lowered = word.toLowerCase();
  if (ACRONYMS.has(lowered)) {
    return lowered.toUpperCase();
  }
  return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * WHAT: return a readable display name for one local tag.
 *
 * WHY separators are normalized: local tags use hyphens or underscores as
 * word separators. Display names use spaces, title casing, and uppercase
 * transport/security acronyms (`xhttp` becomes `XHTTP`, `niigata` becomes
 * `Niigata`). Non-strings have no display name rather than a guess.
 */
export function prettyTag(tag: unknown): string {
  if (typeof tag !== "string") {
    return "";
  }
  const words = tag
    .trim()
    .split(/[-_]+/)
    .filter((word) => word);
  return words.map(displayWord).join(" ");
}
