/**
 * WHAT: create and tear down a whole test plane — a Worker with its custom
 * domain, its D1, its workflow and its secrets — and hand the credentials to
 * the next step.
 *
 * WHY a script: a test plane is five artifacts with an order (deploy, apply
 * migrations, upload secrets, health), and the teardown must run in the
 * reverse order or the account fills with orphaned D1s and workflows that the
 * Worker's own delete never touched. Acceptance runs (scripts/accept.mjs) need
 * a plane; this is the plane half, and it owns nothing else.
 *
 * The same config that `npm run deploy -- --config <file>` consumes is the
 * input here, so a deployment and its test plane are described once. The
 * script generates the secrets file when asked to; an existing one is reused
 * so repeated runs on the same plane keep their credentials.
 *
 * Usage:
 *   node scripts/stage.mjs create --config wrangler.staging.jsonc \
 *     [--secrets-file .env.staging] [--generate-secrets] \
 *     [--dns-token-file <file>]
 *   node scripts/stage.mjs destroy --config wrangler.staging.jsonc
 *     [--secrets-file .env.staging]
 *
 * With --secrets-file the create run also mints the plane's first admin key
 * into `<secrets-file>.admin`: a fresh plane has no admin row, and with no env
 * fallback that plane accepts no key at all. --dns-token-file provisions the
 * other runtime credential the same way — the token is read from that file and
 * stored sealed and active, because an issuance with no active row fails.
 *
 * Exit codes: 0 success, 1 a step failed, 2 bad arguments.
 *
 * WHY top-level await: the health probe is the last create step, and the
 * package is ESM, so the script is a module and awaits directly.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDER_PATTERN = "cp.example.com";
const WORKFLOW_SUFFIX = "-cert-issuance";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function step(name, command, argv, options = {}) {
  const started = Date.now();
  console.log(`\n==> ${name}: ${command} ${argv.join(" ")}`);
  const result = spawnSync(command, argv, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    if (!options.inherit) {
      console.error(result.stdout ?? "");
      console.error(result.stderr ?? "");
    }
    fail(`FAILED after ${seconds}s`);
  }
  console.log(`done in ${seconds}s`);
  return result;
}

function npx(argv) {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

/** WHAT: parse `command --flag [value]`; values and flags are declared. */
function parseArgs(argv) {
  const valued = new Set(["config", "secrets-file", "dns-token-file"]);
  const flags = new Set(["generate-secrets"]);
  const values = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      values._.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (flags.has(name)) {
      values[name] = true;
      continue;
    }
    if (!valued.has(name)) fail(`unknown flag: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${arg}`);
    values[name] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const [command] = args._;
if (command !== "create" && command !== "destroy") {
  fail(
    "usage: scripts/stage.mjs create|destroy --config <file> [--secrets-file <file>] [--generate-secrets] [--dns-token-file <file>]",
  );
}

const configPath = args.config ?? "wrangler.staging.jsonc";
if (!existsSync(join(REPO_ROOT, configPath))) {
  fail(`${configPath} is missing — copy wrangler.example.jsonc and edit name, route, database_name and workflow name`);
}
const config = readFileSync(join(REPO_ROOT, configPath), "utf8");

/** WHAT: the values the config must already carry, read back for the report. */
function configField(key) {
  return config.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`))?.[1] ?? null;
}
const workerName = configField("name");
const pattern = config.match(/"pattern"\s*:\s*"([^"]+)"/)?.[1] ?? null;
const databaseName = configField("database_name");
const workflowName = configField("name");
if (!workerName || !pattern || pattern === PLACEHOLDER_PATTERN || !databaseName) {
  fail(
    `${configPath} still carries the template placeholders (name, route, database_name, workflow name) — edit them first`,
  );
}
const configFlag = ["--config", configPath];
const secretsFile = args["secrets-file"] ?? null;

/**
 * WHAT: derive the workflow's name from the config.
 *
 * WHY the fallback: the template names the workflow after the Worker, and a
 * config that forgot to rename it would leak the product's default name into
 * a test account.
 */
const workflow = config.match(/"name"\s*:\s*"([^"]+)"\s*,\s*"binding"\s*:\s*"ISSUANCE"/)?.[1] ?? `${workerName}${WORKFLOW_SUFFIX}`;

function readSecrets(path) {
  const map = {};
  for (const line of readFileSync(join(REPO_ROOT, path), "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) map[match[1]] = match[2].trim();
  }
  return map;
}

/**
 * WHAT: one admin API call on the freshly deployed plane.
 *
 * WHY the admin key is passed in: this is the only credential the plane
 * accepts, and it was minted a moment ago; nothing about the call is
 * privileged beyond that.
 */
async function api(adminKey, method, path, body) {
  const response = await fetch(`https://${pattern}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  if (!response.ok) {
    fail(`${method} ${path} -> ${response.status}: ${text.slice(0, 300)}`);
  }
  return text === "" ? null : JSON.parse(text);
}

