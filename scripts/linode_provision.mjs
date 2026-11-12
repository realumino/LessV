/**
 * WHAT: provision Linode fixtures (server + optional client) and production
 * LessV nodes, and inventory them.
 *
 * WHY a script and not dashboard clicks: a reproducible fixture —
 * `g6-nanode-1` Debian 12 instances with an SSH key injected, polled to
 * `running`, inventoried to a local file (0600, holds the root password)
 * and wired into ~/.ssh/config between `--tag` marker comments so reruns
 * replace exactly that block and cleanup is mechanical. Hand-clicking
 * loses the root password and the ids the cleanup steps need.
 *
 * The `node` command is the production path: it creates the plane node row
 * (with the REALITY preset unless disabled), mints its token, boots an
 * Alpine Linode whose cloud-init user data is `scripts/alpine_cloud_init.yaml`,
 * waits for enrollment, and writes the inventory (0600; holds the LISH root
 * password). That user data disables SSH, so this path writes no SSH alias.
 *
 * Usage:
 *   node scripts/linode_provision.mjs create --token-file <token-file> \
 *     --ssh-key <key.pub> --out <inventory.json> [--tag <tag>]
 *     [--server-only true]   # create only the server
 *   node scripts/linode_provision.mjs node --token-file <linode-env> \
 *     --admin-key-file <plane-env> --cp <url> --node <node-id> \
 *     --address <fqdn> --out <inventory.json> [--label <label>] \
 *     [--region jp-tyo-3] [--type g6-nanode-1] [--image linode/alpine3.24] \
 *     [--version <x.y.z>] [--tag <tag>] [--cert-environment staging] \
 *     [--no-config true] [--wait 300]
 *   node scripts/linode_provision.mjs list --token-file <token-file> [--tag <tag>]
 *   node scripts/linode_provision.mjs delete --token-file <token-file> \
 *     --label <label> [--tag <tag>] [--out <inventory.json>]
 *
 * Secrets stay on disk: tokens are read from files, the root password lands
 * only in the inventory (0600), and nothing sensitive is printed.
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
const BOOT_TIMEOUT_S = 300;
const CLOUD_INIT_TEMPLATE = new URL("alpine_cloud_init.yaml", import.meta.url);
const GITEE_LATEST = "https://gitee.com/api/v5/repos/realumino/lessv/releases/latest";

/** WHAT: read `KEY=value` lines of an env file into a map. */
function readEnvFile(path) {
  const map = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
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

/** WHAT: one Linode API call; returns {status, data}. Retries transient
 * network errors and 429/5xx with backoff (this network's edge drops
 * connections intermittently). */
async function api(token, method, path, body = null) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
    }
    let response, text;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body === null ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      text = await response.text();
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`HTTP ${response.status} from ${path}`);
      continue;
    }
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { status: response.status, data };
  }
  throw lastError ?? new Error("request failed without a response");
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

/** WHAT: wait between polls without blocking the event loop. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WHAT: the newest lessv-node release tag from Gitee, without the prefix. */
async function latestNodeVersion() {
  let response;
  try {
    response = await fetch(GITEE_LATEST, { signal: AbortSignal.timeout(15000) });
  } catch (error) {
    fail(`cannot reach the Gitee release API (${error.message}); pass --version`);
  }
  if (!response.ok) {
    fail(`Gitee release API -> ${response.status}; pass --version`);
  }
  const data = await response.json().catch(() => null);
  const tag = typeof data?.tag_name === "string" ? data.tag_name : "";
  if (!tag.startsWith("node-v") || tag.length <= "node-v".length) {
    fail("the latest Gitee release is not a node-v tag; pass --version");
  }
  return tag.slice("node-v".length);
}

