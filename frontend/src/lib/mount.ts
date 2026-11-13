/**
 * The admin mount predicate and the title it carries.
 *
 * WHY this is a module and not an inline check: two documents can boot the
 * app (the built shell at /admin/ and the fallback document, which serves
 * /admin deep links) and one test file pins the rule; a single predicate
 * keeps them from disagreeing.
 */

/** WHAT: the document title the panel carries, only inside its mount. */
export const ADMIN_TITLE = "LessV admin";

/**
 * WHAT: return true only for a URL inside the admin mount.
 *
 * WHY the exact "/admin" form: the asset router redirects it to "/admin/",
 * but a trailing-slash-insensitive check would also accept "/adminx", which
 * is a different site section and must stay inert.
 */
export function isAdminMount(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname === "/admin/" ||
    pathname.startsWith("/admin/")
  );
}
