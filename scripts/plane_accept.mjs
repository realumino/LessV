/**
 * WHAT: read-only acceptance checks for a deployed plane (certificates,
 * nginx state, subscription).
 *
 * WHY a script and not curl-by-hand: these gates repeat after every
 * renewal/agent upgrade, and the checks are coupled — the node's cert list
 * must match the assigned domain's production current, the subscription
 * bytes must equal the admin links, and every URI must carry the REALITY
 * parameters. Manual curling drifts; this prints PASS/FAIL lines and never
 * prints a credential (no admin key, no sub token, no URI, no uuid — the
 * certificate fingerprint is not a secret and is printed).
 *
 * The only write path is --renew (POST /issue + run polling); without it
 * the script performs GET requests only.
 *
 * Usage:
 *   node scripts/plane_accept.mjs --host https://cp.example.com \
 *     --admin-key-file .env.production --node <node-id> --user <username> \
 *     --domain <cert-domain> --fingerprint <sha256-hex> [--renew]
 *
 * Exit codes: 0 all checks pass, 1 some check failed, 2 bad arguments.
 */

import { readFileSync } from "node:fs";

const REQUIRED_ARGS = ["host", "admin-key-file", "node", "user", "domain", "fingerprint"];
const VALUE_ARGS = new Set([...REQUIRED_ARGS]);
const FLAG_ARGS = new Set(["renew"]);
const TIMEOUT_MS = 20000;
const RENEW_POLL_MS = 5000;
const RENEW_TIMEOUT_MS = 20 * 60 * 1000;
// The node pulls on its 30s heartbeat; 4 minutes covers heartbeat + nginx
// reload + a slow report without ever hanging the run.
const RENEW_PULL_TIMEOUT_MS = 4 * 60 * 1000;

function usage() {
  console.error(
    "usage: node scripts/plane_accept.mjs --host <url> --admin-key-file <path>\n" +
      "  --node <id> --user <username> --domain <name> --fingerprint <hex> [--renew]",
  );
  process.exit(2);
}

/**
 * WHAT: read the ADMIN_KEY from an env file.
 *
 * WHY the whole rest of the line: the key value may itself contain '='
 * (base64 has no '=', but a hand-rolled value might), so only the first
 * '=' splits the line.
 */