/** WHAT: one control-plane admin call; returns the parsed JSON body. */
async function planeApi(cp, adminKey, method, path, body) {
  let response;
  try {
    response = await fetch(`${cp}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new Error(`plane ${method} ${path}: ${error.message}`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error bodies are reported as text below.
  }
  if (!response.ok) {
    const detail = data?.detail ?? data?.message ?? text.slice(0, 200);
    throw new Error(
      `plane ${method} ${path} -> ${response.status}: ` +
        (typeof detail === "string"
          ? detail
          : JSON.stringify(detail ?? null).slice(0, 400)),
    );
  }
  return data;
}

/**
 * WHAT: substitute the template placeholders and refuse to boot on a typo.
 *
 * WHY it fails loudly: an unresolved placeholder in user data would produce
 * a node that enrolls with the literal string and cannot be debugged over
 * SSH.
 */
function renderCloudInit(template, values) {
  // A Windows checkout can carry CRLF; the embedded bootstrap is POSIX sh.
  const source = template.replace(/\r\n/g, "\n");
  const missing = [...source.matchAll(/__([A-Z0-9_]+)__/g)]
    .map((match) => match[1])
    .filter((key) => !(key in values));
  if (missing.length > 0) {
    throw new Error(
      `cloud-init template has unresolved placeholders: ${[...new Set(missing)].join(", ")}`,
    );
  }
  let rendered = source;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.split(`__${key}__`).join(value);
  }
  return rendered;
}

/** WHAT: poll the plane until the node has enrolled (first heartbeat). */
async function waitForEnrollment(cp, adminKey, nodeId, seconds) {
  const deadline = Date.now() + seconds * 1000;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await planeApi(cp, adminKey, "GET", `/api/admin/nodes/${nodeId}/sync`);
      lastError = null;
      if (last?.state === "active") {
        return last;
      }
    } catch (error) {
      // A transient plane error must not abort a boot that is still running.
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(5000);
  }
  fail(
    `node ${nodeId} did not enroll within ${seconds}s ` +
      `(state: ${last?.state ?? "unknown"}${lastError ? `, last error: ${lastError}` : ""}); ` +
      "inspect /var/log/cloud-init-output.log over LISH, then destroy the instance",
  );
}

/** WHAT: write the inventory owner-only on both platforms. */
function writeInventory(path, inventory) {
  const outPath = expand(path);
  mkdirSync(dirnameOf(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(inventory, null, 2) + "\n");
  if (process.platform === "win32") {
    // 0600 equivalent: drop inheritance, owner-only access. Full control
    // (not read-only): the delete step rewrites this file.
    const user = process.env.USERNAME;
    if (user) {
      spawnSync("icacls", [outPath, "/inheritance:r", "/grant:r", `${user}:F`]);
    }
  } else {
    chmodSync(outPath, 0o600);
  }
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
    tags: [spec.tag, spec.label],
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
 * WHAT: rewrite the tagged block of ~/.ssh/config.
 *
 * WHY marker-delimited: reruns replace exactly this block, leaving any
 * other SSH config untouched.
 */
function writeSshConfigBlock(inventory, sshKeyPath, tag) {
  const configPath = join(homedir(), ".ssh", "config");
  const BEGIN = `# ${tag} begin`;
  const END = `# ${tag} end`;
  const identity = sshKeyPath.replace(/\.pub$/, "").replace(/\\/g, "/");
  const identityLine = identity.startsWith("~")
    ? identity
    : `~/${identity.split(/[:/\\]/).slice(-2).join("/")}`;
  const block = (host, entry) =>
    entry
      ? [
          `Host ${host}`,
          `  HostName ${entry.ipv4}`,
          "  User root",
          `  IdentityFile ${identityLine}`,
          "  IdentitiesOnly yes",
          "  StrictHostKeyChecking accept-new",
          "",
        ].join("\n")
      : "";
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
  const tag = args.tag ?? "lessv";
  // Some runs need exactly one node; creating a second would be an
  // unrequested cost. Value-style flag keeps parseArgs (which always
  // expects `--key value` pairs) unchanged.
  const serverOnly = args["server-only"] === "true";

  // Sequential on purpose: parallel creates can hit the API rate limit.
  const server = await createInstance(token, {
    region: serverRegion, type, image, label: "lessv-server", sshKey, tag,
  });
  let client;
  if (serverOnly) {
    console.log("--server-only: skipping the client instance");
  } else {
    try {
      client = await createInstance(token, {
        region: clientRegion, type, image, label: "lessv-client", sshKey, tag,
      });
    } catch (error) {
      console.error(
        `warning: server created but client failed (${error.message}); ` +
          `clean up with: node scripts/linode_provision.mjs delete --token-file ${args["token-file"]} --label lessv-server`,
      );
      process.exit(1);
    }
  }
  const inventory = serverOnly ? { server } : { server, client };
  writeInventory(outPath, inventory);
  writeSshConfigBlock(serverOnly ? { ...inventory, client: null } : inventory, expand(args["ssh-key"]), tag);
  console.log(`inventory written: ${outPath}`);
  console.log(`server ${server.ipv4}${serverOnly ? "" : `  client ${client.ipv4}`}`);
}

/**
 * WHAT: one command from a node id to a booted, enrolled Alpine node.
 *
 * WHY the plane objects are created here first: the node's cloud-init needs
 * its token before the Linode exists, and the REALITY preset needs the
 * node's address. Doing both here removes the copy-paste step that used to
 * sit between minting a token and handing it to install.sh.
 *
 * WHY no rollback after the Linode exists: a failed first boot is evidence,
 * and the operator decides whether to inspect it over LISH or destroy it.
 * Only a failure before creation (plane error) is rolled back automatically.
 */
async function cmdNode(args) {
  if (!args["token-file"]) {
    fail("--token-file (the Linode token env file) is required");
  }
  if (!args["admin-key-file"]) {
    fail("--admin-key-file (the plane env file with ADMIN_KEY) is required");
  }
  let linodeToken, adminKey;
  try {
    linodeToken = readEnvFile(expand(args["token-file"])).LINODE_TOKEN;
  } catch (error) {
    fail(`cannot read --token-file: ${error.message}`);
  }
  if (!linodeToken) {
    fail("no LINODE_TOKEN in token file");
  }
  try {
    adminKey = readEnvFile(expand(args["admin-key-file"])).ADMIN_KEY;
  } catch (error) {
    fail(`cannot read --admin-key-file: ${error.message}`);
  }
  if (!adminKey) {
    fail("no ADMIN_KEY in the admin key file");
  }
  const cp = String(args.cp ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/.test(cp)) {
    fail("--cp must be the control-plane http(s) URL");
  }
  const nodeId = String(args.node ?? "");
  if (!/^[a-z0-9]{1,32}$/.test(nodeId)) {
    fail("--node must be 1-32 lowercase letters or digits");
  }
  const address = String(args.address ?? "");
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(address) ||
    !address.includes(".")
  ) {
    fail("--address must be the node's fully qualified domain (e.g. vpn.example.org)");
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) {
    fail("--address must be a domain, not an IP: REALITY needs a name and a certificate");
  }
  const label = args.label ?? nodeId;
  const region = args["region"] ?? "jp-tyo-3";
  const type = args.type ?? "g6-nanode-1";
  const image = args.image ?? "linode/alpine3.24";
  if (!/alpine/i.test(image)) {
    console.warn(`warning: ${image} is not an Alpine image; the cloud-init template uses apk/OpenRC`);
  }
  const tag = args.tag ?? "lessv";
  const certEnvironment = args["cert-environment"];
  if (
    certEnvironment !== undefined &&
    !["production", "staging"].includes(certEnvironment)
  ) {
    fail("--cert-environment must be production or staging");
  }
  const waitSeconds = Number.parseInt(args.wait ?? "300", 10);
  if (!Number.isInteger(waitSeconds) || waitSeconds < 30 || waitSeconds > 1800) {
    fail("--wait must be a whole number of seconds in 30..1800");
  }
  if (!args.out) {
    fail("--out is required; the inventory holds the LISH root password");
  }
  const version = args.version ?? (await latestNodeVersion());
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
    fail(`invalid --version: ${version}`);
  }
  const noConfig = args["no-config"] === "true";
  const template = readFileSync(CLOUD_INIT_TEMPLATE, "utf8");

  let createdNode = false;
  let createAttempted = false;
  let instanceId = null;
  try {
    console.log(`creating plane node ${nodeId} (${address})`);
    await planeApi(cp, adminKey, "POST", "/api/admin/nodes", {
      id: nodeId,
      label,
      address,
    });
    createdNode = true;

    if (!noConfig) {
      const preset = await planeApi(
        cp,
        adminKey,
        "POST",
        `/api/admin/nodes/${nodeId}/presets/reality`,
        { config: null, options: { domain: address } },
      );
      for (const warning of preset?.warnings ?? []) {
        console.warn(`preset warning: ${warning}`);
      }
      await planeApi(cp, adminKey, "PUT", `/api/admin/nodes/${nodeId}/config`, preset.config);
    }
    if (certEnvironment) {
      await planeApi(cp, adminKey, "PUT", `/api/admin/nodes/${nodeId}`, {
        cert_environment: certEnvironment,
      });
    }

    const minted = await planeApi(
      cp,
      adminKey,
      "POST",
      `/api/admin/nodes/${nodeId}/token`,
    );
    const token = minted?.token;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("the plane returned an unexpected node token shape");
    }

    const userData = renderCloudInit(template, {
      NODE_ID: nodeId,
      CP_URL: cp,
      TOKEN: token,
      VERSION: version,
    });

    const rootPass = randomRootPassword();
    // Persist the LISH password before the instance exists: a failed create
    // must not lose it, and an unwritable --out must abort before spending.
    const inventory = {
      node: {
        node_id: nodeId,
        label,
        address,
        linode_id: null,
        region,
        type,
        image,
        ipv4: null,
        root_pass: rootPass,
        version,
        cert_environment: certEnvironment ?? "production",
        created_at: new Date().toISOString(),
      },
    };
    writeInventory(args.out, inventory);
    console.log(`inventory written: ${expand(args.out)}`);

    createAttempted = true;
    const created = await api(linodeToken, "POST", "/linode/instances", {
      region,
      type,
      image,
      label,
      root_pass: rootPass,
      tags: [tag, label],
      booted: true,
      metadata: {
        user_data: Buffer.from(userData, "utf8").toString("base64"),
      },
    });
    if (created.status !== 200) {
      // A 4xx is a definite rejection: no instance exists, so the plane row
      // can be rolled back. A 5xx/network failure is ambiguous and keeps it.
      if (created.status < 500) {
        createAttempted = false;
      }
      throw new Error(
        `POST instances (${label}) -> ${created.status}: ` +
          JSON.stringify(created.data?.errors ?? created.data).slice(0, 400),
      );
    }
    instanceId = created.data.id;
    inventory.node.linode_id = instanceId;
    writeInventory(args.out, inventory);
    console.log(`created ${label} (Linode ${instanceId}, ${region}, ${type})`);
    const ipv4 = await waitForRunning(linodeToken, instanceId, label);
    inventory.node.ipv4 = ipv4;
    writeInventory(args.out, inventory);

    const sync = await waitForEnrollment(cp, adminKey, nodeId, waitSeconds);
    console.log(
      `node ${nodeId} enrolled: agent ${sync.agent_version ?? "?"}, ` +
        `xray ${sync.xray_version ?? "?"}, health ${sync.health ?? "?"}`,
    );
    if (sync.last_error) {
      console.warn(`node reports: ${sync.last_error}`);
    }
    console.log(
      `next: ${noConfig ? "write the node config, then " : ""}` +
        `create a DNS-only A record ${address} -> ${ipv4}, then issue and assign a certificate`,
    );
  } catch (error) {
    if (createdNode && !createAttempted) {
      try {
        await planeApi(cp, adminKey, "DELETE", `/api/admin/nodes/${nodeId}`);
        console.error(`removed plane node ${nodeId} after the failed create`);
      } catch {
        console.error(`warning: could not remove plane node ${nodeId}`);
      }
    } else if (createdNode) {
      // The create request may have reached Linode even when the response
      // did not reach us. Deleting the plane row now could strand a running
      // instance with a dead token; keep it and make the ambiguity explicit.
      console.error(
        `plane node ${nodeId} kept: the Linode create may have succeeded; ` +
          "check `node scripts/linode_provision.mjs list` before retrying",
      );
    }
    fail(error instanceof Error ? error.message : String(error));
  }
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
  const tag = args.tag ?? "lessv";
  const mine = data.data.filter((i) => (i.tags ?? []).includes(tag));
  if (mine.length === 0) {
    console.log(`no instances tagged ${tag}`);
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
  const tag = args.tag ?? "lessv";
  const match = data.data.find(
    (i) => i.label === label && (i.tags ?? []).includes(tag),
  );
  if (!match) {
    fail(`no instance tagged ${tag} with label '${label}'`);
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
    await sleep(5000);
  }
  console.log(`deleted ${label} (id ${match.id})`);
  // Drop it from the inventory file when present.
  const inventoryPath = args.out ? expand(args.out) : null;
  if (inventoryPath && existsSync(inventoryPath)) {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    for (const role of ["server", "client", "node"]) {
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
  } else if (command === "node") {
    await cmdNode(args);
  } else if (command === "list") {
    await cmdList(args);
  } else if (command === "delete") {
    await cmdDelete(args);
  } else {
    fail("usage: linode_provision.mjs create|node|list|delete ...");
  }
}

await main();
