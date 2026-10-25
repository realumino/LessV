/**
 * WHAT: turn a decoded subscription file into an Xray client config.
 *
 * WHY: the automated P1a probe runs a real Xray client on the second VPS
 * and never touches the panel's own services. The vless:// URI carries
 * every parameter (uuid, REALITY pbk/sid/sni/flow); hand-copying them into
 * JSON both wastes effort and risks leaking the uuid into shell history.
 * This parses the first vless:// line and writes the client JSON (socks
 * inbound on 127.0.0.1) to the output path; nothing sensitive is printed.
 *
 * Usage:
 *   node scripts/subscription_to_xray.mjs --sub sub.txt --out client.json \
 *     --socks-port 1080
 */

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_FINGERPRINT = "chrome";

/** WHAT: expand a leading `~` (mirrors linode_provision). */
function expand(p) {
  if (p === "~" || p.startsWith("~/")) {
    return join(homedir(), p.slice(1).replace(/^\//, "").replace(/\//g, "\\"));
  }
  return p;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/**
 * WHAT: parse one vless:// URI into its pieces.
 *
 * WHAT: vless://<uuid>@<host>:<port>?<params>#<name> — params are
 * urlencoded query pairs; the fragment is a display name we ignore.
 */
function parseVlessUri(uri) {
  const match = uri.match(/^vless:\/\/([^@]+)@([^:]+):(\d+)\?([^#]*)/);
  if (!match) {
    fail("subscription line is not a vless:// URI");
  }
  const [, uuid, host, port, query] = match;
  const params = {};
  for (const pair of query.split("&")) {
    const [key, value = ""] = pair.split("=");
    params[decodeURIComponent(key)] = decodeURIComponent(value);
  }
  return { uuid, host, port: Number(port), params };
}

/** WHAT: build the appendix-C client config from a parsed URI. */
function clientConfig(parsed, socksPort) {
  const { uuid, host, port, params } = parsed;
  if (params.security !== "reality") {
    fail(`expected security=reality, got '${params.security ?? "none"}'`);
  }
  for (const key of ["pbk", "sni", "sid"]) {
    if (!params[key]) {
      fail(`missing ${key} in subscription URI`);
    }
  }
  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "socks",
        listen: "127.0.0.1",
        port: socksPort,
        protocol: "socks",
        settings: { udp: true },
      },
    ],
    outbounds: [
      {
        tag: "proxy",
        protocol: "vless",
        settings: {
          vnext: [
            {
              address: host,
              port,
              users: [
                {
                  id: uuid,
                  encryption: "none",
                  flow: params.flow || "",
                },
              ],
            },
          ],
        },
        streamSettings: {
          network: params.type || "tcp",
          security: "reality",
          realitySettings: {
            serverName: params.sni,
            fingerprint: params.fp || DEFAULT_FINGERPRINT,
            publicKey: params.pbk,
            shortId: params.sid,
            spiderX: params.spx || "/",
          },
        },
      },
    ],
  };
}

function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) {
      fail(`unexpected argument: ${argv[i]}`);
    }
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.sub || !args.out) {
    fail("usage: subscription_to_xray.mjs --sub <file> --out <file> [--socks-port 1080]");
  }
  const subPath = expand(args.sub);
  const lines = readFileSync(subPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const uri = lines.find((line) => line.startsWith("vless://"));
  if (!uri) {
    fail("no vless:// line in subscription file");
  }
  const socksPort = Number(args["socks-port"] ?? 1080);
  const config = clientConfig(parseVlessUri(uri), socksPort);
  const outPath = expand(args.out);
  writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
  if (process.platform !== "win32") {
    chmodSync(outPath, 0o600);
  }
  const { host, port } = parseVlessUri(uri);
  console.log(`client config written (${outPath}); server ${host}:${port}, socks 127.0.0.1:${socksPort}`);
}

main();
