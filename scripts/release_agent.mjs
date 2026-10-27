/**
 * WHAT: build the agent release tarball from the committed agent tree.
 *
 * WHY from HEAD and not the working tree: what ships must be what is
 * committed, so `git status --porcelain agent` must be empty first (the
 * tarball is also what gets sha256-checked on the VPS). Output:
 * dist/lessv-agent-<version>.tar.gz + .sha256, verified against the
 * required contents.
 *
 * Usage: npm run release:agent [-- --upload]
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(REPO_ROOT, "dist");
// Version truth lives in the agent package, not the root package.json —
// the root version follows the whole repo (still 0.1.0), while the agent
// bumps on its own schedule (0.2.0 in P1b). Shipping a tarball whose name
// disagrees with the runtime's __version__ breaks the acceptance checks
// that compare fleet agent_version against the release name.
const initPy = readFileSync(
  join(REPO_ROOT, "agent", "lessv_agent", "__init__.py"),
  "utf8",
);
const VERSION = initPy.match(/^__version__ = "([^"]+)"$/m)?.[1];
if (!VERSION) {
  console.error("cannot parse __version__ from agent/lessv_agent/__init__.py");
  process.exit(1);
}
const NAME = `lessv-agent-${VERSION}`;
const TARBALL = join(DIST, `${NAME}.tar.gz`);
const REQUIRED = [
  `${NAME}/install.sh`,
  `${NAME}/lessv_agent/__main__.py`,
  `${NAME}/lessv_agent/loop.py`,
  `${NAME}/lessv_agent/certs.py`,
  `${NAME}/systemd/lessv-agent.service`,
];
const FORBIDDEN = ["tests/", "__pycache__"];

/**
 * WHAT: with `--upload`, after the build and verification, push the
 * tarball and its sha256 sidecar to the plane's CERTS bucket.
 *
 * WHY wrangler and not the R2 binding: this runs on the operator's
 * machine, outside any Worker, so the authenticated CLI is the only way
 * up. Syntax verified against wrangler 4.152's `r2 object put --help`
 * (`objectPath` = `{bucket}/{key}`, `--remote` for the live bucket).
 */
const UPLOAD = process.argv.includes("--upload");
const BUCKET = "lessv-certs";

function r2Put(bucketAndKey, file, contentType, byteCount) {
  const result = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      bucketAndKey,
      `--file=${file}`,
      `--content-type=${contentType}`,
      "--remote",
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // npx resolves through the shell shim on Windows (no npx.exe);
      // every argument here is space-free, so the shell join is safe.
      shell: process.platform === "win32",
    },
  );
  if (result.status !== 0) {
    console.error(
      `wrangler r2 object put ${bucketAndKey} failed:\n${result.stdout.trim()}\n${result.stderr.trim()}`,
    );
    process.exit(1);
  }
  console.log(`uploaded ${bucketAndKey} (${byteCount} bytes, ${contentType})`);
}

/** WHAT: run a git command, dying with its stderr on failure. */
function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    process.exit(1);
  }
  return result.stdout;
}

const dirty = git(["status", "--porcelain", "agent"]).trim();
if (dirty) {
  console.error(
    "agent/ has uncommitted changes — commit first, then release:\n" + dirty,
  );
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// The agent subtree, unpacked under lessv-agent-<ver>/ so `tar -xzf
// --strip-components=1` lands install.sh and lessv_agent/ side by side.
git([
  "archive",
  "--format=tar.gz",
  `--prefix=${NAME}/`,
  "--output", TARBALL,
  "HEAD:agent",
  "--",
  "install.sh",
  "lessv_agent",
  "systemd",
]);

const bytes = readFileSync(TARBALL);
const sha = createHash("sha256").update(bytes).digest("hex");
writeFileSync(`${TARBALL}.sha256`, `${sha}  ${NAME}.tar.gz\n`);

// Verify the artifact before declaring victory. Relative path on
// purpose: GNU tar reads "C:/..." as host "C" (Cannot connect to C:).
const listing = spawnSync("tar", ["-tzf", `dist/${NAME}.tar.gz`], {
  encoding: "utf8",
  cwd: REPO_ROOT,
});
if (listing.status !== 0) {
  console.error(`tarball unreadable: ${listing.stderr}`);
  process.exit(1);
}
const entries = listing.stdout.trim().split("\n");
for (const required of REQUIRED) {
  if (!entries.includes(required)) {
    console.error(`tarball is missing ${required}`);
    process.exit(1);
  }
}
for (const forbidden of FORBIDDEN) {
  const leaked = entries.filter((entry) => entry.includes(forbidden));
  if (leaked.length > 0) {
    console.error(`tarball must not contain ${forbidden}: ${leaked[0]}`);
    process.exit(1);
  }
}

console.log(`dist/${NAME}.tar.gz (${bytes.length} bytes)`);
console.log(`sha256: ${sha}`);
console.log(`${entries.length} entries, contents verified`);

if (UPLOAD) {
  const shaLine = readFileSync(`${TARBALL}.sha256`);
  r2Put(
    `${BUCKET}/agent/${NAME}.tar.gz`,
    `dist/${NAME}.tar.gz`,
    "application/gzip",
    bytes.length,
  );
  r2Put(
    `${BUCKET}/agent/${NAME}.tar.gz.sha256`,
    `dist/${NAME}.tar.gz.sha256`,
    "text/plain",
    shaLine.length,
  );
}
