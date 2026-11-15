/**
 * WHAT: emit the SQL that moves certificate artifacts out of R2 and into D1.
 *
 * WHY: `certificate_artifacts` replaced the R2 bucket, and the `certificates`
 * table lost its `r2_prefix` column. A plain `d1 export --table certificates`
 * still names that column, so it cannot be imported into the new schema — this
 * tool reads the old rows and the old objects, and writes two things as SQL:
 * the `certificates` rows without the dropped column, and one
 * `certificate_artifacts` row per certificate.
 *
 * Read-only against the source: it lists and gets objects, and runs one
 * `SELECT` against the source database. It prints no PEM, no key material and
 * no fingerprints — only certificate ids and per-row progress.
 *
 * Usage:
 *   node scripts/migrate_cert_artifacts.mjs \
 *     --bucket <r2-bucket> --database <d1-name> --out <file.sql> [--remote]
 *
 * Then apply the emitted file to the destination database:
 *   npx wrangler d1 execute <new-d1> --remote --file <file.sql>
 *
 * Refuses to emit a row whose sealed leaf key is missing or is not `v1:`
 * prefixed (prints the certificate id and continues): such a row could never
 * serve a node, and its absence surfaces at the first render instead.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** WHAT: the artifacts the plane writes for one certificate, minus meta.json. */
const ARTIFACT_OBJECTS = ["cert.pem", "chain.pem", "fullchain.pem", "privkey.pem.enc"];

/** WHAT: the columns a `certificates` row still has after migration 0014. */
const CERTIFICATE_COLUMNS = [
  "id",
  "domain_id",
  "environment",
  "serial",
  "fingerprint_sha256",
  "sans_json",
  "not_before",
  "not_after",
  "profile",
  "issued_at",
  "is_current",
  "purged_at",
  "created_at",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** WHAT: read `--name value` pairs; the flag set is closed on purpose. */
function parseArgs(argv) {
  const values = { remote: false };
  const valued = new Set(["bucket", "database", "out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") {
      values.remote = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!valued.has(name)) fail(`unknown flag: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

/** WHAT: run one command from the repository root; return its stdout. */
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    const reason = (result.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${command} ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout ?? "";
}

function wrangler(args) {
  return run(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args]);
}

/** WHAT: quote one SQL value: NULL, an integer, or a single-quoted string. */
function sqlValue(value, column) {
  if (value === null || value === undefined) return "NULL";
  if (column === "is_current") {
    return value === true || value === 1 || value === "1" ? "1" : "0";
  }
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** WHAT: the old certificate rows, read-only, from the source database. */
function readCertificates(database, remote) {
  const args = ["d1", "execute", database, "--json", "--command", "SELECT * FROM certificates"];
  if (remote) args.push("--remote");
  const parsed = JSON.parse(wrangler(args));
  const rows = Array.isArray(parsed) ? parsed[0]?.results : undefined;
  if (!Array.isArray(rows)) {
    fail("could not read certificates: wrangler returned no result set");
  }
  return rows;
}

/** WHAT: download one R2 object to a temp file and return its text, or null. */
function readObject(bucket, prefix, name, scratch) {
  const target = join(scratch, name);
  try {
    wrangler(["r2", "object", "get", `${bucket}/${prefix}/${name}`, "--file", target]);
  } catch (error) {
    console.warn(`  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return readFileSync(target, "utf8");
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "usage: node scripts/migrate_cert_artifacts.mjs \\\n" +
      "  --bucket <r2-bucket> --database <d1-name> --out <file.sql> [--remote]",
  );
  process.exit(0);
}
for (const required of ["bucket", "database", "out"]) {
  if (args[required] === undefined) fail(`missing --${required}`);
}

const rows = readCertificates(args.database, args.remote);
console.log(`read ${rows.length} certificate row(s) from ${args.database}`);

const scratch = mkdtempSync(join(tmpdir(), "vela-artifacts-"));
const certificateStatements = [];
const artifactStatements = [];
const summary = [];
let refused = 0;

try {
  for (const row of rows) {
    const id = String(row.id ?? "");
    const prefix = typeof row.r2_prefix === "string" ? row.r2_prefix : "";
    if (id === "" || prefix === "") {
      console.warn(`skipping a row without an id or r2_prefix`);
      refused += 1;
      continue;
    }

    const found = {};
    for (const object of ARTIFACT_OBJECTS) {
      found[object] = readObject(args.bucket, prefix, object, scratch);
    }
    const sealedKey = found["privkey.pem.enc"];
    if (sealedKey === null || !sealedKey.startsWith("v1:")) {
      console.warn(
        `skipping ${id}: sealed private key is ${sealedKey === null ? "missing" : "not v1:-prefixed"}`,
      );
      refused += 1;
      continue;
    }

    const columns = CERTIFICATE_COLUMNS.join(", ");
    const values = CERTIFICATE_COLUMNS.map((column) => sqlValue(row[column], column)).join(", ");
    certificateStatements.push(
      `INSERT INTO certificates (${columns}) VALUES (${values});`,
    );

    const updatedAt = Math.floor(Date.now() / 1000);
    artifactStatements.push(
      "INSERT INTO certificate_artifacts " +
        "(certificate_id, private_key, cert_pem, chain_pem, fullchain_pem, updated_at) " +
        `VALUES (${sqlValue(id, "id")}, ${sqlValue(sealedKey, "private_key")}, ` +
        `${sqlValue(found["cert.pem"], "cert_pem")}, ${sqlValue(found["chain.pem"], "chain_pem")}, ` +
        `${sqlValue(found["fullchain.pem"], "fullchain_pem")}, ${updatedAt});`,
    );

    const present = ARTIFACT_OBJECTS.map((object) => `${object}=${found[object] === null ? "no" : "yes"}`);
    summary.push(
      `-- ${id}: ${present.join(" ")} private_key=${sealedKey.startsWith("v1:") ? "v1" : "plaintext"}`,
    );
    console.log(`read ${id}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const out = [
  "-- Certificate rows (without the dropped r2_prefix column) and their",
  "-- artifacts, emitted by scripts/migrate_cert_artifacts.mjs.",
  ...certificateStatements,
  "",
  ...artifactStatements,
  "",
  "-- summary",
  ...summary,
  "",
].join("\n");

writeFileSync(args.out, out, "utf8");
console.log(
  `wrote ${certificateStatements.length} certificate row(s), ` +
    `${artifactStatements.length} artifact row(s), ${refused} skipped to ${args.out}`,
);
