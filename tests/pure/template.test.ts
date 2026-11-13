/**
 * The `{field}` template engine.
 *
 * WHY these cases matter: the same engine renders link remarks (URI
 * fragments) and subscription titles (HTTP headers). Escapes, unknown fields,
 * and control characters are the parts that would otherwise leak braces or
 * break a header, so they are pinned here rather than through the API.
 */

import { describe, expect, it } from "vitest";

import {
  renderTemplate,
  templateFields,
  validateTemplate,
} from "../../src/core/template";

const FIELDS = { node: "Tokyo 01", link: "", count: 3, missing: null };
const ALLOWED = ["node", "link", "count", "outbound"];

describe("renderTemplate", () => {
  it("substitutes fields and leaves the rest alone", () => {
    expect(renderTemplate("{node} → {outbound}", { ...FIELDS, outbound: "Japan" })).toBe(
      "Tokyo 01 → Japan",
    );
  });

  it("renders numbers and empty values", () => {
    expect(renderTemplate("{count} links, {link} view", FIELDS)).toBe("3 links,  view");
    expect(renderTemplate("{missing}", FIELDS)).toBe("");
  });

  it("keeps literal braces via the double-brace escape", () => {
    expect(renderTemplate("{{{node}}}", FIELDS)).toBe("{Tokyo 01}");
    expect(renderTemplate("a }} b", FIELDS)).toBe("a } b");
  });

  it("leaves a malformed placeholder literal instead of throwing", () => {
    expect(renderTemplate("{Node}", FIELDS)).toBe("{Node}");
    expect(renderTemplate("{unterminated", FIELDS)).toBe("{unterminated");
    expect(renderTemplate("{a b}", FIELDS)).toBe("{a b}");
    expect(renderTemplate("plain", FIELDS)).toBe("plain");
  });

  it("handles non-ASCII text", () => {
    expect(renderTemplate("{node} · 东京", FIELDS)).toBe("Tokyo 01 · 东京");
  });
});

describe("templateFields", () => {
  it("lists valid placeholders once each, in order", () => {
    expect(templateFields("{node} {outbound} {node}")).toEqual([
      "node",
      "outbound",
      "node",
    ]);
  });

  it("ignores escapes and invalid names", () => {
    expect(templateFields("{{{node}}} {Node} {a b}")).toEqual(["node"]);
    expect(templateFields("x {{node}} y")).toEqual([]);
  });
});

describe("validateTemplate", () => {
  it("accepts known fields and escapes", () => {
    expect(validateTemplate("{node} · {link} → {outbound}", ALLOWED)).toEqual([]);
    expect(validateTemplate("{{literal}}", ALLOWED)).toEqual([]);
    expect(validateTemplate("", ALLOWED)).toEqual([]);
  });

  it("reports unknown fields once, naming the allowed set", () => {
    const errors = validateTemplate("{node} {subject} {subject}", ALLOWED);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/unknown field \{subject\}/);
    expect(errors[0]).toMatch(/\{node\}, \{link\}, \{count\}, \{outbound\}/);
  });

  it("reports invalid and unterminated placeholders", () => {
    expect(validateTemplate("{Node}", ALLOWED)[0]).toMatch(/invalid placeholder 'Node'/);
    expect(validateTemplate("a {node", ALLOWED)[0]).toMatch(/unterminated/);
    expect(validateTemplate("{}", ALLOWED)[0]).toMatch(/invalid placeholder ''/);
  });

  it("rejects control characters and over-long templates", () => {
    expect(validateTemplate("a\nb", ALLOWED)[0]).toMatch(/control characters/);
    expect(validateTemplate("x".repeat(201), ALLOWED)[0]).toMatch(/at most 200/);
  });
});
