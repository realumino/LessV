/**
 * Cloudflare WARP registration for a node's outbound.
 *
 * WHY this exists: a WARP exit is one outbound object, but obtaining it
 * requires a WireGuard key pair and a device registration with Cloudflare's
 * client API (the same exchange wgcf performs). Doing it in the plane means
 * the admin pastes nothing and the private key is generated here, goes into
 * the authored config, and reaches the node through the normal render.
 *
 * WHY the API version and headers are pinned: the endpoint is an app API
 * with no published contract; `v0a2158` plus the okhttp user agent is the
 * long-lived combination wgcf uses. A rejected registration surfaces as an
 * error the admin can retry, never as a half-written config.
 *
 * The registration is free and disposable: each call creates a new device,
 * and the returned credentials live only inside the outbound object.
 */

import { x25519 } from "@noble/curves/ed25519.js";

import { clampScalar } from "../core/x25519";

/** WHAT: the API surface the registration uses. */
export const WARP_API = "https://api.cloudflareclient.com/v0a2158/reg";
export const WARP_MTU = 1280;
/** WHAT: the WireGuard port Cloudflare's peers accept (the API reports 0). */
export const WARP_PORT = 2408;

/** WHAT: the facts a registered device contributes to an outbound. */
export type WarpRegistration = {
  private_key: string;
  public_key: string;
  addresses: [string, string];
  peer_public_key: string;
  endpoint: string;
  reserved: number[];
  client_id: string;
};

/** WHAT: one registration response, as far as this module reads it. */
type WarpResponse = {
  config?: {
    client_id?: unknown;
    peers?: unknown;
    interface?: unknown;
  };
};

/** WHAT: encode bytes as standard base64 (WireGuard's key encoding). */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** WHAT: decode standard base64 into bytes; throws on malformed input. */
export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** WHAT: a fresh clamped WireGuard key pair. */
export function generateKeyPair(): {
  private_key: string;
  public_key: string;
} {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const clamped = clampScalar(raw);
  return {
    private_key: base64Encode(clamped),
    public_key: base64Encode(x25519.getPublicKey(clamped)),
  };
}

/**
 * WHAT: the three reserved bytes WARP's WireGuard framing needs.
 *
 * WHY they come from `client_id`: Cloudflare encodes them as the base64
 * payload of the device's client id; sending the wrong bytes makes the
 * handshake complete but every packet get dropped.
 */
export function reservedFromClientId(clientId: string): number[] {
  const bytes = base64Decode(clientId);
  if (bytes.length < 3) {
    throw new Error(`warp: client_id ${clientId} is too short`);
  }
  return [bytes[0], bytes[1], bytes[2]];
}

/**
 * WHAT: the peer endpoint (`host:2408`) from the registration.
 *
 * WHY the assigned v4 host and not `engage.cloudflareclient.com`: the API
 * hands out a host that belongs to this account's colo; the service name is
 * a DNS dependency and resolves to a pool. The port in the response is 0
 * ("any"), so the documented WireGuard port is used.
 */
function peerEndpoint(peer: Record<string, unknown>): string {
  const endpoint = peer["endpoint"];
  if (typeof endpoint === "object" && endpoint !== null) {
    const v4 = (endpoint as Record<string, unknown>)["v4"];
    if (typeof v4 === "string" && v4) {
      const host = v4.split(":")[0];
      if (host) {
        return `${host}:${WARP_PORT}`;
      }
    }
  }
  throw new Error("warp: response has no peer endpoint");
}

/** WHAT: pull and validate one string field out of a nested object. */
function stringField(
  source: unknown,
  path: string,
): string {
  let cursor: unknown = source;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new Error(`warp: response is missing ${path}`);
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (typeof cursor !== "string" || !cursor) {
    throw new Error(`warp: response is missing ${path}`);
  }
  return cursor;
}

/**
 * WHAT: register one WARP device and return the facts an outbound needs.
 *
 * WHY `fetcher` is a parameter: the registration is the only network call in
 * the preset path, so unit tests inject a stub and prove the request shape
 * and the response parsing without touching Cloudflare.
 */
export async function registerWarp(
  fetcher: typeof fetch,
  now: Date,
): Promise<WarpRegistration> {
  const keys = generateKeyPair();
  const response = await fetcher(WARP_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "okhttp/3.12.1",
      "CF-Client-Version": "a-6.10-2158",
    },
    body: JSON.stringify({
      key: keys.public_key,
      install_id: "",
      fcm_token: "",
      tos: now.toISOString(),
      model: "PC",
      locale: "en_US",
    }),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`warp: registration answered HTTP ${response.status} ${detail}`);
  }
  const body = (await response.json()) as WarpResponse;
  const config = body.config;
  if (typeof config !== "object" || config === null) {
    throw new Error("warp: registration response has no config");
  }
  const peers = config.peers;
  if (!Array.isArray(peers) || peers.length === 0 || typeof peers[0] !== "object") {
    throw new Error("warp: registration response has no peer");
  }
  const clientId = stringField(config, "client_id");
  return {
    private_key: keys.private_key,
    public_key: keys.public_key,
    addresses: [
      `${stringField(config, "interface.addresses.v4")}/32`,
      `${stringField(config, "interface.addresses.v6")}/128`,
    ],
    peer_public_key: stringField(peers[0], "public_key"),
    endpoint: peerEndpoint(peers[0] as Record<string, unknown>),
    reserved: reservedFromClientId(clientId),
    client_id: clientId,
  };
}

/**
 * WHAT: the Xray `wireguard` outbound object for one registration.
 *
 * WHY `noKernelTun` is always true: Xray 26 defaults to a kernel TUN
 * device, which a node without `/dev/net/tun` (every container, and many
 * minimal hosts) cannot create; the built-in stack needs no privileges and
 * is what the outbound is for here.
 */
export function warpOutbound(
  tag: string,
  registration: WarpRegistration,
): Record<string, unknown> {
  return {
    tag,
    protocol: "wireguard",
    settings: {
      secretKey: registration.private_key,
      address: registration.addresses,
      peers: [
        {
          publicKey: registration.peer_public_key,
          endpoint: registration.endpoint,
          allowedIPs: ["0.0.0.0/0", "::/0"],
        },
      ],
      reserved: registration.reserved,
      mtu: WARP_MTU,
      noKernelTun: true,
    },
  };
}
