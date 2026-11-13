/**
 * Readable labels used by generated links.
 *
 * Ported from tests/pure/test_labels.py with its assertions intact, extended
 * to the template that now names links: machine names stay qualified while
 * admins and end users see stable display text.
 */

import { describe, expect, it } from "vitest";

import { renderTemplate } from "../../src/core/template";
import {
  DEFAULT_LINK_NAME_TEMPLATE,
  linkNameFields,
  linkNameFieldsFromLabels,
  linkNameKey,
  prettyTag,
  resolveLinkName,
} from "../../src/services/labels";

describe("prettyTag", () => {
  it("prettifies common tags without storing display names", () => {
    expect(prettyTag("reality")).toBe("REALITY");
    expect(prettyTag("xhttp")).toBe("XHTTP");
    expect(prettyTag("niigata")).toBe("Niigata");
    expect(prettyTag("reality_in")).toBe("REALITY IN");
  });

  it("has no display name for invalid input", () => {
    expect(prettyTag(null)).toBe("");
    expect(prettyTag("")).toBe("");
  });
});

/** WHAT: the field map of one invented combination. */
function fieldsOf(link: { id: string; label: string } | null) {
  return linkNameFields({
    node: { id: "tokyo01", label: "Tokyo 01" },
    inbound: { tag: "reality-tokyo01", label: "REALITY", protocol: "vless" },
    link,
    outbound: { tag: "tokyo01-niigata", label: "Niigata" },
  });
}

describe("linkNameFields", () => {
  it("renders the default template as the archived node · subject → exit line", () => {
    expect(
      renderTemplate(DEFAULT_LINK_NAME_TEMPLATE, fieldsOf(null)),
    ).toBe("Tokyo 01 · REALITY → Niigata");
  });

  it("makes the variant label the subject when the view has one", () => {
    const fields = fieldsOf({ id: "cdn", label: "CDN" });
    expect(renderTemplate(DEFAULT_LINK_NAME_TEMPLATE, fields)).toBe(
      "Tokyo 01 · CDN → Niigata",
    );
    expect(fields["link"]).toBe("CDN");
    expect(fields["subject"]).toBe("CDN");
  });

  it("leaves the variant fields empty for the default view", () => {
    const fields = fieldsOf(null);
    expect(fields["link"]).toBe("");
    expect(fields["link_id"]).toBe("");
    expect(fields["subject"]).toBe("REALITY");
  });

  it("carries the technical fields a template may use", () => {
    const fields = fieldsOf(null);
    expect(fields["node_id"]).toBe("tokyo01");
    expect(fields["inbound_tag"]).toBe("reality-tokyo01");
    expect(fields["outbound_tag"]).toBe("tokyo01-niigata");
    expect(fields["protocol"]).toBe("vless");
  });
});

describe("linkNameFieldsFromLabels", () => {
  it("builds the same default line from tags and labels alone", () => {
    const fields = linkNameFieldsFromLabels("Tokyo 01", "REALITY_IN", "JAPAN", {
      REALITY_IN: "REALITY",
      JAPAN: "Japan",
    });
    expect(renderTemplate(DEFAULT_LINK_NAME_TEMPLATE, fields)).toBe(
      "Tokyo 01 · REALITY → Japan",
    );
  });

  it("falls back to the tag when a label is missing", () => {
    const fields = linkNameFieldsFromLabels("Node", "IN", "OUT", {});
    expect(renderTemplate(DEFAULT_LINK_NAME_TEMPLATE, fields)).toBe(
      "Node · IN → OUT",
    );
  });
});

describe("resolveLinkName", () => {
  const base = {
    template: DEFAULT_LINK_NAME_TEMPLATE,
    fields: fieldsOf(null),
    inboundTag: "reality",
    outboundTag: "japan",
  };

  it("takes an explicit combination name verbatim", () => {
    expect(resolveLinkName({ ...base, override: "🇯🇵 Tokyo" })).toBe("🇯🇵 Tokyo");
  });

  it("renders the stored template", () => {
    expect(
      resolveLinkName({ ...base, template: "{outbound} ← {node}" }),
    ).toBe("Niigata ← Tokyo 01");
  });

  it("falls back to the default template when the stored one renders empty", () => {
    // `{link}` is empty for a default view: the operator's format says
    // nothing about this combination, so the built-in line must take over
    // instead of emitting an empty remark.
    expect(resolveLinkName({ ...base, template: "{link}" })).toBe(
      "Tokyo 01 · REALITY → Niigata",
    );
  });

  it("falls back to the tag pair when no field says anything", () => {
    expect(
      resolveLinkName({
        ...base,
        template: "{link}",
        fields: {},
      }),
    ).toBe("reality → japan");
  });

  it("ignores a whitespace-only override", () => {
    expect(resolveLinkName({ ...base, override: "   " })).toBe(
      "Tokyo 01 · REALITY → Niigata",
    );
  });
});

describe("linkNameKey", () => {
  it("separates the inbound, the view, and the exit unambiguously", () => {
    expect(linkNameKey("reality", "cdn", "japan")).toBe(
      JSON.stringify(["reality", "cdn", "japan"]),
    );
    // Two inbounds' default views share the empty link id; the inbound
    // tag is what keeps their names apart.
    expect(linkNameKey("xhttp", "", "japan")).not.toBe(
      linkNameKey("reality", "", "japan"),
    );
    // Operator tags may contain separators; the key must still differ.
    const separator = String.fromCharCode(0);
    expect(linkNameKey("a", `b${separator}c`, "d")).not.toBe(
      linkNameKey(`a${separator}b`, "c", "d"),
    );
  });
});
