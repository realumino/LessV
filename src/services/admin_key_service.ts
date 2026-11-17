/**
 * Admin key minting, listing, and revocation.
 *
 * WHY this layer exists: an admin key is the same instrument as a node
 * token — 32 random bytes, shown once, stored as a SHA-256 hash, compared
 * constant-time — so the crypto rules are borrowed from
 * `node_token_service` instead of reimplemented. What is admin-specific is
 * the identity: a label an operator can read, an id the API can address,
 * and revocation that answers like an unknown key.
 *
 * WHY no SQL here: `db` owns statements; this layer owns the mint act and
 * what it returns exactly once.
 */

import * as db from "../db";
import { mintToken, tokenHash } from "./node_token_service";

/** WHAT: everything mint time gets to show, exactly once. */
export type CreatedAdminKey = {
  id: string;
  label: string;
  created_at: number;
  /** The plaintext token. Never stored; the caller may print or display it. */
  token: string;
};

/**
 * WHAT: mint one admin key under a label.
 *
 * WHY the id is a UUID and not derived from the label: labels are for
 * humans and may repeat or change shape; the id is what DELETE addresses.
 */
export async function createAdminKey(
  conn: D1Database,
  label: string,
  at: number,
): Promise<CreatedAdminKey> {
  const token = mintToken();
  const key = {
    id: crypto.randomUUID(),
    label,
    key_hash: await tokenHash(token),
    created_at: at,
  };
  await db.insertAdminKey(conn, key);
  return { id: key.id, label: key.label, created_at: key.created_at, token };
}

/**
 * WHAT: every stored key as the API returns it — never the hash.
 *
 * WHY the hash is dropped here and not in the router: no caller of this
 * service may ever see it, so the projection is the service's contract,
 * not a view-layer convention.
 */
export async function listKeys(
  conn: D1Database,
): Promise<
  Array<{ id: string; label: string; created_at: number; disabled_at: number | null }>
> {
  return (await db.listAdminKeys(conn)).map((row) => ({
    id: row.id,
    label: row.label,
    created_at: row.created_at,
    disabled_at: row.disabled_at,
  }));
}

/**
 * WHAT: revoke one key by stamping `disabled_at`.
 *
 * WHY the service reports whether the row existed: the router turns a
 * miss into a 404 — the id, not the key material, is what callers know.
 */
export async function disableAdminKey(
  conn: D1Database,
  id: string,
  at: number,
): Promise<boolean> {
  const existing = await db.getAdminKey(conn, id);
  if (existing === null) {
    return false;
  }
  await db.disableAdminKey(conn, id, at);
  return true;
}

/**
 * WHAT: verify a presented bearer token against the stored keys.
 *
 * WHY the disabled row is a refusal indistinguishable from no row: the
 * 401 body must not reveal that a key exists but was revoked — the same
 * sentence answers a wrong key, an unknown key, and a disabled one.
 */
export async function verifyAdminKey(
  conn: D1Database,
  presented: string,
): Promise<boolean> {
  const hash = await tokenHash(presented);
  const row = await db.getAdminKeyByHash(conn, hash);
  return row !== null && row.disabled_at === null;
}
