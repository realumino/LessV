/**
 * WHAT: provision the two P1a Linodes (server + client) and inventory them.
 *
 * WHY a script and not dashboard clicks: the whole point of P1a is a
 * reproducible fixture — two `g6-nanode-1` Debian 12 instances with the
 * P1a SSH key injected, polled to `running`, recorded in
 * ~/.lessv/acceptance/linode.json and wired into ~/.ssh/config. Hand-clicking
 * loses the root password and the ids the cleanup steps need.
 *
 * Usage:
 *   node scripts/linode_provision.mjs create --token-file ~/.lessv/linode.env \
 *     --ssh-key ~/.ssh/lessv_p1a_ed25519.pub --out ~/.lessv/acceptance/linode.json
 *   node scripts/linode_provision.mjs list --token-file ~/.lessv/linode.env
 *   node scripts/linode_provision.mjs delete --token-file ~/.lessv/linode.env \
 *     --label lessv-client
 *
 * Secrets stay on disk: the token is read from the file, the root password
 * lands only in the inventory (0600), and nothing sensitive is printed.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = "https://api.linode.com/v4";
const TAG = "lessv-p1a";
const BOOT_TIMEOUT_S = 300;

/** WHAT: read `KEY=value` lines of an env file into a map. */
function readEnvFile(path) {
  const map = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)\s*$/);
    if (match) {
      map[match[1]] = match[2];
    }
  }
  return map;
}

/** WHAT: expand a leading `~` so CLI paths work on Windows too. */
function expand(p) {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(1).replace(/^\//, "").replace(/\//g, "\\"));
  }
  return p;
}

/** WHAT: die with a message. */
function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** WHAT: one Linode API call; returns {status, data}. */
async function api(token, method, path, body = null) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  return { status: response.status, data };
}

/** WHAT: is an IPv4 string a private/non-routable address? */
function isPrivate(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|0\.0\.0\.0)/.test(ip);
}

