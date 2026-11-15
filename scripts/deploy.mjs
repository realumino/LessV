/**
 * WHAT: the deploy pipeline behind `npm run deploy`.
 *
 * WHY a script and not raw wrangler invocations: the four steps have an
 * order and each can fail independently — building the SPA, uploading the
 * Worker, applying remote D1 migrations, and confirming the deployed
 * plane answers. Skipping a step (or running them out of order) produces a
 * deploy that looks fine and is not; the script makes the sequence the
 * default and stops at the first failure.
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

// --- 3. deploy ------------------------------------------------------------

const deployArgs = ["wrangler", "deploy", ...CONFIG_FLAG];
if (dryRun) {
  deployArgs.push("--dry-run");
} else if (secretsFile) {
  deployArgs.push("--secrets-file", secretsFile);
}
step("deploy", "npx", deployArgs, { inherit: true });

if (dryRun) {
  console.log("\n--dry-run: skipping migrations and health check.");
  process.exit(0);
}

// --- 4. apply the remote D1 schema ----------------------------------------

step(
  "migrations",
  "npx",
  ["wrangler", "d1", "migrations", "apply", "DB", "--remote", ...CONFIG_FLAG],
  { inherit: true },
);

// --- 5. confirm the deployed plane answers --------------------------------

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
