/**
 * WHAT: the deploy pipeline behind `npm run deploy`.
 *
 * WHY a script and not raw wrangler invocations: the steps have an order and
 * each can fail independently — building the SPA, applying remote D1
 * migrations, uploading the Worker, confirming the migration took, and
 * confirming the deployed plane answers. Skipping a step (or running them
 * out of order) produces a deploy that looks fine and is not; the script
 * makes the sequence the default and stops at the first failure.
 *
 * WHY migrations run BEFORE the Worker upload: an upload and a migration are
 * two operations with no transaction between them, so the deployed code and
 * the schema always disagree for some interval. Migrations first puts that
 * interval on "old code + new schema", which the running Worker survives —
 * it only reads whole rows and writes explicit columns. Worker-first would
 * put it on "new code + old schema", where the new code's writes fail on a
 * missing column. A failed migration therefore aborts the pipeline and the
 * previous Worker keeps serving.
 *
 * Usage:
 *   npm run deploy                        # full pipeline
 *   npm run deploy -- --dry-run           # build + wrangler dry-run, no cloud
 *   npm run deploy -- --secrets-file .env.production
 *   npm run deploy -- --config wrangler.vela.jsonc --secrets-file .env.vela
 *
 * WHY --config: one deployment per config file is the model, and a second
 * environment must go through this pipeline too — a bare `wrangler deploy
 * --config` would ship the stub assets the prebuild writes.
 *
 * WHY the final probe is `/sub/<random>` and not `/api/admin/*`: /sub/ is
 * public by contract, needs no credential, and still performs a D1 read, so
 * it proves routing AND database reachability. An admin path would need a
 * bearer key in this script, and behind Cloudflare Access it would not even
 * reach the Worker. A random token answers 200 with an empty body by
 * contract; anything else fails the pipeline.
 *
 * Secrets never pass through this script's memory beyond the file path;
 * wrangler reads the file itself.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDER_PATTERN = "cp.example.com";

const dryRun = process.argv.includes("--dry-run");
const secretsFlag = process.argv.indexOf("--secrets-file");
const secretsFile =
  secretsFlag >= 0 ? process.argv[secretsFlag + 1] ?? null : null;
const configFlag = process.argv.indexOf("--config");
const CONFIG = join(
  REPO_ROOT,
  configFlag >= 0 ? process.argv[configFlag + 1] ?? "" : "wrangler.jsonc",
);
const CONFIG_FLAG = ["--config", CONFIG];

/** WHAT: run one command, echoing it; stop the pipeline when it fails. */
function step(name, command, args, options = {}) {
  const started = Date.now();
  console.log(`\n==> ${name}: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: options.inherit ? "inherit" : "pipe",
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    if (!options.inherit) {
      console.error(result.stdout?.toString() ?? "");
      console.error(result.stderr?.toString() ?? "");
    }
    console.error(`FAILED after ${seconds}s`);
    process.exit(result.status ?? 1);
  }
  console.log(`done in ${seconds}s`);
  return result;
}

// --- 1. the operator config must exist and carry a real hostname ----------

if (!existsSync(CONFIG)) {
  console.error(
    `wrangler.jsonc is missing — copy the template first:\n` +
      "  cp wrangler.example.jsonc wrangler.jsonc\n" +
      "then edit the route pattern to your hostname.",
  );
  process.exit(1);
}
const config = readFileSync(CONFIG, "utf8");
const pattern = config.match(/"pattern"\s*:\s*"([^"]+)"/)?.[1];
const databaseName = config.match(/"database_name"\s*:\s*"([^"]+)"/)?.[1];
if (!pattern || pattern === PLACEHOLDER_PATTERN) {
  console.error(
    `${CONFIG} still has the placeholder route (${pattern ?? "none"}) — ` +
      "edit it to your hostname before deploying.",
  );
  process.exit(1);
}

if (secretsFile) {
  if (!existsSync(join(REPO_ROOT, secretsFile))) {
    console.error(`secrets file not found: ${secretsFile}`);
    process.exit(1);
  }
}

// --- 2. build the real SPA (the assets directory deploys with it) ---------

step("build SPA", "npm", ["--prefix", "frontend", "run", "build"]);

// --- 3. apply the remote D1 schema BEFORE the Worker upload ---------------

if (dryRun) {
  console.log("\n--dry-run: skipping migrations, deploy, and checks.");
} else {
  // WHY the database is created here and not left to `wrangler deploy`:
  // migrations now run before the upload (the safety property), but on the
  // FIRST deploy no database exists yet — the auto-provision used to happen
  // inside the upload step. Creating it when missing keeps both truths:
  // the schema lands before the Worker, and a fresh deployment needs no
  // manual `wrangler d1 create`. Idempotent: an existing database is left
  // alone and the apply below is a no-op.
  if (!databaseName) {
    console.error(
      `${CONFIG} declares no "database_name" — the pipeline cannot ensure\n` +
        "the database exists before migrating it.",
    );
    process.exit(1);
  }
  const info = spawnSync(
    "npx",
    ["wrangler", "d1", "info", databaseName, ...CONFIG_FLAG],
    { cwd: REPO_ROOT, stdio: "ignore", shell: process.platform === "win32" },
  );
  if (info.status !== 0) {
    step("create D1", "npx", [
      "wrangler",
      "d1",
      "create",
      databaseName,
      ...CONFIG_FLAG,
    ]);
  }

  step(
    "migrations",
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--remote", ...CONFIG_FLAG],
    { inherit: true },
  );

  // --- 4. deploy ----------------------------------------------------------

  const deployArgs = ["wrangler", "deploy", ...CONFIG_FLAG];
  if (secretsFile) {
    deployArgs.push("--secrets-file", secretsFile);
  }
  step("deploy", "npx", deployArgs, { inherit: true });

  // --- 5. the migration list must now be empty ----------------------------

  const pending = step(
    "migration check",
    "npx",
    ["wrangler", "d1", "migrations", "list", "DB", "--remote", ...CONFIG_FLAG],
  ).stdout?.toString() ?? "";
  // `list` exits 0 even with migrations left, so the output is read back:
  // pending migrations appear by name, and every migration file is .sql. A
  // deploy over a partially applied migration set would otherwise look green.
  const pendingFiles = pending
    .split("\n")
    .filter((line) => line.includes(".sql"));
  if (pendingFiles.length > 0) {
    console.error(
      `FAILED: ${pendingFiles.length} pending migration(s) remain:\n` +
        pendingFiles.join("\n"),
    );
    process.exit(1);
  }
}

// --- 6. confirm the deployed plane answers and can read D1 ----------------

if (dryRun) {
  process.exit(0);
}

const healthUrl = `https://${pattern}/api/health`;
const started = Date.now();
let healthStatus = 0;
try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(15000) });
  healthStatus = response.status;
} catch (error) {
  console.error(`health check could not connect: ${String(error)}`);
}
if (healthStatus !== 200) {
  console.error(
    `FAILED: ${healthUrl} answered ${healthStatus || "no response"}` +
      " — check the deployment in the Cloudflare dashboard.",
  );
  process.exit(1);
}
console.log(
  `health ok in ${((Date.now() - started) / 1000).toFixed(1)}s: ${healthUrl} -> 200`,
);

// A subscription token that does not exist: the plane answers 200 with an
// empty body (public path, no credential), and answering it at all required a
// D1 read — this is the end-to-end proof the deploy can reach its database.
const probeToken = Array.from(
  { length: 43 },
  () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-".charAt(
    Math.floor(Math.random() * 64),
  ),
).join("");
const probeUrl = `https://${pattern}/sub/${probeToken}`;
let probeStatus = 0;
let probeBody = "";
try {
  const response = await fetch(probeUrl, { signal: AbortSignal.timeout(15000) });
  probeStatus = response.status;
  probeBody = (await response.text()).slice(0, 200);
} catch (error) {
  console.error(`probe could not connect: ${String(error)}`);
}
if (probeStatus !== 200 || probeBody !== "") {
  console.error(
    `FAILED: ${probeUrl} answered ${probeStatus || "no response"}` +
      (probeBody ? ` with body ${JSON.stringify(probeBody)}` : " with a body") +
      " — expected 200 and an empty body.",
  );
  process.exit(1);
}
console.log(`probe ok: ${probeUrl} -> 200 (empty body; D1 reachable)`);
