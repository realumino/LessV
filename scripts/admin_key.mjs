/**
 * WHAT: mint an admin key and store its hash in the plane's D1, from the
 * command line.
 *
 * WHY a script and not an API call: the first admin key must exist before
 * anyone can log in to the panel, and a lost panel (every key disabled,
 * ADMIN_KEY rotated away) needs a recovery path that does not depend on
 * the panel working. This is that path — the bootstrap and the recovery
 * action in one command. The `POST /api/admin/keys` endpoint does the same
 * thing through the panel once some key works.
 *
 * WHY the token is printed exactly once and never written to disk: the
 * plane stores only its SHA-256 hash; the temp SQL file carries the hash
 * and is deleted before this script exits.
 *
 * Usage:
 *   node scripts/admin_key.mjs create --label <name>            # remote D1
 *   node scripts/admin_key.mjs create --label <name> --local    # wrangler dev D1
 *   node scripts/admin_key.mjs create --label <name> --config <wrangler-file>
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--local") {
      args.local = true;
    } else if (arg === "--config") {
      args.config = argv[++i] ?? fail("--config needs a file path");
    } else if (arg.startsWith("--")) {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value`);
      args[arg.slice(2)] = value;
    } else {
      args._.push(arg);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args._[0] !== "create") {
  fail("usage: node scripts/admin_key.mjs create --label <name> [--local] [--config <file>]");
}
if (!args.label || typeof args.label !== "string") {
  fail("--label <name> is required (shown in the panel's key list)");
}

// --- mint: the same 32-byte base64url token the plane mints ---------------

const token = randomBytes(32).toString("base64url");
const keyHash = createHash("sha256").update(token).digest("hex");
const createdAt = Math.floor(Date.now() / 1000);

// --- store: one INSERT through wrangler, hash only, temp file deleted -----

// WHY the escape and not a parameter: `wrangler d1 execute --file` takes a
// SQL file, and the label is operator-supplied text. Only quotes are
// special in a single-quoted SQL string.
const sqlLabel = args.label.replaceAll("'", "''");
const sql =
  `INSERT INTO admin_keys (id, label, key_hash, created_at, disabled_at)\n` +
  `VALUES ('${randomUUID()}', '${sqlLabel}', '${keyHash}', ${createdAt}, NULL);\n`;
const tempFile = join(tmpdir(), `vela-admin-key-${randomBytes(6).toString("hex")}.sql`);
writeFileSync(tempFile, sql);
try {
  chmodSync(tempFile, 0o600);
} catch {
  /* Windows may ignore the mode; the file holds a hash, not the token */
}

const wranglerArgs = ["wrangler", "d1", "execute", "DB", "--file", tempFile];
if (args.local) {
  wranglerArgs.push("--local");
} else {
  wranglerArgs.push("--remote");
}
if (args.config) {
  if (!existsSync(args.config)) {
    rmSync(tempFile, { force: true });
    fail(`config file not found: ${args.config}`);
  }
  wranglerArgs.push("--config", args.config);
}

console.log("==> storing key hash:", wranglerArgs.join(" "));
const result = spawnSync("npx", wranglerArgs, {
  cwd: REPO_ROOT,
  stdio: "inherit",
  shell: process.platform === "win32",
});
rmSync(tempFile, { force: true });
if (result.status !== 0) {
  fail("wrangler d1 execute failed — the key was NOT stored");
}

// --- reveal: stdout only, after the hash is safely stored -----------------

console.log("");
console.log(`Admin key for "${args.label}" (shown once; the plane stores only its hash):`);
console.log("");
console.log(`  ${token}`);
console.log("");
console.log("Paste it at the panel's login (or send it as `Authorization: Bearer`).");
