/**
 * The plane's naming settings: one stored row, code defaults for a fresh one.
 *
 * WHY the defaults live in code and not in the migration: the template that
 * the renderer uses and the template the admin sees must be the same string,
 * so the default is a constant (`DEFAULT_LINK_NAME_TEMPLATE`) and a missing
 * row means "use it". A seeded row could only drift from the code.
 *
 * WHY validation is a separate function: services stay HTTP-free, and both
 * the admin route and the unit tier call the same rules.
 */

import { validateTemplate } from "../core/template";
import * as db from "../db";
import { DEFAULT_LINK_NAME_TEMPLATE, LINK_NAME_FIELDS } from "./labels";

/** WHAT: the naming knobs the plane reads on every link render. */
export type PlaneSettings = {
  link_name_template: string;
  subscription_title_template: string;
};

/**
 * WHAT: every field a subscription-title template may reference.
 *
 * WHY only these two: the title is resolved after the entitlement check, so
 * `{status}` is always `active`, and the link count / expiry were left out on
 * purpose — a title identifies the profile, it is not a status page.
 */
export const SUBSCRIPTION_TITLE_FIELDS = ["username", "status"] as const;

/** WHAT: what a plane with no stored settings uses. */
export const DEFAULT_PLANE_SETTINGS: PlaneSettings = {
  link_name_template: DEFAULT_LINK_NAME_TEMPLATE,
  subscription_title_template: "",
};

/** WHAT: Unix seconds from the plane's clock (the time authority). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** WHAT: return the semantic errors of a partial settings update. */
export function validateSettings(patch: {
  link_name_template?: string | null;
  subscription_title_template?: string | null;
}): string[] {
  const errors: string[] = [];
  if (patch.link_name_template !== undefined && patch.link_name_template !== null) {
    const template = patch.link_name_template.trim();
    if (!template) {
      errors.push("link_name_template must not be empty");
    }
    errors.push(...validateTemplate(template, LINK_NAME_FIELDS));
  }
  if (
    patch.subscription_title_template !== undefined &&
    patch.subscription_title_template !== null
  ) {
    // WHY empty is allowed: an empty title is the "send no header" state,
    // which is what a plane that never used the knob must look like.
    errors.push(
      ...validateTemplate(
        patch.subscription_title_template.trim(),
        SUBSCRIPTION_TITLE_FIELDS,
      ),
    );
  }
  return errors;
}

/** WHAT: read the stored settings, falling back to the code defaults. */
export async function loadPlaneSettings(conn: D1Database): Promise<PlaneSettings> {
  const row = await db.getPlaneSettings(conn);
  if (row === null) {
    return { ...DEFAULT_PLANE_SETTINGS };
  }
  return {
    link_name_template: row.link_name_template,
    subscription_title_template: row.subscription_title_template,
  };
}

/**
 * WHAT: merge one validated patch into the stored settings and return them.
 *
 * WHY the merge happens here: the admin form may post one knob, and a write
 * must never blank the others just because the caller did not mention them.
 */
export async function savePlaneSettings(
  conn: D1Database,
  patch: {
    link_name_template?: string | null;
    subscription_title_template?: string | null;
  },
): Promise<PlaneSettings> {
  const current = await loadPlaneSettings(conn);
  const next: PlaneSettings = { ...current };
  if (patch.link_name_template !== undefined && patch.link_name_template !== null) {
    next.link_name_template = patch.link_name_template.trim();
  }
  if (
    patch.subscription_title_template !== undefined &&
    patch.subscription_title_template !== null
  ) {
    next.subscription_title_template = patch.subscription_title_template.trim();
  }
  await db.savePlaneSettings(conn, {
    link_name_template: next.link_name_template,
    subscription_title_template: next.subscription_title_template,
    updated_at: nowSeconds(),
  });
  return next;
}
