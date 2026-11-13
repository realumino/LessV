/**
 * The `{field}` template used by generated link names and subscription titles.
 *
 * WHY one tiny grammar and not a templating library: both surfaces are one
 * short line of display text, the fields are a closed set the service layer
 * supplies, and a full engine would add a dependency for string substitution.
 *
 * WHY unknown fields are rejected at save time (see `validateTemplate`) and
 * silently emptied at render time: the admin should learn about a typo before
 * it reaches a client, while a template that predates a field removal must
 * still render instead of leaking braces into a label.
 */

/** WHAT: the values one template may reference. */
export type TemplateFields = Record<string, string | number | null | undefined>;

/** WHAT: a placeholder name; anything else stays literal text. */
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/** WHAT: the longest template the plane stores. */
const MAX_TEMPLATE_LENGTH = 200;

/** WHAT: characters a template may never contain (they reach headers/URIs). */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * WHAT: render a template, substituting `{field}` and unescaping `{{`/`}}`.
 *
 * WHY lenient about malformed input: `validateTemplate` is the gate for
 * stored templates; this function must never throw on data that is already
 * stored, so an unmatched `{` stays literal and a missing field renders
 * empty.
 */
export function renderTemplate(template: string, fields: TemplateFields): string {
  let output = "";
  for (let index = 0; index < template.length; index += 1) {
    const character = template[index]!;
    if (character === "{") {
      if (template[index + 1] === "{") {
        output += "{";
        index += 1;
        continue;
      }
      const end = template.indexOf("}", index + 1);
      if (end < 0) {
        output += template.slice(index);
        break;
      }
      const name = template.slice(index + 1, end);
      if (FIELD_NAME.test(name)) {
        const value = fields[name];
        output += value === undefined || value === null ? "" : String(value);
        index = end;
        continue;
      }
      output += "{";
      continue;
    }
    if (character === "}" && template[index + 1] === "}") {
      output += "}";
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

/**
 * WHAT: return the valid placeholder names a template references, in order.
 *
 * WHY this and not a regex match: `{{` must not be read as a placeholder, and
 * an invalid name inside braces is not a field.
 */
export function templateFields(template: string): string[] {
  const names: string[] = [];
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "{") {
      if (template[index] === "}" && template[index + 1] === "}") {
        index += 1;
      }
      continue;
    }
    if (template[index + 1] === "{") {
      index += 1;
      continue;
    }
    const end = template.indexOf("}", index + 1);
    if (end < 0) {
      break;
    }
    const name = template.slice(index + 1, end);
    if (FIELD_NAME.test(name)) {
      names.push(name);
      index = end;
    }
  }
  return names;
}

/**
 * WHAT: return every problem with one template (empty list means valid).
 *
 * WHY the field list is a parameter: the two templates have different field
 * sets, and a link name may not reference a subscription field.
 */
export function validateTemplate(
  template: string,
  allowed: readonly string[],
): string[] {
  const errors: string[] = [];
  if (template.length > MAX_TEMPLATE_LENGTH) {
    errors.push(`template must be at most ${MAX_TEMPLATE_LENGTH} characters`);
  }
  if (CONTROL_CHARACTER.test(template)) {
    errors.push("template must not contain control characters");
  }
  const unknown = new Set<string>();
  for (let index = 0; index < template.length; index += 1) {
    if (template[index] !== "{") {
      if (template[index] === "}" && template[index + 1] === "}") {
        index += 1;
      }
      continue;
    }
    if (template[index + 1] === "{") {
      index += 1;
      continue;
    }
    const end = template.indexOf("}", index + 1);
    if (end < 0) {
      errors.push(`unterminated placeholder at position ${index + 1}`);
      break;
    }
    const name = template.slice(index + 1, end);
    if (!FIELD_NAME.test(name)) {
      errors.push(`invalid placeholder '${name}'`);
    } else if (!allowed.includes(name)) {
      unknown.add(name);
    }
    index = end;
  }
  if (unknown.size > 0) {
    const names = [...unknown].sort().map((name) => `{${name}}`).join(", ");
    errors.push(
      `unknown field${unknown.size === 1 ? "" : "s"} ${names}; ` +
        `allowed: ${allowed.map((name) => `{${name}}`).join(", ")}`,
    );
  }
  return errors;
}
