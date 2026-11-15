/**
 * Transport-name normalisation at render time.
 *
 * WHY: Xray renamed the `tcp` transport to `raw` and accepts both names, so
 * the plane emits the current one regardless of which synonym an operator
 * authored. The runtime document is what the hash covers and what a node
 * applies, so the normalisation has to be a pure, testable step — and it must
 * not touch any other network name.
 */

import { describe, expect, it } from "vitest";

import { normalizeTransportNetwork } from "../../src/services/config_service";

/** WHAT: a config with one inbound and one outbound, both on `network`. */
function doc(
  inboundNetwork: string | null,
  outboundNetwork: string | null = null,
): Record<string, unknown> {
  const stream = (network: string | null): Record<string, unknown> =>
    network === null ? {} : { network };
  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "in",
        protocol: "vless",
        port: 443,
        streamSettings: {
          ...stream(inboundNetwork),
          security: "reality",
          tcpSettings: { header: { type: "none" } },
        },
      },
    ],
    outbounds: [
      {
        tag: "out",
        protocol: "vless",
        streamSettings: { ...stream(outboundNetwork), security: "tls" },
      },
      { tag: "BLOCK", protocol: "blackhole" },
    ],
  };
}

describe("normalizeTransportNetwork", () => {
  it("renames tcp to raw on an inbound", () => {
    const config = doc("tcp");
    const normalized = normalizeTransportNetwork(config) as {
      inbounds: { streamSettings: Record<string, unknown> }[];
    };
    expect(normalized.inbounds[0]!.streamSettings["network"]).toBe("raw");
  });

  it("renames tcp to raw on an outbound too", () => {
    const normalized = normalizeTransportNetwork(doc("raw", "tcp")) as {
      outbounds: { streamSettings?: Record<string, unknown> }[];
    };
    expect(normalized.outbounds[0]!.streamSettings!["network"]).toBe("raw");
  });

  it("leaves raw, ws, grpc, xhttp and httpupgrade alone", () => {
    for (const network of ["raw", "ws", "grpc", "xhttp", "httpupgrade"]) {
      const normalized = normalizeTransportNetwork(doc(network)) as {
        inbounds: { streamSettings: Record<string, unknown> }[];
      };
      expect(normalized.inbounds[0]!.streamSettings["network"]).toBe(network);
    }
  });

  it("keeps an absent network absent", () => {
    const normalized = normalizeTransportNetwork(doc(null, null)) as {
      inbounds: { streamSettings: Record<string, unknown> }[];
      outbounds: { streamSettings?: Record<string, unknown> }[];
    };
    expect("network" in normalized.inbounds[0]!.streamSettings).toBe(false);
    expect("network" in normalized.outbounds[0]!.streamSettings!).toBe(false);
  });

  it("does not mutate its input", () => {
    const config = doc("tcp");
    normalizeTransportNetwork(config);
    const original = config as {
      inbounds: { streamSettings: Record<string, unknown> }[];
    };
    expect(original.inbounds[0]!.streamSettings["network"]).toBe("tcp");
  });

  it("keeps tcpSettings next to the renamed transport", () => {
    // WHY: Xray still decodes `tcpSettings` for the raw transport, and dropping
    // it would silently change a header configuration the operator authored.
    const normalized = normalizeTransportNetwork(doc("tcp")) as {
      inbounds: { streamSettings: Record<string, unknown> }[];
    };
    expect(normalized.inbounds[0]!.streamSettings["tcpSettings"]).toEqual({
      header: { type: "none" },
    });
  });
});
