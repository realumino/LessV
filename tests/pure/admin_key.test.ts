/**
 * Admin key minting and identity rules, without any environment.
 *
 * WHY a pure tier for a database service: the mint act is the security
 * boundary — one draw of entropy, one hash, one insert — and every promise
 * it makes (token format shared with node tokens, hash-at-rest, plaintext
 * returned once and never again, hash never projected) is checkable
 * against a recording stub of the two D1 calls the service makes.
 */

import { describe, expect, it } from "vitest";

import * as db from "../../src/db";
import {
  createAdminKey,
  disableAdminKey,
  listKeys,
  verifyAdminKey,
} from "../../src/services/admin_key_service";
import { tokenHash } from "../../src/services/node_token_service";

/** WHAT: the stored row the stub's SELECT answers with. */
function storedRow(overrides: Partial<db.AdminKeyRow> = {}): db.AdminKeyRow {
  return {
    id: "k1",
    label: "operator",
    key_hash: "a".repeat(64),
    created_at: 1700,
    disabled_at: null,
    ...overrides,
  };
}

/**
 * WHAT: a D1 stub that records writes and answers reads from memory.
 *
 * WHY the WHERE clauses are honored: verifyAdminKey's contract is "the row
 * that carries the presented token's hash" — a stub that returned every
 * row for any lookup would test nothing. The service issues exactly three
 * statement shapes, so matching on the column in the SQL is enough.
 */
function fakeConn(rows: db.AdminKeyRow[]) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const conn = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          const select = (column: "key_hash" | "id") =>
            rows.filter((row) => row[column] === values[0]);
          return {
            run: async () => {
              writes.push({ sql, values });
              return { success: true };
            },
            all: async () => ({
              results: sql.includes("key_hash = ?")
                ? select("key_hash")
                : sql.includes("WHERE id = ?")
                  ? select("id")
                  : rows,
            }),
          };
        },
      };
    },
  };
  return { conn, writes } as unknown as {
    conn: D1Database;
    writes: Array<{ sql: string; values: unknown[] }>;
  };
}

describe("createAdminKey", () => {
  it("mints a node-token-shaped key and stores only its hash", async () => {
    const { conn, writes } = fakeConn([]);
    const created = await createAdminKey(conn, "operator", 1700);

    expect(created.label).toBe("operator");
    expect(created.created_at).toBe(1700);
    // Same token shape the node tokens use: 32 bytes, base64url, no padding.
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The INSERT carries the hash of the very token that was returned, and
    // never the token itself.
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toEqual([
      created.id,
      "operator",
      await tokenHash(created.token),
      1700,
    ]);
    expect(JSON.stringify(writes)).not.toContain(created.token);
  });

  it("mints distinct tokens for two calls", async () => {
    const { conn } = fakeConn([]);
    const first = await createAdminKey(conn, "one", 1700);
    const second = await createAdminKey(conn, "two", 1701);
    expect(first.token).not.toBe(second.token);
    expect(first.id).not.toBe(second.id);
  });
});

describe("listKeys", () => {
  it("projects identity without the hash or the token", async () => {
    const { conn } = fakeConn([storedRow()]);
    const rows = await listKeys(conn);
    expect(rows).toEqual([
      { id: "k1", label: "operator", created_at: 1700, disabled_at: null },
    ]);
    expect(JSON.stringify(rows)).not.toContain("key_hash");
  });

  it("projects a disabled row with its revocation stamp", async () => {
    const { conn } = fakeConn([storedRow({ disabled_at: 1800 })]);
    const rows = await listKeys(conn);
    expect(rows[0]!.disabled_at).toBe(1800);
  });
});

describe("verifyAdminKey", () => {
  it("accepts the row that carries the presented token's hash", async () => {
    const token = "t".repeat(43);
    const { conn } = fakeConn([
      storedRow({ key_hash: await tokenHash(token) }),
    ]);
    expect(await verifyAdminKey(conn, token)).toBe(true);
  });

  it("refuses a disabled key like an unknown one", async () => {
    // WHY identical: a caller that could distinguish "disabled" from
    // "unknown" would learn which of its guesses used to be real.
    const token = "t".repeat(43);
    const { conn } = fakeConn([
      storedRow({ key_hash: await tokenHash(token), disabled_at: 1800 }),
    ]);
    expect(await verifyAdminKey(conn, token)).toBe(false);
  });

  it("refuses a token whose hash is not stored", async () => {
    const { conn } = fakeConn([storedRow()]);
    expect(await verifyAdminKey(conn, "n".repeat(43))).toBe(false);
  });
});

describe("disableAdminKey", () => {
  it("stamps disabled_at on an existing key", async () => {
    const { conn, writes } = fakeConn([storedRow()]);
    expect(await disableAdminKey(conn, "k1", 1800)).toBe(true);
    expect(writes[0]!.values).toEqual([1800, "k1"]);
  });

  it("answers false for an id that does not exist", async () => {
    const { conn, writes } = fakeConn([]);
    expect(await disableAdminKey(conn, "ghost", 1800)).toBe(false);
    expect(writes).toHaveLength(0);
  });
});
