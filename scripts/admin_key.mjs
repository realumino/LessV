/**
 * WHAT: mint an admin key and store its hash in the plane's D1, from the
 * command line.
 *
 * WHY a script and not an API call: the first admin key must exist before
 * anyone can log in to the panel, and a plane with no rows (or with every
 * key disabled) accepts nothing at all. This is the bootstrap and the
 * recovery path in one command — it depends on wrangler access, not on the
 * panel working. The `POST /api/admin/keys` endpoint does the same thing
 * through the panel once some key works, and that is the normal path.
 *
 * WHY the token is shown exactly once: the plane stores only its SHA-256
 * hash, so there is no second chance to read it. By default it goes to
 * stdout; `--out <file>` writes `ADMIN_KEY=<token>` with mode 0600 and
 * prints only the path, so a script can consume it without the token
 * landing in a log. The temp SQL file carries the hash and is deleted
 * before this script exits.
 *
 * Usage:
 *   node scripts/admin_key.mjs create --label <name>            # remote D1
 *   node scripts/admin_key.mjs create --label <name> --local    # wrangler dev D1
 *   node scripts/admin_key.mjs create --label <name> --local --persist-to <dir>
 *   node scripts/admin_key.mjs create --label <name> --config <wrangler-file>
 *   node scripts/admin_key.mjs create --label <name> --out <file>  # path, not token
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, dirname, resolve } from "node:path";
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
  fail("usage: node scripts/admin_key.mjs create --label <name> [--local [--persist-to <dir>]] [--config <file>] [--out <file>]");
}
if (!args.label || typeof args.label !== "string") {
  fail("--label <name> is required (shown in the panel's key list)");
}
if (args["persist-to"] && !args.local) {
  fail("--persist-to only applies with --local (a remote D1 has no local state)");
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
  // WHY the passthrough: a Worker started with `--persist-to <dir>` keeps its
  // D1 there, so the row has to be inserted there too or the panel stays shut.
  if (args["persist-to"]) {
    wranglerArgs.push("--persist-to", args["persist-to"]);
  }
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

// --- reveal: stdout, or a mode-0600 file, after the hash is stored --------

if (args.out) {
  // WHY the path and not the token: a script consuming this cannot leak what
  // it never read from a log, and the file is readable only by its owner.
  const target = resolve(args.out);
  writeFileSync(target, `ADMIN_KEY=${token}\n`, { mode: 0o600 });
  try {
    chmodSync(target, 0o600);
  } catch {
    /* Windows may ignore the mode; the file holds a live token */
  }
  console.log("");
  console.log(`Admin key for "${args.label}" written to ${target} (mode 0600) as ADMIN_KEY=<token>.`);
  console.log("The token was not printed; read it from the file.");
  process.exit(0);
}

console.log("");
console.log(`Admin key for "${args.label}" (shown once; the plane stores only its hash):`);
console.log("");
console.log(`  ${token}`);
console.log("");
console.log("Paste it at the panel's login (or send it as `Authorization: Bearer`).");