/** WHAT: random root password (long, mixed classes) for LISH rescue only. */
function randomRootPassword() {
  return `Ls${randomBytes(24).toString("base64url")}9aA`;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--") || argv[i + 1] === undefined) {
      fail(`usage: ${argv[0]} --key value ...`);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

/** WHAT: poll one instance until running with a public IPv4 (or timeout). */
async function waitForRunning(token, id, label) {
  const deadline = Date.now() + BOOT_TIMEOUT_S * 1000;
  let lastStatus = "?";
  while (Date.now() < deadline) {
    const { status, data } = await api(token, "GET", `/linode/instances/${id}`);
    if (status !== 200) {
      fail(`GET instance ${label} -> ${status}`);
    }
    lastStatus = data.status;
    const publicIp = (data.ipv4 ?? []).find((ip) => !isPrivate(ip));
    if (data.status === "running" && publicIp) {
      return publicIp;
    }
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  fail(`${label} did not reach running in ${BOOT_TIMEOUT_S}s (last: ${lastStatus})`);
}

/** WHAT: create one Linode and return its inventory entry. */
async function createInstance(token, spec) {
  const rootPass = randomRootPassword();
  const { status, data } = await api(token, "POST", "/linode/instances", {
    region: spec.region,
    type: spec.type,
    image: spec.image,
    label: spec.label,
    root_pass: rootPass,
    authorized_keys: [spec.sshKey],
    tags: [TAG, spec.label],
    booted: true,
  });
  if (status !== 200) {
    fail(
      `POST instances (${spec.label}) -> ${status}: ` +
        JSON.stringify(data?.errors ?? data).slice(0, 400),
    );
  }
  console.log(`created ${data.label} (id ${data.id}, region ${data.region})`);
  const ipv4 = await waitForRunning(token, data.id, data.label);
  return {
    id: data.id,
    label: data.label,
    region: data.region,
    type: spec.type,
    ipv4,
    root_pass: rootPass,
  };
}

/**
 * WHAT: rewrite the `# lessv-p1a` block of ~/.ssh/config.
 *
 * WHY marker-delimited: reruns replace exactly this block, leaving any
 * other SSH config untouched.
 */
function writeSshConfigBlock(inventory) {
  const configPath = join(homedir(), ".ssh", "config");
  const BEGIN = `# ${TAG} begin`;
  const END = `# ${TAG} end`;
  const block = (host, entry) =>
    [
      `Host ${host}`,
      `  HostName ${entry.ipv4}`,
      "  User root",
      "  IdentityFile ~/.ssh/lessv_p1a_ed25519",
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking accept-new",
      "",
    ].join("\n");
  let existing = "";
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, "utf8");
  }
  const pattern = new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`, "g");
  const replacement =
    `${BEGIN}\n${block("lessv-server", inventory.server)}${block("lessv-client", inventory.client)}${END}\n`;
  const next = existing.match(pattern)
    ? existing.replace(pattern, replacement)
    : `${existing.replace(/\n*$/, "\n\n")}${replacement}`;
  mkdirSync(join(homedir(), ".ssh"), { recursive: true });
  writeFileSync(configPath, next);
  if (process.platform !== "win32") {
    chmodSync(configPath, 0o600);
  }
  console.log(`ssh config block updated: ${configPath}`);
}

async function cmdCreate(args) {
  const token = readEnvFile(expand(args["token-file"])).LINODE_TOKEN;
  if (!token) {
    fail("no LINODE_TOKEN in token file");
  }
  const sshKey = readFileSync(expand(args["ssh-key"]), "utf8").trim();
  const outPath = expand(args.out);
  const type = args.type ?? "g6-nanode-1";
  const image = args.image ?? "linode/debian12";
  const serverRegion = args["server-region"] ?? "jp-tyo-3";
  const clientRegion = args["client-region"] ?? "sg-sin-2";

  // Sequential on purpose: parallel creates can hit the API rate limit.
  const server = await createInstance(token, {
    region: serverRegion, type, image, label: "lessv-server", sshKey,
  });
  let client;
  try {
    client = await createInstance(token, {
      region: clientRegion, type, image, label: "lessv-client", sshKey,
    });
  } catch (error) {
    console.error(
      `warning: server created but client failed (${error.message}); ` +
        `clean up with: node scripts/linode_provision.mjs delete --token-file ${args["token-file"]} --label lessv-server`,
    );
    process.exit(1);
  }
  const inventory = { server, client };
  mkdirSync(dirnameOf(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
  if (process.platform === "win32") {
    // 0600 equivalent: drop inheritance, keep only the current user read.
    const user = process.env.USERNAME;
    if (user) {
      spawnSync("icacls", [outPath, "/inheritance:r", "/grant:r", `${user}:R`]);
    }
  } else {
    chmodSync(outPath, 0o600);
  }
  writeSshConfigBlock(inventory);
  console.log(`server ${server.ipv4}  client ${client.ipv4}`);
  console.log(`inventory written: ${outPath}`);
}

function dirnameOf(p) {
  const index = p.lastIndexOf("/");
  return index > 0 ? p.slice(0, index) : ".";
}

async function cmdList(args) {
  const token = readEnvFile(expand(args["token-file"])).LINODE_TOKEN;
  const { status, data } = await api(token, "GET", "/linode/instances");
  if (status !== 200) {
    fail(`GET instances -> ${status}`);
  }
  const mine = data.data.filter((i) => (i.tags ?? []).includes(TAG));
  if (mine.length === 0) {
    console.log(`no instances tagged ${TAG}`);
    return;
  }
  for (const instance of mine) {
    const publicIp = (instance.ipv4 ?? []).find((ip) => !isPrivate(ip));
    console.log(`${instance.label}  id=${instance.id}  ${instance.status}  ${publicIp ?? "no-ip"}`);
  }
}

/** WHAT: delete the tagged instance with this label, poll until gone. */
async function cmdDelete(args) {
  const token = readEnvFile(expand(args["token-file"])).LINODE_TOKEN;
  const label = args.label;
  const { status, data } = await api(token, "GET", "/linode/instances");
  if (status !== 200) {
    fail(`GET instances -> ${status}`);
  }
  const match = data.data.find(
    (i) => i.label === label && (i.tags ?? []).includes(TAG),
  );
  if (!match) {
    fail(`no instance tagged ${TAG} with label '${label}'`);
  }
  const del = await api(token, "DELETE", `/linode/instances/${match.id}`);
  if (del.status !== 200) {
    fail(`DELETE ${label} -> ${del.status}`);
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const check = await api(token, "GET", `/linode/instances/${match.id}`);
    if (check.status === 404) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log(`deleted ${label} (id ${match.id})`);
  // Drop it from the inventory file when present.
  const inventoryPath = expand("~/.lessv/acceptance/linode.json");
  if (existsSync(inventoryPath)) {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    for (const role of ["server", "client"]) {
      if (inventory[role]?.label === label) {
        inventory[role] = { deleted: true, label, id: match.id };
      }
    }
    writeFileSync(inventoryPath, JSON.stringify(inventory, null, 2) + "\n");
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "create") {
    await cmdCreate(args);
  } else if (command === "list") {
    await cmdList(args);
  } else if (command === "delete") {
    await cmdDelete(args);
  } else {
    fail("usage: linode_provision.mjs create|list|delete ...");
  }
}

await main();
