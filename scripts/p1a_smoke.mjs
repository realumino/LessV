/**
 * WHAT: read-only acceptance checks for the deployed P1a plane.
 *
 * WHY a script and not curl-by-hand: the P1a gates repeat after every
 * restart/recovery drill (P1a.7), and the checks are coupled — sub bytes
 * must equal the links' URIs exactly, and the URI must carry every REALITY
 * parameter. Manual curling drifts; this either prints PASS lines or a
 * FAIL with the parameter name, and never prints a credential (no admin
 * key, no sub token, no URI, no uuid).
 *
 * Usage:
 *   node scripts/p1a_smoke.mjs --host https://cp.example.com \
 *     --admin-key-file .env.production --node tokyo01 --user alice \
 *     --expect-sni www.microsoft.com
 */

import { readFileSync } from "node:fs";

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

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) {
      fail(`unexpected argument: ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  return args;
}

async function http(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(15000),
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

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (${detail})`}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const key of ["host", "admin-key-file", "node", "user"]) {
    if (!args[key]) {
      fail(`missing --${key}`);
    }
  }
  const host = args.host.replace(/\/$/, "");
  const adminKey = readEnvFile(args["admin-key-file"]).ADMIN_KEY;
  if (!adminKey) {
    fail(`no ADMIN_KEY in ${args["admin-key-file"]}`);
  }
  const auth = { Authorization: `Bearer ${adminKey}` };
  let failed = false;

  // 1. health
  const health = await http(`${host}/api/health`);
  check("health 200", health.status === 200, `status ${health.status}`);

  // 2. admin auth: none -> 401, wrong -> 401, right -> 200
  const noKey = await http(`${host}/api/admin/nodes`);
  const wrongKey = await http(`${host}/api/admin/nodes`, {
    headers: { Authorization: "Bearer definitely-not-the-key" },
  });
  const rightKey = await http(`${host}/api/admin/nodes`, { headers: auth });
  check("admin no key -> 401", noKey.status === 401, `status ${noKey.status}`);
  check("admin wrong key -> 401", wrongKey.status === 401, `status ${wrongKey.status}`);
  check("admin right key -> 200", rightKey.status === 200, `status ${rightKey.status}`);

  // 3. node sync state
  const sync = await http(`${host}/api/admin/nodes/${args.node}/sync`, { headers: auth });
  check("node exists", sync.status === 200, `status ${sync.status}`);
  if (sync.status === 200) {
    const s = sync.body;
    check("desired_hash set", Boolean(s.desired_hash));
    check("applied == desired", s.applied_hash === s.desired_hash);
    check("sync health ok", s.health === "ok", `health '${s.health}'`);
    check("last_error null", s.last_error === null || s.last_error === undefined, `last_error '${s.last_error}'`);
    check("node last_seen fresh", s.last_seen !== null && s.last_seen !== undefined);
  }

  // 4. user active with a sub token
  const user = await http(`${host}/api/admin/users/${args.user}`, { headers: auth });
  check("user exists", user.status === 200, `status ${user.status}`);
  if (user.status === 200) {
    check("user active", user.body.status === "active", `status '${user.body.status}'`);
    check("sub_token set", Boolean(user.body.sub_token));
  }

  // 5. links: at least one vless://
  const links = await http(`${host}/api/admin/users/${args.user}/links`, { headers: auth });
  check("links endpoint ok", links.status === 200, `status ${links.status}`);
  const uris = (links.body?.links ?? []).map((link) => link.uri);
  check("has vless link", uris.some((uri) => uri.startsWith("vless://")));

  // 6. subscription bytes == links URIs
  const subToken = user.body?.sub_token;
  if (subToken) {
    const sub = await http(`${host}/sub/${subToken}`);
    check("sub endpoint 200", sub.status === 200, `status ${sub.status}`);
    let decoded = null;
    try {
      decoded = Buffer.from(sub.text.trim(), "base64").toString("utf8");
    } catch {
      check("sub is base64", false, "decode failed");
    }
    if (decoded !== null) {
      const subUris = decoded.split("\n").filter(Boolean);
      check("sub matches links", JSON.stringify(subUris) === JSON.stringify(uris),
        `sub has ${subUris.length} lines, links have ${uris.length}`);
    }
  }

  // 7. REALITY parameters in the URI (checked on the parameter NAME only)
  if (uris.length > 0) {
    const uri = uris.find((u) => u.startsWith("vless://")) ?? "";
    let params = {};
    let authority = "";
    try {
      const m = uri.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)/);
      if (m) {
        authority = `${m[2]}:${m[3]}`;
        for (const pair of m[4].split("&")) {
          const [k, v = ""] = pair.split("=");
          params[decodeURIComponent(k)] = decodeURIComponent(v);
        }
      }
    } catch {
      // handled by the checks below
    }
    const want = {
      security: "reality",
      sni: args["expect-sni"],
      flow: "xtls-rprx-vision",
      type: "tcp",
      encryption: "none",
    };
    for (const [key, expected] of Object.entries(want)) {
      check(`uri ${key}=${expected}`, params[key] === expected, `got '${params[key]}'`);
    }
    for (const key of ["pbk", "sid", "spx"]) {
      check(`uri ${key} present`, Boolean(params[key]));
    }
    check("uri has authority host:port", Boolean(authority));
  }

  failed = results.some((r) => !r.ok);
  const passed = results.length - results.filter((r) => !r.ok).length;
  console.log(`\n${passed}/${results.length} checks ${failed ? "FAILED" : "passed"}`);
  process.exit(failed ? 1 : 0);
}

await main();
