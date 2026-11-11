/**
 * The REALITY self-steal preset generator.
 *
 * WHY a pure function and not a component: the preset is a documented
 * structure whose only judgment calls are defaults
 * and warnings; testing it without a browser keeps the contract honest,
 * and the dialog stays a thin field collector.
 *
 * WHY the stolen origin is a Unix socket and not a loopback port: Xray and
 * nginx live on the same host, so the ClientHello relay (and every
 * fallback request) can stay inside the kernel. It costs no TCP port, is
 * unreachable from the network even if a firewall is opened for 443, and
 * matches the reference deployment's `listen unix:... ssl` +
 * `realitySettings.dest = <socket>` pairing. lessv-node renders the decoy
 * on this socket by default.
 */

/** WHAT: the decoy socket lessv-node listens on and this preset targets. */
export const DECOY_SOCKET = "/dev/shm/lessv-decoy.sock";

export interface RealityPresetInput {
  /** The domain REALITY presents in its certificate (serverNames[0]). */
  domain: string;
  /** The decoy's Unix socket (default `DECOY_SOCKET`). */
  socketPath?: string;
  /** An existing shortId to keep; default a fresh random 8-hex value. */
  shortId?: string;
  /** The VLESS flow; default xtls-rprx-vision. */
  flow?: string;
  /** The inbound tag; default "reality". */
  tag?: string;
}

export interface RealityPresetResult {
  config: Record<string, unknown>;
  warnings: string[];
}

/**
 * WHAT: build the authored Xray config for one self-steal REALITY node.
 *
 * WHY `privateKey` stays empty: the plane injects/stores keys per inbound
 * (`ensureKeys` at render); the preset only guarantees the structure so a
 * save goes through the existing render/keys/link pipeline untouched.
 */
export function buildRealityPreset(input: RealityPresetInput): RealityPresetResult {
  const warnings: string[] = [];
  const domain = input.domain.trim();
  if (!domain) {
    warnings.push("domain is empty — REALITY needs a domain and a certificate");
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain)) {
    warnings.push(
      `${domain} is an IP address — self-steal needs a domain plus a certificate`,
    );
  }
  const socketPath = input.socketPath?.trim() || DECOY_SOCKET;
  if (!socketPath.startsWith("/")) {
    warnings.push(`nginx socket '${socketPath}' must be an absolute path`);
  } else if (socketPath.length > 100) {
    warnings.push(`nginx socket path is too long (${socketPath.length} > 100)`);
  }
  const shortId = input.shortId ?? randomShortId();
  if (!/^[0-9a-f]*$/.test(shortId) || shortId.length % 2 !== 0) {
    warnings.push(`shortId '${shortId}' must be even-length hex`);
  }
  const tag = input.tag ?? "reality";

  const config: Record<string, unknown> = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag,
        listen: "0.0.0.0",
        port: 443,
        protocol: "vless",
        settings: { clients: [], decryption: "none", flow: input.flow ?? "xtls-rprx-vision" },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            dest: socketPath,
            serverNames: domain ? [domain] : [],
            privateKey: "",
            shortIds: [shortId],
            settings: { fingerprint: "chrome", spiderX: "/" },
          },
        },
      },
    ],
    outbounds: [
      { tag: "BLOCK", protocol: "blackhole" },
      { tag: "direct", protocol: "freedom" },
    ],
    routing: { rules: [] },
  };
  return { config, warnings };
}

/** WHAT: one fresh 8-hex shortId from WebCrypto (4 random bytes). */
export function randomShortId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
