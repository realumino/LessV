/**
 * Certificate lint: read-only warnings appended to the sync view.
 *
 * WHY a pure module: the rules ("is this REALITY serverName covered by an
 * assigned certificate?", "is the certificate about to expire?") depend on
 * values, not bindings, so unit tests run without workerd and the sync
 * path stays free of issuance state.
 *
 * WHY warnings and not errors: lint never changes rendering, never blocks
 * a save, and never blocks a sync — it makes drift visible in the fleet
 * view before it breaks a connection.
 */

/** WHAT: one assigned production certificate as lint sees it. */
export interface LintCert {
  domain: string;
  sans: string[];
  not_after: string;
}

export interface LintNode {
  nginx_ok: number | null;
  nginx_error: string | null;
}

export interface LintInput {
  /** The RENDERED runtime config (post key/qualify), or null. */
  config: Record<string, unknown> | null;
  certs: LintCert[];
  node: LintNode;
  now: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STRONG_WARN_DAYS = 7;
const INFO_WARN_DAYS = 15;

/**
 * WHAT: return true when one SAN covers one serverName.
 *
 * WHY the wildcard rule: RFC 6125 — `*.example.com` matches exactly one
 * label (`a.example.com`), not `example.com` itself and not
 * `a.b.example.com`. Case-insensitive because DNS names are.
 */
export function sanCovers(serverName: string, san: string): boolean {
  const name = serverName.toLowerCase();
  const pattern = san.toLowerCase();
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    const suffix = `.${base}`;
    return name.endsWith(suffix) && !name.slice(0, -suffix.length).includes(".");
  }
  return name === pattern;
}

/** WHAT: the REALITY inbounds of a rendered config, tagged. */
export function realityInbounds(
  config: Record<string, unknown> | null,
): Array<{ tag: string; serverNames: unknown; dest: unknown; shortIds: unknown }> {
  if (config === null) return [];
  const inbounds = config["inbounds"];
  if (!Array.isArray(inbounds)) return [];
  const reality = [];
  for (const entry of inbounds) {
    if (typeof entry !== "object" || entry === null) continue;
    const inbound = entry as Record<string, unknown>;
    if (inbound["protocol"] !== "vless") continue;
    const stream = inbound["streamSettings"];
    if (typeof stream !== "object" || stream === null) continue;
    const settings = (stream as Record<string, unknown>)["realitySettings"];
    if (typeof settings !== "object" || settings === null) continue;
    reality.push({
      tag: typeof inbound["tag"] === "string" ? inbound["tag"] : "",
      serverNames: (settings as Record<string, unknown>)["serverNames"],
      dest: (settings as Record<string, unknown>)["dest"],
      shortIds: (settings as Record<string, unknown>)["shortIds"],
    });
  }
  return reality;
}

/**
 * WHAT: return true when `dest` is the loopback form `127.0.0.1:<port>`.
 *
 * WHY the prefix is exact: self-steal means nginx on the same host; a
 * public `dest` is the temporary fixture the preset replaces and must be
 * flagged.
 */
export function destIsLoopback(dest: unknown): boolean {
  return typeof dest === "string" && /^127\.0\.0\.1:\d+$/.test(dest);
}

/** WHAT: every shortId is even-length hex (possibly empty string allowed?). */
export function shortIdsValid(shortIds: unknown): boolean {
  if (!Array.isArray(shortIds)) return false;
  for (const id of shortIds) {
    if (typeof id !== "string" || id.length % 2 !== 0 || !/^[0-9a-f]*$/.test(id)) {
      return false;
    }
  }
  return true;
}

/**
 * WHAT: the cert/nginx warnings for one node, in deterministic order:
 * per-inbound REALITY checks, then per-certificate expiry, then nginx.
 */
export function certLintWarnings(input: LintInput): string[] {
  const warnings: string[] = [];
  const inbounds = realityInbounds(input.config);

  for (const inbound of inbounds) {
    const tag = inbound.tag || "?";
    const serverNames = Array.isArray(inbound.serverNames) ? inbound.serverNames : [];
    if (serverNames.length === 0 || serverNames.some((name) => typeof name !== "string")) {
      warnings.push(`reality inbound '${tag}' has no serverNames`);
    } else {
      for (const serverName of serverNames as string[]) {
        const covered = input.certs.some((cert) =>
          cert.sans.some((san) => sanCovers(serverName, san)),
        );
        if (!covered) {
          warnings.push(
            `serverNames '${serverName}' is not covered by an assigned certificate`,
          );
        }
      }
    }
    // Dest and shortIds are independent of the serverNames check.
    if (!destIsLoopback(inbound.dest)) {
      warnings.push(
        `reality inbound '${tag}' dest '${String(inbound.dest)}' is not 127.0.0.1:<port>`,
      );
    }
    if (!shortIdsValid(inbound.shortIds)) {
      warnings.push(`reality inbound '${tag}' has invalid shortIds`);
    }
  }

  for (const cert of input.certs) {
    const expiry = Date.parse(cert.not_after);
    if (!Number.isFinite(expiry)) continue;
    if (expiry <= input.now.getTime()) {
      warnings.push(`certificate for '${cert.domain}' expired at ${cert.not_after}`);
      continue;
    }
    const days = Math.floor((expiry - input.now.getTime()) / MS_PER_DAY);
    if (days < STRONG_WARN_DAYS) {
      warnings.push(`certificate for '${cert.domain}' expires in ${days} day(s)`);
    } else if (days < INFO_WARN_DAYS) {
      warnings.push(`certificate for '${cert.domain}' expires in ${days} day(s)`);
    }
  }

  if (input.node.nginx_ok === 0) {
    const detail = input.node.nginx_error ? `: ${input.node.nginx_error}` : "";
    warnings.push(`nginx is not healthy${detail}`);
  }

  return warnings;
}
