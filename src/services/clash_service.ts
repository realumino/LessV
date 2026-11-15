/**
 * Build a mihomo (Clash.Meta) profile from a user's share links.
 *
 * WHY the links and not the config: a subscription is already "this one
 * aggregation, presented differently". Parsing the panel's own URIs keeps
 * the YAML a second presentation of the exact same bytes — same inbound,
 * exit, variant, address, and REALITY key — instead of a second generator
 * that can drift from the links users already import. It also inherits the
 * link layer's forced `fp=chrome`.
 *
 * WHY REALITY needs two explicit fields: mihomo's REALITY client only
 * offers X25519MLKEM768 when `reality-opts.support-x25519mlkem768` is set
 * (the field has no default, and false strips the group from the
 * ClientHello), and only a PQ-capable uTLS profile such as `chrome` can
 * offer it at all. An Xray 26.9.8+ server treats a hello without the
 * hybrid group as an ordinary visit and falls through to the decoy site,
 * so a profile missing either field looks alive and never connects.
 *
 * WHY no YAML library: the document has a fixed shape (scalars, string
 * lists, two-level maps) and every string is double-quoted here, so an
 * operator label can never change the structure. A dependency would only
 * add bytes to the Worker.
 */

/** WHAT: the part of a share link this profile is built from. */
export type ClashLink = { uri: string; label?: string | null };

/** WHAT: a value the profile can contain. */
type Yaml = string | number | boolean | Yaml[] | { [key: string]: Yaml };

/** WHAT: one proxy as the emitter sees it. */
type Dict = { [key: string]: Yaml };

/** WHAT: the parsed parts of a panel-generated VLESS URI. */
type ParsedLink = {
  uuid: string;
  server: string;
  port: number;
  remark: string | null;
  params: URLSearchParams;
};

/** WHAT: the group every profile routes through. */
const GROUP = "VELA";

/** WHAT: keys that may appear unquoted in this document. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * WHAT: render one string as a YAML double-quoted scalar.
 *
 * WHY every string is quoted: values include operator-written labels with
 * `·`/`→`, and quoting is the only way to guarantee that a `:` or a `#` in
 * a label cannot be read as structure. Escape sequences keep the document
 * ASCII-safe.
 */
function scalar(value: string | number | boolean): string {
  if (typeof value !== "string") {
    return String(value);
  }
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === '"' || character === "\\") {
      out += `\\${character}`;
    } else if (character === "\n") {
      out += "\\n";
    } else if (character === "\r") {
      out += "\\r";
    } else if (character === "\t") {
      out += "\\t";
    } else if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    } else {
      out += character;
    }
  }
  return `${out}"`;
}

/** WHAT: return true for a scalar, or an empty collection. */
function inline(value: Yaml): boolean {
  if (typeof value !== "object") {
    return true;
  }
  return Array.isArray(value)
    ? value.length === 0
    : Object.keys(value).length === 0;
}

/** WHAT: render a value that fits on its parent's line. */
function inlineText(value: Yaml): string {
  if (typeof value !== "object") {
    return scalar(value);
  }
  return Array.isArray(value) ? "[]" : "{}";
}

/**
 * WHAT: render one value as YAML lines at a given indentation.
 *
 * WHY the first line of a list item replaces the container indentation:
 * `- key: value` puts the item's first key on the dash's line and leaves
 * every later key two spaces in, which is what this recursion produces.
 */
function lines(value: Yaml, indent: number): string[] {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (inline(item)) {
        out.push(`${pad}- ${inlineText(item)}`);
        continue;
      }
      const rendered = lines(item, indent + 2);
      out.push(`${pad}- ${rendered[0].trimStart()}`, ...rendered.slice(1));
    }
    return out;
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const name = PLAIN_KEY.test(key) ? key : scalar(key);
    if (inline(child)) {
      out.push(`${pad}${name}: ${inlineText(child)}`);
      continue;
    }
    out.push(`${pad}${name}:`, ...lines(child, indent + 2));
  }
  return out;
}

/** WHAT: decode a URI fragment, or null when it is absent or malformed. */
function remark(url: URL): string | null {
  const raw = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (!raw) {
    return null;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * WHAT: parse one `vless://` URI, or null for anything else.
 *
 * WHY the server address is unbracketed: URI authorities bracket IPv6
 * literals, Clash's `server` field does not. `URL` keeps the brackets for
 * non-special schemes, so they are stripped here.
 */
function parseLink(uri: string): ParsedLink | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== "vless:" || !url.username || !url.hostname) {
    return null;
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isFinite(port) || port <= 0) {
    return null;
  }
  const host = url.hostname;
  const server =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return {
    uuid: url.username,
    server,
    port,
    remark: remark(url),
    params: url.searchParams,
  };
}

/**
 * WHAT: map a link's `type` onto a mihomo network and its upgrade flag.
 *
 * WHY `httpupgrade` becomes `ws`: mihomo implements the transport as the
 * WebSocket adapter with `v2ray-http-upgrade`, and has no separate network
 * name for it. Unknown transports return null so they are skipped rather
 * than emitted as an unparseable profile.
 */
