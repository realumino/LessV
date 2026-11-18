/**
 * WHAT: one acceptance run against a deployed plane, end to end: node row,
 * staging certificate, a disposable host booted with the cloud-config the
 * plane renders, the assertions that matter, and a teardown that happens even
 * when a check fails.
 *
 * WHY one script and not a checklist: the run is a sequence of eight calls
 * whose ids feed each other, and the expensive half (a Linode, a real
 * certificate, real ports) must not be left behind when something in the
 * middle fails. Every step below either records what it created or prints why
 * it could not, and the teardown is in a `finally` — an aborted run is the
 * case that matters.
 *
 * WHAT IT NEVER DOES: issue a production certificate (`test-issue` only),
 * touch anything it did not create (every delete is by id it minted), or print
 * a credential (the admin key, the node token and the rendered document stay
 * in memory; only ids and hashes are printed).
 *
 * Usage:
 *   node scripts/accept.mjs --plane https://cp.example.com \
 *     --admin-key-file .env.admin --zone example.com \
 *     --linode-token-file .plans/KEYS --image ghcr.io/owner/vela-server:latest \
 *     [--region jp-tyo-3] [--type g6-nanode-1] [--proxy socks5://127.0.0.1:7890] \
 *     [--keep] [--timeout 600] [--out .plans/accept]
 *
 * Exit codes: 0 every check passed and the teardown completed, 1 a check or
 * the teardown failed, 2 bad arguments or a missing prerequisite.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LINODE_API = "https://api.linode.com/v4";
const ALPINE_IMAGE = "linode/alpine3.24";
const CERT_DOMAIN_PREFIX = "lvtest";
const DEFAULT_TIMEOUT_S = 600;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

/** WHAT: read `KEY=value` lines; the first `=` splits, the value keeps `=`. */
function readEnvFile(path) {
  const map = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      map[match[1]] = match[2].trim();
    }
  }
  return map;
}

/** WHAT: parse `--flag value` and `--flag` pairs; unknown flags are fatal. */
function parseArgs(argv) {
  const valued = new Set([
    "plane",
    "admin-key-file",
    "zone",
    "linode-token-file",
    "image",
    "binary",
    "region",
    "type",
    "proxy",
    "timeout",
    "out",
    "label",
  ]);
  const flags = new Set(["keep", "help"]);
  const values = { keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (flags.has(name)) {
      values[name] = true;
      continue;
    }
    if (!valued.has(name)) fail(`unknown flag: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for ${arg}`);
    }
    values[name] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "usage: node scripts/accept.mjs --plane <url> --admin-key-file <path>\n" +
      "  --zone <zone> --linode-token-file <path> --image <ref>\n" +
      "  [--region jp-tyo-3] [--type g6-nanode-1] [--proxy socks5://host:port]\n" +
      "  [--binary /usr/local/bin/vela-server] [--keep] [--timeout 600] [--out .plans/accept]",
  );
  process.exit(0);
}
for (const required of ["plane", "admin-key-file", "zone", "linode-token-file", "image"]) {
  if (args[required] === undefined) fail(`missing --${required}`);
}

const plane = args.plane.replace(/\/+$/, "");
const adminKey = readEnvFile(args["admin-key-file"]).ADMIN_KEY;
if (!adminKey) fail(`no ADMIN_KEY in ${args["admin-key-file"]}`);

const linodeEnv = readEnvFile(args["linode-token-file"]);
const linodeToken = linodeEnv.LINODE_TOKEN ?? linodeEnv.LINODE;
if (!linodeToken) fail(`no LINODE_TOKEN or LINODE in ${args["linode-token-file"]}`);

const region = args.region ?? "jp-tyo-3";
const type = args.type ?? "g6-nanode-1";
const binary = args.binary ?? "/usr/local/bin/vela-server";
const timeoutS = Number.parseInt(args.timeout ?? String(DEFAULT_TIMEOUT_S), 10);
if (!Number.isInteger(timeoutS) || timeoutS < 120 || timeoutS > 3600) {
  fail("--timeout must be 120..3600 seconds");
}
const proxy = args.proxy ?? null;
const outDir = args.out ?? ".plans/accept";
const label = args.label ?? "vela-accept";