/** WHAT: generate a secrets file with a fresh KEY_SECRET. */
function generateSecrets(path) {
  if (existsSync(join(REPO_ROOT, path))) {
    fail(`${path} already exists; pass a different path or delete it first`);
  }
  const configSecrets = config.match(/"required"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
  const required = [...configSecrets.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
  if (required.length === 0) {
    fail("the config declares no secrets.required list; cannot generate one");
  }
  // WHAT: the one value this script may mint, and why nothing else is here.
  // WHY only KEY_SECRET: it is the plane's own sealing key, disposable with
  // the plane. An admin key is a D1 row and the DNS token is issued by
  // Cloudflare and stored sealed — neither is deploy-time state, so inventing
  // either here would be a lie. A config that requires something else fails
  // loudly instead of being half-filled.
  // WHY KEY_SECRET is padded base64, not base64url: the seal/unseal path
  // decodes it with atob, which accepts only the standard alphabet; a '-'
  // or '_' in a base64url value is a decode failure at the first render.
  const lines = [];
  for (const name of required) {
    if (name === "KEY_SECRET") {
      lines.push(`KEY_SECRET=${randomBytes(32).toString("base64")}`);
      continue;
    }
    fail(`cannot generate ${name}; put it into ${path} by hand and rerun without --generate-secrets`);
  }
  writeFileSync(join(REPO_ROOT, path), `${lines.join("\n")}\n`, "utf8");
  console.log(`generated ${path}`);
}

if (command === "create") {
  if (secretsFile === null && args["generate-secrets"]) {
    fail("--generate-secrets needs --secrets-file to name the file to write");
  }
  if (secretsFile && args["generate-secrets"]) {
    generateSecrets(secretsFile);
  }
  const secrets = secretsFile ? readSecrets(secretsFile) : null;
  if (secrets !== null) {
    const configSecrets = config.match(/"required"\s*:\s*\[([^\]]*)\]/)?.[1] ?? "";
    const required = [...configSecrets.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1]);
    const missing = required.filter((name) => !secrets[name]);
    if (missing.length > 0) {
      fail(`${secretsFile} is missing ${missing.join(", ")}`);
    }
  }
  const secretsArg = secretsFile ? ["--secrets-file", secretsFile] : [];

  // 1. Deploy through the pipeline: it builds the real SPA and applies the
  //    remote migrations; a bare `wrangler deploy` would ship stub assets.
  step("deploy", "npm", ["run", "deploy", "--", "--config", configPath, ...secretsArg], {
    inherit: true,
  });

  // 2. The first deploy needs the secrets to exist before the Worker starts;
  //    later ones are no-ops but keep the file authoritative.
  if (secretsFile) {
    step(
      "secrets",
      npx(),
      [
        "wrangler",
        "secret",
        "bulk",
        secretsFile,
        ...configFlag,
      ],
    );
  }

  // 2b. The identity the release requires: panel keys are D1 rows now, so a
  //     freshly created plane has none and cannot open its own panel. Minting
  //     here is what makes this command produce a usable plane; an existing
  //     file is reused so a repeated run keeps its key instead of piling up
  //     rows.
  const adminKeyFile = secretsFile ? `${secretsFile}.admin` : null;
  if (adminKeyFile !== null) {
    if (existsSync(join(REPO_ROOT, adminKeyFile))) {
      console.log(`\nadmin key: reusing ${adminKeyFile}`);
    } else {
      step(
        "admin key",
        "node",
        [
          "scripts/admin_key.mjs",
          "create",
          "--label",
          "staging",
          "--config",
          configPath,
          "--out",
          adminKeyFile,
        ],
        { inherit: true },
      );
      console.log(`admin key: written to ${adminKeyFile} (mode 0600, ADMIN_KEY=<token>)`);
    }
  }

  // 3. The pipeline probed /api/health already; repeat it here because the
  //    secret upload above restarted the Worker.
  const health = await fetch(`https://${pattern}/api/health`, { signal: AbortSignal.timeout(20000) });
  if (health.status !== 200) {
    fail(`https://${pattern}/api/health answered ${health.status}`);
  }
  console.log(`\nhealth ok: https://${pattern}/api/health -> 200`);

  // 4. The DNS credential this release requires: without one active sealed
  //    row the plane fails every issuance with the named sentence.
  const dnsTokenFile = args["dns-token-file"] ?? null;
  if (dnsTokenFile !== null) {
    if (adminKeyFile === null) {
      fail("--dns-token-file needs --secrets-file (the admin key is minted into <secrets-file>.admin)");
    }
    const source = readSecrets(dnsTokenFile);
    const dnsToken = source.CLOUDFLARE_DNS ?? source.CF_DNS_API_TOKEN;
    if (!dnsToken) {
      fail(`${dnsTokenFile} has no CLOUDFLARE_DNS= or CF_DNS_API_TOKEN= line`);
    }
    const adminKey = readSecrets(adminKeyFile).ADMIN_KEY;
    if (!adminKey) {
      fail(`${adminKeyFile} has no ADMIN_KEY= line`);
    }
    const saved = await api(adminKey, "POST", "/api/admin/dns-credentials", {
      label: "staging",
      token: dnsToken,
    });
    await api(adminKey, "POST", `/api/admin/dns-credentials/${saved.id}/activate`);
    console.log(`DNS credential: active (id ${saved.id}), ${saved.zones} zone(s) visible to the token`);
  } else {
    console.log('DNS credential: none — issuance on this plane fails with "no DNS credential configured"');
    console.log("  add one in the panel, or rerun create with --dns-token-file <file>");
  }

  console.log(`plane ready: ${workerName} at https://${pattern} (D1 ${databaseName}, workflow ${workflow})`);
  if (secretsFile) {
    console.log(`credentials: ${secretsFile} (deploy secrets), ${adminKeyFile} (panel admin key)`);
  } else {
    console.log("admin key: none minted — run scripts/admin_key.mjs create before using this plane");
  }
}

if (command === "destroy") {
  // 1. The workflow's records outlive its Worker, so it goes by name first.
  step(
    "workflow",
    npx(),
    ["wrangler", "workflows", "delete", workflow, ...configFlag],
    { inherit: true },
  );

  // 2. The Worker delete also removes its custom-domain record.
  step("worker", npx(), ["wrangler", "delete", ...configFlag], { inherit: true });

  // 3. The database is the only artifact `wrangler delete` never touches.
  step("database", npx(), ["wrangler", "d1", "delete", databaseName, ...configFlag], {
    inherit: true,
  });

  if (secretsFile) {
    console.log(`note: ${secretsFile} was not deleted — its values are only disposable once the database above is gone`);
  }
  console.log(`\nplane ${workerName} destroyed (workflow, worker, D1 ${databaseName})`);
}