function transport(
  type: string | null,
): { network: string; upgrade: boolean } | null {
  switch ((type ?? "tcp").toLowerCase()) {
    case "tcp":
    case "raw":
      return { network: "tcp", upgrade: false };
    case "ws":
      return { network: "ws", upgrade: false };
    case "httpupgrade":
      return { network: "ws", upgrade: true };
    case "grpc":
      return { network: "grpc", upgrade: false };
    case "xhttp":
      return { network: "xhttp", upgrade: false };
    default:
      return null;
  }
}

/**
 * WHAT: return a name no other proxy in the list uses.
 *
 * WHY: Clash requires unique proxy names, and a REMARK can repeat when two
 * variants carry the same label; the first keeps its name and later ones
 * get a counter suffix, which is also what mihomo's own converter does.
 */
function uniqueName(names: Map<string, number>, wanted: string): string {
  const base = wanted.trim() || "Vela";
  const seen = names.get(base) ?? 0;
  names.set(base, seen + 1);
  return seen === 0 ? base : `${base} (${seen + 1})`;
}

/** WHAT: return comma-joined query values split into a list. */
function splitList(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * WHAT: build one proxy entry from a link, or null when it cannot work.
 *
 * WHY a missing `pbk` disqualifies a REALITY link: without the public key
 * mihomo falls back to plain TLS and the REALITY server answers with the
 * decoy certificate, which is a silent failure rather than a visible one.
 */
function proxyEntry(link: ClashLink, names: Map<string, number>): Dict | null {
  const parsed = parseLink(link.uri);
  if (parsed === null) {
    return null;
  }
  const { params } = parsed;
  const route = transport(params.get("type"));
  if (route === null) {
    return null;
  }
  const security = (params.get("security") ?? "none").toLowerCase();
  const tls = security === "tls" || security === "reality";
  const entry: Dict = {
    name: uniqueName(names, link.label ?? parsed.remark ?? parsed.uuid),
    type: "vless",
    server: parsed.server,
    port: parsed.port,
    uuid: parsed.uuid,
    udp: true,
  };
  if (tls) {
    entry["tls"] = true;
  }
  entry["network"] = route.network;
  if (tls) {
    const sni = params.get("sni");
    if (sni) {
      entry["servername"] = sni;
    }
    const alpn = splitList(params.get("alpn"));
    if (alpn.length > 0) {
      entry["alpn"] = alpn;
    }
  }
  const flow = params.get("flow");
  if (flow) {
    entry["flow"] = flow;
  }
  if (tls) {
    // The link layer forces `chrome`; the default only covers hand-written
    // URIs, where mihomo would otherwise pick chrome on its own.
    entry["client-fingerprint"] = params.get("fp") || "chrome";
  }
  if (security === "reality") {
    const publicKey = params.get("pbk");
    if (!publicKey) {
      return null;
    }
    const reality: Dict = { "public-key": publicKey };
    const shortId = params.get("sid");
    if (shortId) {
      reality["short-id"] = shortId;
    }
    // Absent means "let mihomo do its default", which strips the hybrid
    // group; the profile only honours an explicit opt-out.
    if (params.get("support-x25519mlkem768") !== "false") {
      reality["support-x25519mlkem768"] = true;
    }
    entry["reality-opts"] = reality;
  }

  if (route.network === "ws") {
    const ws: Dict = {};
    const path = params.get("path");
    if (path) {
      ws["path"] = path;
    }
    const host = params.get("host");
    if (host) {
      ws["headers"] = { Host: host };
    }
    if (route.upgrade) {
      ws["v2ray-http-upgrade"] = true;
    }
    if (Object.keys(ws).length > 0) {
      entry["ws-opts"] = ws;
    }
  } else if (route.network === "grpc") {
    const service = params.get("serviceName");
    if (service) {
      entry["grpc-opts"] = { "grpc-service-name": service };
    }
  } else if (route.network === "xhttp") {
    const xhttp: Dict = {};
    for (const key of ["path", "host", "mode"] as const) {
      const value = params.get(key);
      if (value) {
        xhttp[key] = value;
      }
    }
    if (Object.keys(xhttp).length > 0) {
      entry["xhttp-opts"] = xhttp;
    }
  }
  return entry;
}

/**
 * WHAT: render the user's links as a complete mihomo profile.
 *
 * WHY one group and one rule: the plane knows which inbound/exit pairings
 * the user may use, not how they want to split traffic by destination, so
 * the profile offers every pairing under a single selector and sends
 * everything there. Clients can add their own rules on top; inventing
 * geo rules here would route traffic the panel never promised to handle.
 *
 * WHY an empty string when nothing is usable: the subscription contract is
 * that an unentitled or unconfigured user receives an empty body, never a
 * broken document.
 */
export function clashProfile(links: ClashLink[]): string {
  const names = new Map<string, number>();
  const proxies: Yaml[] = [];
  for (const link of links) {
    const entry = proxyEntry(link, names);
    if (entry !== null) {
      proxies.push(entry);
    }
  }
  if (proxies.length === 0) {
    return "";
  }
  const document: Dict = {
    proxies,
    "proxy-groups": [
      {
        name: GROUP,
        type: "select",
        proxies: proxies.map((proxy) => (proxy as Dict)["name"] as string),
      },
    ],
    rules: [`MATCH,${GROUP}`],
  };
  return `${lines(document, 0).join("\n")}\n`;
}
