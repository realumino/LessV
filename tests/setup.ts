/**
 * Vitest setup file: create the production schema in the test D1 and seed
 * the one admin identity the suite authenticates with.
 *
 * WHY here and not in a test: every tier may read or write the database, so
 * the schema is a precondition for the whole run. Migrations are read by
 * the vitest config (`readD1Migrations`) and passed as the TEST_MIGRATIONS
 * binding; `applyD1Migrations` records what it applied, so this is
 * idempotent even though the setup file runs for every test file.
 *
 * WHY the admin row is seeded here: the middleware reads identities from
 * `admin_keys` only, and every admin test presents TEST_ADMIN_KEY. One
 * `INSERT OR IGNORE` gives them the row that value hashes to, without a
 * credential binding anywhere in the harness. `key_hash` is `UNIQUE`, so
 * repeated runs against a shared D1 are a no-op.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { TEST_ADMIN_KEY, testMigrations } from "./helpers";

await applyD1Migrations(env.DB, testMigrations());

/** WHAT: the storage form of a token — SHA-256 hex, as the plane stores it. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

await env.DB.prepare(
  "INSERT OR IGNORE INTO admin_keys (id, label, key_hash, created_at, disabled_at) VALUES ('t-admin', 'test harness', ?, 0, NULL)",
)
  .bind(await hashToken(TEST_ADMIN_KEY))
  .run();