/**
 * WHAT: the provider's ceiling for `metadata.user_data`, in bytes.
 *
 * WHY a constant: it is a Linode API limit (16 KiB) and the boot document is
 * edited in this tree, so a size regression must fail here — before an
 * instance exists — instead of as a 400 after the node row and certificate.
 */
const LINODE_USER_DATA_LIMIT = 16384;

/** WHAT: the ids this run created, so the teardown can be exact. */
const created = { nodeId: null, certDomainId: null, linodeId: null };
const checks = [];
const started = new Date().toISOString();
const suffix = randomBytes(4).toString("hex");
const nodeId = `acc${suffix}`.slice(0, 32);
// WHY the certificate name carries the run's suffix: a cert domain row is
// unique by name even after it is soft-deleted, so a fixed name can only be
// tested once on a plane. A per-run label keeps every run independent and
// leaves no live row to collide with.
const certLabel = `${CERT_DOMAIN_PREFIX}-${suffix}`;
const nodeAddress = `${nodeId}.${certLabel}.${args.zone}`;
const certName = `*.${certLabel}.${args.zone}`;

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name, detail) {
  checks.push({ name, ok: null, detail });
  console.log(`SKIP  ${name}${detail ? ` — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function admin(method, path, body) {
  // WHY only reads are retried: a repeated POST could create a second row.
  const attempts = method === "GET" ? 3 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await adminOnce(method, path, body);
    } catch (error) {
      const transient = error instanceof TypeError || /fetch failed/i.test(String(error));
      if (!transient || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function adminOnce(method, path, body) {
  const response = await fetch(plane + path, {
    method,
    headers: {
      Authorization: `Bearer ${adminKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    // The caller decides whether a body was expected.
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

async function linode(method, path, body) {
  const response = await fetch(LINODE_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${linodeToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await response.text();
  const json = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    const reason = JSON.stringify(json?.errors ?? json ?? text).slice(0, 300);
    throw new Error(`${method} ${path} -> ${response.status}: ${reason}`);
  }
  return json;
}

/** WHAT: one command, its stdout; null when the binary is not installed. */
function run(command, argv, input = "") {
  // WHY stdin is closed by default: openssl s_client waits for it forever.
  const result = spawnSync(command, argv, { encoding: "utf8", timeout: 60000, input });
  if (result.error?.code === "ENOENT") return null;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** WHAT: the `host:port` form openssl wants, from a URL or a bare pair. */
function proxyFor(command) {
  if (proxy === null) return [];
  const bare = proxy.replace(/^socks5h?:\/\//, "");
  return command === "openssl" ? ["-proxy", bare] : ["--proxy", proxy];
}

async function waitFor(timeoutSeconds, intervalMs, what, probe) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last = "nothing yet";
  while (Date.now() < deadline) {
    const outcome = await probe();
    if (outcome.done) return outcome.value;
    last = outcome.reason ?? last;
    await sleep(intervalMs);
  }
  throw new Error(`${what} did not happen within ${timeoutSeconds}s (${last})`);
}

/** WHAT: mint the node, its config, the staging certificate and the document. */
async function provisionPlane() {
  const health = await fetch(`${plane}/api/health`, { signal: AbortSignal.timeout(15000) });
  record("plane health", health.status === 200, `GET /api/health -> ${health.status}`);
  if (health.status !== 200) throw new Error("the plane is not healthy; stopping before creating anything");

  const zones = await admin("GET", "/api/admin/zones");
  const zone = zones.find((entry) => entry.name === args.zone);
  if (!zone) throw new Error(`the plane cannot see zone ${args.zone}`);
  record("zone visible to the plane's DNS token", true, args.zone);

  await admin("POST", "/api/admin/nodes", {
    id: nodeId,
    label: `accept ${suffix}`,
    address: nodeAddress,
  });
  created.nodeId = nodeId;
  record("node row created", true, `${nodeId} (${nodeAddress})`);

  const preset = await admin("POST", `/api/admin/nodes/${nodeId}/presets/reality`, {
    config: null,
    options: { domain: nodeAddress },
  });
  if ((preset.warnings ?? []).length > 0) {
    record("REALITY preset", false, preset.warnings.join("; "));
  } else {
    record("REALITY preset", true);
  }
  await admin("PUT", `/api/admin/nodes/${nodeId}/config`, preset.config);

  const domain = await admin("POST", "/api/admin/cert-domains", {
    name: certName,
    zone_id: zone.id,
    include_wildcard: false,
  });
  created.certDomainId = domain.id;
  record("staging certificate domain", true, certName);

  try {
    await admin("POST", `/api/admin/cert-domains/${domain.id}/test-issue`);
  } catch (error) {
    // A retried request that already started a run answers 409; that is the
    // state we wanted, and the poll below is the real check.
    if (!/409/.test(String(error))) throw error;
  }
  const run = await waitFor(600, 5000, "test-issue", async () => {
    const runs = await admin("GET", `/api/admin/cert-domains/${domain.id}/runs`);
    const latest = runs[0];
    if (!latest) return { done: false, reason: "no run recorded" };
    if (latest.status === "queued" || latest.status === "running") {
      return { done: false, reason: `run ${latest.status} at ${latest.phase ?? "?"}` };
    }
    return { done: true, value: latest };
  });
  if (run.status !== "succeeded") {
    record("test-issue against Let's Encrypt staging", false, `${run.status}: ${run.error ?? ""}`.slice(0, 240));
    throw new Error("staging issuance failed");
  }
  record("test-issue against Let's Encrypt staging", true, run.phase ?? "succeeded");

  await admin("PUT", `/api/admin/nodes/${nodeId}/cert-domains`, { domain_ids: [domain.id] });
  await admin("PUT", `/api/admin/nodes/${nodeId}`, { cert_environment: "staging" });
  record("certificate assigned in the staging environment", true);

  const query = new URLSearchParams({ image: args.image, binary });
  const minted = await admin("POST", `/api/admin/nodes/${nodeId}/token?${query}`);
  if (typeof minted.cloud_init !== "string" || !minted.cloud_init.startsWith("#cloud-config")) {
    record("boot document rendered with the token", false, "the response carried no cloud-config");
    throw new Error("no cloud-init in the token response");
  }
  record("boot document rendered with the token", true, `${minted.cloud_init.length} bytes`);
  return minted.cloud_init;
}

/** WHAT: boot one disposable host from the document the plane just rendered. */
async function bootHost(userData) {
  // WHY checked here and not in the plane: the limit belongs to the provider's
  // API. Exceeding it is a 400 after the node row and certificate already
  // exist, which reads like a transient failure instead of a document budget.
  const bytes = Buffer.byteLength(userData, "utf8");
  if (bytes > LINODE_USER_DATA_LIMIT) {
    record("boot document fits the provider limit", false, `${bytes} > ${LINODE_USER_DATA_LIMIT} bytes`);
    throw new Error("the rendered boot document exceeds the provider's user-data limit");
  }
  record("boot document fits the provider limit", true, `${bytes} bytes`);
  const instance = await linode("POST", "/linode/instances", {
    region,
    type,
    image: ALPINE_IMAGE,
    label: nodeId,
    root_pass: randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, ""),
    booted: true,
    tags: [label],
    metadata: { user_data: Buffer.from(userData, "utf8").toString("base64") },
  });
  created.linodeId = instance.id;
  record("host created", true, `Linode ${instance.id} in ${region} (${ALPINE_IMAGE})`);

  const ready = await waitFor(300, 5000, "the host reaching running with an IPv4", async () => {
    const current = await linode("GET", `/linode/instances/${instance.id}`);
    const address = (current.ipv4 ?? [])[0];
    if (current.status === "running" && address) {
      return { done: true, value: address };
    }
    return { done: false, reason: `${current.status}, no address` };
  });
  record("host address", true, ready);
  return ready;
}

/**
 * WHAT: wait for the state the plane itself calls converged.
 *
 * WHY one wait and not four assertions: the config apply and the certificate
 * sync happen on different polls, so "in_sync" can be true while the decoy has
 * not adopted the certificate yet. Waiting for all of it is the only honest
 * gate, and the last observed state is reported when it never arrives.
 */
async function assertConvergence(deadlineS) {
  const expectedDomain = `wildcard.${certLabel}.${args.zone}`;
  let last = null;
  let sync;
  try {
    sync = await waitFor(deadlineS, 10000, "the node reporting a converged state", async () => {
      try {
        last = await admin("GET", `/api/admin/nodes/${nodeId}/sync`);
      } catch (error) {
        return { done: false, reason: String(error).slice(0, 120) };
      }
      const domains = (last.certs ?? []).map((cert) => cert.domain);
      if (!last.last_seen) return { done: false, reason: "no heartbeat yet" };
      if (last.health && last.health !== "ok") {
        return { done: false, reason: `health ${last.health}: ${last.last_error ?? ""}` };
      }
      if (!last.in_sync) return { done: false, reason: "applied hash does not match yet" };
      if (last.nginx_ok !== 1) {
        return { done: false, reason: `nginx not healthy yet: ${last.nginx_error ?? "no report"}` };
      }
      if (!domains.includes(expectedDomain)) {
        return { done: false, reason: `manifest: ${domains.join(", ") || "empty"}` };
      }
      return { done: true, value: last };
    });
  } catch (error) {
    // Report what the plane said last, then let the run fail.
    const state = last ?? {};
    record("node enrolled and converged", false, `agent ${state.agent_version ?? "?"}, in_sync ${state.in_sync}, health ${state.health ?? "?"}`);
    record("nginx accepted the decoy", state.nginx_ok === 1, state.nginx_error ?? "no report");
    record("staging certificate delivered", false, (state.certs ?? []).map((cert) => cert.domain).join(", "));
    throw error;
  }

  record("node enrolled and converged", true, `agent ${sync.agent_version}, xray ${sync.xray_version}`);
  record("no render warnings", (sync.warnings ?? []).length === 0, (sync.warnings ?? []).join("; ").slice(0, 240));
  record("nginx accepted the decoy", sync.nginx_ok === 1, sync.nginx_error ?? "");
  record("staging certificate delivered", (sync.certs ?? []).some((cert) => cert.domain === expectedDomain), (sync.certs ?? []).map((cert) => cert.domain).join(", "));
  return sync;
}

/** WHAT: the two published ports, as a client outside the host sees them. */
function assertPorts(address) {
  const head = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "20",
    ...proxyFor("curl"), `http://${address}/`]);
  if (head === null) {
    skip("port 80 redirects", "curl is not installed on this machine");
  } else {
    const code = head.stdout.trim();
    record("port 80 redirects", code === "301", `HTTP ${code}`);
  }

  const tls = run("openssl", [
    "s_client",
    ...proxyFor("openssl"),
    "-connect",
    `${address}:443`,
    "-servername",
    nodeAddress,
  ]);
  if (tls === null) {
    skip("port 443 serves TLS 1.3 with the post-quantum group", "openssl is not installed on this machine");
    return;
  }
  const text = `${tls.stdout}\n${tls.stderr}`;
  const group = /Negotiated TLS1\.3 group:\s*(\S+)/i.exec(text)?.[1]?.trim() ?? "";
  record("port 443 answers", text.includes("CONNECTED") || tls.status === 0, `exit ${tls.status}`);
  record("post-quantum group negotiated", group === "X25519MLKEM768", group || "not offered");

  // WHY the certificate is decoded separately: s_client's session dump is not a
  // stable interface, while `x509 -issuer` is. The PEM it prints is enough.
  const pem = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec(text)?.[0];
  const decoded = pem === undefined ? null : run("openssl", ["x509", "-noout", "-issuer"], pem);
  if (decoded === null) {
    skip("decoy serves the staging CA", "the peer certificate could not be read");
    return;
  }
  const issuer = decoded.stdout.replace(/\s+/g, " ").trim();
  record("decoy serves the staging CA", /staging/i.test(issuer), issuer || "no issuer line");
}

/** WHAT: the host's ICMP echo exception, as a client outside the host sees it. */
function assertPing(address) {
  // WHY skipped behind a proxy: ICMP has no proxy, so a proxied run would
  // report a failure that says nothing about the host's firewall.
  if (proxy !== null) {
    skip("host answers ICMP echo", "ICMP cannot go through --proxy");
    return;
  }
  const argv = process.platform === "win32"
    ? ["-n", "2", "-w", "2000", address]
    : ["-c", "2", "-W", "2", address];
  const result = run("ping", argv);
  if (result === null) {
    skip("host answers ICMP echo", "ping is not installed on this machine");
    return;
  }
  record("host answers ICMP echo", result.status === 0, `exit ${result.status}`);
}

/** WHAT: remove everything this run created, by id, in dependency order. */
async function teardown() {
  const failures = [];
  if (created.linodeId !== null) {
    try {
      await linode("DELETE", `/linode/instances/${created.linodeId}`);
      console.log(`teardown: Linode ${created.linodeId} deleted`);
      created.linodeId = null;
    } catch (error) {
      failures.push(`Linode ${created.linodeId}: ${String(error).slice(0, 160)}`);
    }
  }
  if (created.nodeId !== null) {
    try {
      await admin("DELETE", `/api/admin/nodes/${created.nodeId}`);
      console.log(`teardown: node ${created.nodeId} deleted`);
      created.nodeId = null;
    } catch (error) {
      failures.push(`node: ${String(error).slice(0, 160)}`);
    }
  }
  if (created.certDomainId !== null) {
    const id = created.certDomainId;
    try {
      // WHY wait: a cert domain cannot be deleted while its issue run is
      // active (409), and a run started moments ago is still running.
      const deadline = Date.now() + 180000;
      for (;;) {
        try {
          await admin("DELETE", `/api/admin/cert-domains/${id}`);
          break;
        } catch (error) {
          if (!/409/.test(String(error)) || Date.now() > deadline) throw error;
          await sleep(5000);
        }
      }
      console.log(`teardown: cert domain ${id} deleted`);
      created.certDomainId = null;
    } catch (error) {
      failures.push(`cert domain: ${String(error).slice(0, 160)}`);
    }
  }
  return failures;
}

let crashed = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    crashed = signal;
    // A throw inside a signal handler does not reach the finally below on
    // every platform; exit so the finally still runs through the normal path.
    process.exitCode = 130;
    const error = new Error(`interrupted by ${signal}`);
    Promise.resolve().then(async () => {
      if (args.keep) return;
      const failures = await teardown();
      for (const failure of failures) console.error(`teardown failed: ${failure}`);
      process.exit(130);
    });
    throw error;
  });
}

const report = { startedAt: started, plane, nodeId, nodeAddress, certName, image: args.image, kept: Boolean(args.keep) };
try {
  const userData = await provisionPlane();
  const address = await bootHost(userData);
  report.linode = { id: created.linodeId, address, region, type };
  report.certDomain = { id: created.certDomainId, name: certName };
  await assertConvergence(timeoutS);
  assertPorts(address);
  assertPing(address);
} catch (error) {
  record("run", false, String(error).slice(0, 300));
} finally {
  if (args.keep) {
    console.log(
      `--keep: left node ${created.nodeId} (Linode ${created.linodeId}, cert domain ${created.certDomainId})`,
    );
  } else {
    const failures = await teardown();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`teardown failed: ${failure}`);
    } else {
      console.log("teardown: clean");
    }
    report.teardown = failures.length === 0 ? "clean" : failures;
  }
}

report.finishedAt = new Date().toISOString();
report.checks = checks;
const stamp = started.replace(/[:.]/g, "-");
const dir = join(outDir, stamp);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

const failed = checks.filter((check) => check.ok === false);
const passed = checks.filter((check) => check.ok === true);
const skipped = checks.filter((check) => check.ok === null);
console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped — report: ${join(dir, "report.json")}`,
);
if (crashed) console.error(`(run ended by ${crashed})`);
process.exit(failed.length === 0 && !report.teardown ? 0 : 1);