function readAdminKey(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    console.error(`error: cannot read ${path}`);
    process.exit(2);
  }
  for (const line of text.split("\n")) {
    if (/^ADMIN_KEY=/.test(line)) {
      const value = line.slice("ADMIN_KEY=".length).trim();
      if (value === "") {
        console.error(`error: empty ADMIN_KEY in ${path}`);
        process.exit(2);
      }
      return value;
    }
  }
  console.error(`error: no ADMIN_KEY= line in ${path}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      usage();
    }
    const name = argv[i].slice(2);
    if (FLAG_ARGS.has(name)) {
      args[name] = true;
    } else if (VALUE_ARGS.has(name)) {
      if (i + 1 >= argv.length) {
        usage();
      }
      args[name] = argv[++i];
    } else {
      usage();
    }
  }
  for (const key of REQUIRED_ARGS) {
    if (!args[key]) {
      usage();
    }
  }
  return args;
}

/**
 * WHAT: one fetch with a hard timeout, returning status + parsed body.
 *
 * WHY a helper: every call gets AbortSignal.timeout, and a network error
 * becomes status 0 so checks can fail with a line instead of crashing.
 */
async function http(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, text };
  } catch (error) {
    return { status: 0, body: null, text: String(error) };
  }
}

/**
 * WHAT: one-line, value-free summary of a non-2xx response.
 *
 * WHY keys/types only: `detail` can embed request-derived values; the
 * status code and the shape of the error are all a FAIL line needs.
 */
function safeSummary(response) {
  if (response.status === 0) {
    return `network error: ${response.text.split("\n")[0]}`;
  }
  const body = response.body;
  if (body === null || body === undefined) {
    return `status ${response.status}, empty body`;
  }
  if (typeof body === "string") {
    return `status ${response.status}, non-JSON body`;
  }
  if (Array.isArray(body)) {
    return `status ${response.status}, body array[${body.length}]`;
  }
  const keys = Object.keys(body)
    .map((key) => `${key}:${Array.isArray(body[key]) ? "array" : typeof body[key]}`)
    .join(", ");
  return `status ${response.status}, body {${keys}}`;
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
}

/** WHAT: the URL parameter names every REALITY link must carry. */
const REQUIRED_URI_PARAMS = [
  ["security", "reality"],
  ["flow", "xtls-rprx-vision"],
  ["encryption", "none"],
  ["type", "tcp"],
];
const REQUIRED_URI_FLAG_PARAMS = ["pbk", "sid", "spx"];

function uriProblems(uri, domain) {
  const problems = [];
  let params = {};
  try {
    // Fragment (share-label) and anything after '?' is not a parameter.
    const query = (uri.split("?")[1] ?? "").split("#")[0];
    for (const pair of query.split("&")) {
      const [key, value = ""] = pair.split("=");
      if (key !== "") {
        params[decodeURIComponent(key)] = decodeURIComponent(value);
      }
    }
  } catch {
    return ["unparseable URI query"];
  }
  for (const [key, expected] of REQUIRED_URI_PARAMS) {
    if (params[key] !== expected) {
      problems.push(`${key}='${params[key]}' expected '${expected}'`);
    }
  }
  if (params.sni !== domain) {
    problems.push(`sni mismatch (expected the --domain value)`);
  }
  for (const key of REQUIRED_URI_FLAG_PARAMS) {
    if (!params[key]) {
      problems.push(`${key} missing`);
    }
  }
  return problems;
}

/** WHAT: check 1 — health plus the three admin-auth outcomes. */
async function checkAuthAndHealth(host, auth) {
  const health = await http(`${host}/api/health`);
  check(
    "1a health 200 and status ok",
    health.status === 200 && health.body?.status === "ok",
    safeSummary(health),
  );

  const noKey = await http(`${host}/api/admin/nodes`);
  check("1b admin no key -> 401", noKey.status === 401, safeSummary(noKey));
  const wrongKey = await http(`${host}/api/admin/nodes`, {
    headers: { Authorization: "Bearer p1c-acceptance-invalid-key" },
  });
  check("1c admin wrong key -> 401", wrongKey.status === 401, safeSummary(wrongKey));
  const rightKey = await http(`${host}/api/admin/nodes`, { headers: auth });
  check("1d admin right key -> 200", rightKey.status === 200, safeSummary(rightKey));
}

/**
 * WHAT: check 2 — node sync state (hashes, health, nginx, cert report).
 *
 * WHY every violation is collected: the expected deployment fails exactly
 * `cert_synced_at` (agent < 0.2.1 never reports it); listing all offenders
 * in one FAIL line keeps that visible without extra noise.
 */
async function checkSync(host, auth, node) {
  const sync = await http(`${host}/api/admin/nodes/${node}/sync`, { headers: auth });
  if (sync.status !== 200 || sync.body === null || typeof sync.body !== "object") {
    check("2 node sync reachable", false, safeSummary(sync));
    return;
  }
  const s = sync.body;
  const problems = [];
  if (!s.desired_hash) {
    problems.push("desired_hash empty");
  }
  if (s.applied_hash !== s.desired_hash) {
    problems.push("applied_hash != desired_hash");
  }
  if (s.health !== "ok") {
    problems.push(`health='${s.health}' expected 'ok'`);
  }
  if (s.last_error !== null && s.last_error !== undefined) {
    problems.push("last_error not null");
  }
  if (s.nginx_ok !== 1) {
    problems.push(`nginx_ok=${String(s.nginx_ok)} expected 1`);
  }
  if (s.nginx_error !== null && s.nginx_error !== undefined) {
    problems.push("nginx_error not null");
  }
  // cert_synced_at must be a non-null integer (NULL = agent never reported).
  if (typeof s.cert_synced_at !== "number" || !Number.isInteger(s.cert_synced_at)) {
    problems.push("cert_synced_at: expected non-null integer, got null");
  }
  const warnings = Array.isArray(s.warnings) ? s.warnings : [];
  const badWarnings = warnings.filter(
    (warning) =>
      typeof warning === "string" &&
      (warning.includes("not covered") ||
        warning.includes("not 127.0.0.1") ||
        warning.includes("nginx is not healthy")),
  );
  if (badWarnings.length > 0) {
    problems.push(`warnings contains forbidden substrings (${badWarnings.length} item(s))`);
  }
  check(
    "2 node sync state",
    problems.length === 0,
    problems.join("; "),
  );
}

/**
 * WHAT: check 3 — the node's assigned production-current certificates.
 *
 * WHY no environment field here: NodeCertSummary (cert/models.ts) has none —
 * nodeCertSummaries queries production current only, so staging exclusion is
 * check 4d's fingerprint comparison, not a field on this shape.
 */
function checkNodeCerts(nodeCerts, fingerprint) {
  const certs = Array.isArray(nodeCerts?.certs) ? nodeCerts.certs : [];
  const now = Date.now();
  const problems = [];
  if (certs.length < 1) {
    problems.push("certs list empty");
  }
  const matching = certs.find(
    (cert) =>
      cert?.profile === "tlsserver" &&
      cert?.fingerprint_sha256 === fingerprint &&
      typeof cert?.not_after === "string" &&
      Date.parse(cert.not_after) > now,
  );
  if (!matching) {
    problems.push(
      `no certs entry with profile=tlsserver, fingerprint_sha256=--fingerprint, not_after>now (have ${certs.length} entry/entries)`,
    );
  }
  check("3 node cert list", problems.length === 0, problems.join("; "));
  return certs;
}

/**
 * WHAT: check 4 — domain current certs split by environment.
 *
 * WHY the node-list cross-check: the node cert list carries no environment
 * field, so "no staging reaches the node" is proven by fingerprint inequality.
 */
function checkDomainCerts(domainCerts, nodeCerts, domain) {
  const certs = Array.isArray(domainCerts) ? domainCerts : [];
  const problems = [];
  const current = (environment) =>
    certs.filter((cert) => cert?.environment === environment && cert?.is_current === true);
  const productionCurrent = current("production");
  const stagingCurrent = current("staging");
  if (productionCurrent.length !== 1) {
    problems.push(`production current count=${productionCurrent.length} expected 1`);
  }
  if (stagingCurrent.length !== 1) {
    problems.push(`staging current count=${stagingCurrent.length} expected 1`);
  } else if (stagingCurrent[0].environment !== "staging") {
    problems.push("staging current entry not environment=staging");
  }
  const stagingFingerprints = new Set(stagingCurrent.map((cert) => cert.fingerprint_sha256));
  const nodeLeaks = (nodeCerts ?? []).filter((cert) => stagingFingerprints.has(cert.fingerprint_sha256));
  if (nodeLeaks.length > 0) {
    problems.push(`node cert list contains ${nodeLeaks.length} staging fingerprint(s)`);
  }
  check(
    `4 domain ${domain} current certs`,
    problems.length === 0,
    problems.join("; "),
  );
}

/**
 * WHAT: check 5 — subscription bytes equal the admin links, REALITY params.
 *
 * WHY the token is never printed: the sub_token and every URI are
 * credentials; FAIL lines name fields and counts only.
 */
async function checkSubscription(host, auth, user, domain) {
  const userResponse = await http(`${host}/api/admin/users/${user}`, { headers: auth });
  if (userResponse.status !== 200 || typeof userResponse.body !== "object") {
    check("5 user reachable", false, safeSummary(userResponse));
    return;
  }
  const subToken = userResponse.body.sub_token;
  if (subToken === null || subToken === undefined || subToken === "") {
    check("5 user sub_token non-null", false, "sub_token null");
    return;
  }

  const links = await http(`${host}/api/admin/users/${user}/links`, { headers: auth });
  if (links.status !== 200 || links.body === null || typeof links.body !== "object") {
    check("5 links reachable", false, safeSummary(links));
    return;
  }
  const uris = (links.body.links ?? []).map((link) => link.uri);

  const sub = await http(`${host}/sub/${subToken}`);
  const subProblems = [];
  if (sub.status !== 200) {
    subProblems.push(safeSummary(sub));
  }
  let subUris = [];
  try {
    const decoded = Buffer.from(sub.text.trim(), "base64").toString("utf8");
    subUris = decoded.split("\n").filter(Boolean);
  } catch {
    subProblems.push("sub body not valid base64");
  }
  if (subProblems.length === 0 && JSON.stringify(subUris) !== JSON.stringify(uris)) {
    subProblems.push(`sub has ${subUris.length} line(s), links have ${uris.length}`);
  }
  check("5 subscription matches links", subProblems.length === 0, subProblems.join("; "));

  const paramProblems = uris.flatMap((uri) => uriProblems(uri, domain));
  check(
    "5 uri REALITY params",
    uris.length > 0 && paramProblems.length === 0,
    uris.length === 0 ? "no links" : paramProblems.join("; "),
  );
}

/** WHAT: poll one issue run to a terminal status, printing phases only. */
async function pollRun(host, auth, runId) {
  const deadline = Date.now() + RENEW_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RENEW_POLL_MS));
    const run = await http(`${host}/api/admin/cert-runs/${runId}`, { headers: auth });
    if (run.status !== 200 || typeof run.body !== "object") {
      return { ok: false, message: `run poll ${safeSummary(run)}` };
    }
    last = run.body;
    if (last.status === "succeeded") {
      return { ok: true };
    }
    if (last.status === "failed") {
      return {
        ok: false,
        message: `run failed at phase=${String(last.phase)} error=${String(last.error)}`,
      };
    }
  }
  return {
    ok: false,
    message: `run timed out after 20m at phase=${String(last?.phase)} error=${String(last?.error)}`,
  };
}

/**
 * WHAT: poll the node cert list until the renewed certificate landed and the
 * node reported a fresh sync.
 *
 * WHY the wait: the run flips the domain's current pointer, but the node only
 * swaps `current/` on its next heartbeat (30s poll) and the plane's
 * `cert_synced_at` moves with that report. Comparing immediately after
 * `6b run succeeded` races the heartbeat and fails on a fast renewal.
 */
async function waitForRenewedCert(host, auth, node, previousFingerprint, beforeSyncedAt) {
  const deadline = Date.now() + RENEW_PULL_TIMEOUT_MS;
  let last = { certs: [], cert_synced_at: null };
  while (Date.now() < deadline) {
    const response = await http(`${host}/api/admin/nodes/${node}/certs`, { headers: auth });
    if (response.status === 200 && typeof response.body === "object") {
      last = response.body;
      const fresh = (last.certs ?? []).some(
        (cert) =>
          cert?.profile === "tlsserver" &&
          cert?.fingerprint_sha256 !== "" &&
          cert?.fingerprint_sha256 !== previousFingerprint &&
          typeof cert?.not_after === "string" &&
          Date.parse(cert.not_after) > Date.now(),
      );
      const reported =
        typeof last.cert_synced_at === "number" &&
        (typeof beforeSyncedAt !== "number" || last.cert_synced_at > beforeSyncedAt);
      if (fresh && reported) {
        return last;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RENEW_POLL_MS));
  }
  return last;
}

/** WHAT: check 6 (--renew only) — production reissue, then re-verify 2/3. */
async function checkRenew(host, auth, args, domainId) {
  const beforeResponse = await http(`${host}/api/admin/nodes/${args.node}/certs`, {
    headers: auth,
  });
  const beforeSyncedAt =
    typeof beforeResponse.body?.cert_synced_at === "number"
      ? beforeResponse.body.cert_synced_at
      : null;
  const issue = await http(`${host}/api/admin/cert-domains/${domainId}/issue`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: args.domain }),
  });
  const runId = typeof issue.body?.run_id === "string" ? issue.body.run_id : null;
  check(
    "6a issue accepted",
    issue.status === 202 && runId !== null,
    issue.status === 202 ? "run_id missing" : safeSummary(issue),
  );
  if (runId === null) {
    return;
  }
  console.log(`... 6b polling run (phase changes printed, id withheld)`);
  const outcome = await pollRun(host, auth, runId);
  check("6b run succeeded", outcome.ok, outcome.message);
  if (!outcome.ok) {
    return;
  }
  console.log(`... 6c waiting for the node to pull the renewed cert (heartbeat + apply)`);
  const pulled = await waitForRenewedCert(
    host,
    auth,
    args.node,
    args.fingerprint,
    beforeSyncedAt,
  );
  console.log(`... re-running checks 2/3 after renewal`);
  await checkSync(host, auth, args.node);
  const certs = Array.isArray(pulled?.certs) ? pulled.certs : [];
  const problems = [];
  const fresh = certs.find(
    (cert) =>
      cert?.profile === "tlsserver" &&
      cert?.fingerprint_sha256 !== args.fingerprint &&
      cert?.fingerprint_sha256 !== "" &&
      typeof cert?.not_after === "string" &&
      Date.parse(cert.not_after) > Date.now(),
  );
  if (!fresh) {
    problems.push(
      "no certs entry with profile=tlsserver, fingerprint_sha256 != old --fingerprint, not_after>now",
    );
  }
  check("6c renewed fingerprint differs", problems.length === 0, problems.join("; "));
  const advanced =
    typeof pulled?.cert_synced_at === "number" &&
    (beforeSyncedAt === null || pulled.cert_synced_at > beforeSyncedAt);
  check(
    "6d cert_synced_at advanced",
    advanced,
    `before=${String(beforeSyncedAt)} after=${String(pulled?.cert_synced_at)}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const host = args.host.replace(/\/$/, "");
  const adminKey = readAdminKey(args["admin-key-file"]);
  const auth = { Authorization: `Bearer ${adminKey}` };

  await checkAuthAndHealth(host, auth);
  await checkSync(host, auth, args.node);

  // Check 3: the node's production cert summaries.
  const nodeCertsResponse = await http(`${host}/api/admin/nodes/${args.node}/certs`, {
    headers: auth,
  });
  let nodeCerts = [];
  if (nodeCertsResponse.status === 200 && typeof nodeCertsResponse.body === "object") {
    nodeCerts = nodeCertsResponse.body.certs ?? [];
    checkNodeCerts(nodeCertsResponse.body, args.fingerprint);
  } else {
    check("3 node cert list", false, safeSummary(nodeCertsResponse));
  }

  // Check 4: resolve the domain id, then its per-environment current certs.
  const domains = await http(`${host}/api/admin/cert-domains`, { headers: auth });
  const domainList = Array.isArray(domains.body) ? domains.body : [];
  const domain = domainList.find((entry) => entry?.name === args.domain);
  let domainId = domain?.id ?? null;
  if (domains.status === 200 && domainId !== null) {
    const domainCerts = await http(`${host}/api/admin/cert-domains/${domainId}/certs`, {
      headers: auth,
    });
    if (domainCerts.status === 200 && Array.isArray(domainCerts.body)) {
      checkDomainCerts(domainCerts.body, nodeCerts, args.domain);
    } else {
      check(`4 domain ${args.domain} current certs`, false, safeSummary(domainCerts));
    }
  } else {
    check(
      `4 domain ${args.domain} current certs`,
      false,
      domains.status === 200 ? "domain not found in cert-domains list" : safeSummary(domains),
    );
  }

  await checkSubscription(host, auth, args.user, args.domain);

  if (args.renew) {
    if (domainId === null) {
      check("6 issue", false, "domain not found; cannot issue");
    } else {
      await checkRenew(host, auth, args, domainId);
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
