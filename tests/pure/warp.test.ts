/**
 * The WARP registration exchange and the outbound it produces.
 *
 * WHY a stub fetcher: the registration is one HTTP call whose request shape
 * (headers, body, public key) and response parsing are the whole contract.
 * A canned Cloudflare response keeps the test hermetic and pins the reserved
 * bytes, which are the field a re-implementation usually gets wrong.
 */

import { describe, expect, it } from "vitest";

import {
  base64Decode,
  base64Encode,
  generateKeyPair,
  registerWarp,
  reservedFromClientId,
  WARP_API,
  warpOutbound,
} from "../../src/services/warp_service";

/** WHAT: a Cloudflare-shaped registration response. */
function registration(overrides: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      config: {
        client_id: "UVHc",
        peers: [
          {
            public_key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
            endpoint: {
              v4: "162.159.192.4:0",
              v6: "[2606:4700:d0::a29f:c004]:0",
              host: "engage.cloudflareclient.com:2408",
              ports: [2408, 500, 1701, 4500],
            },
          },
        ],
        interface: {
          addresses: {
            v4: "172.16.0.2",
            v6: "2606:4700:110:8a78:72d9:6e7f:da52:294f",
          },
        },
      },
      ...overrides,
    },
    { status: 200 },
  );
}

/** WHAT: a fetch stub that records the request it received. */
function stub(responder: () => Response): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return responder();
  }) as typeof fetch;
  return { fetcher, calls };
}

describe("registerWarp", () => {
  it("posts a WireGuard public key and parses the device facts", async () => {
    const { fetcher, calls } = stub(() => registration());
    const result = await registerWarp(fetcher, new Date("2026-11-11T00:00:00Z"));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WARP_API);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["CF-Client-Version"]).toBe("a-6.10-2158");
    expect(headers["User-Agent"]).toBe("okhttp/3.12.1");

    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body["tos"]).toBe("2026-11-11T00:00:00.000Z");
    expect(body["model"]).toBe("PC");
    expect(base64Decode(String(body["key"]))).toHaveLength(32);

    expect(result).toMatchObject({
      addresses: ["172.16.0.2/32", "2606:4700:110:8a78:72d9:6e7f:da52:294f/128"],
      peer_public_key: "bmXOC+F1FxEMF9dyiK2H5/1SUtzH0JuVo51h2wPfgyo=",
      endpoint: "162.159.192.4:2408",
      reserved: [81, 81, 220],
      client_id: "UVHc",
    });
    // The private key must actually belong to the advertised public key.
    expect(base64Decode(result.private_key)).toHaveLength(32);
    expect(base64Decode(result.public_key)).toHaveLength(32);
  });

  it("fails loudly on a rejected registration", async () => {
    const { fetcher } = stub(() => new Response("no", { status: 429 }));
    await expect(registerWarp(fetcher, new Date())).rejects.toThrow(/HTTP 429/);
  });

  it("fails when the response lacks the fields an outbound needs", async () => {
    const { fetcher } = stub(() => Response.json({}));
    await expect(registerWarp(fetcher, new Date())).rejects.toThrow(/no config/);

    const bare = stub(() =>
      Response.json({ config: { client_id: "UVHc", peers: [], interface: {} } }),
    );
    await expect(registerWarp(bare.fetcher, new Date())).rejects.toThrow(/no peer/);

    const noEndpoint = stub(() =>
      Response.json({
        config: {
          client_id: "UVHc",
          peers: [{ public_key: "x" }],
          interface: { addresses: { v4: "172.16.0.2", v6: "::1" } },
        },
      }),
    );
    await expect(registerWarp(noEndpoint.fetcher, new Date())).rejects.toThrow(
      /no peer endpoint/,
    );
  });

  it("generates distinct clamped key pairs", () => {
    const first = generateKeyPair();
    const second = generateKeyPair();
    expect(first.public_key).not.toBe(second.public_key);
    const raw = base64Decode(first.private_key);
    expect(raw[0] & 0b111).toBe(0);
    expect(raw[31] & 0b11000000).toBe(0b01000000);
    expect(base64Encode(raw)).toBe(first.private_key);
  });

  it("takes the reserved bytes from the client id", () => {
    expect(reservedFromClientId("UVHc")).toEqual([81, 81, 220]);
    expect(() => reservedFromClientId("QQ==")).toThrow(/too short/);
  });
});

describe("warpOutbound", () => {
  it("builds a userspace WireGuard outbound", async () => {
    const { fetcher } = stub(() => registration());
    const result = await registerWarp(fetcher, new Date());
    const outbound = warpOutbound("warp", result);

    expect(outbound).toMatchObject({
      tag: "warp",
      protocol: "wireguard",
      settings: {
        secretKey: result.private_key,
        address: result.addresses,
        peers: [
          {
            publicKey: result.peer_public_key,
            endpoint: "162.159.192.4:2408",
            allowedIPs: ["0.0.0.0/0", "::/0"],
          },
        ],
        reserved: [81, 81, 220],
        mtu: 1280,
        noKernelTun: true,
      },
    });
  });
});
