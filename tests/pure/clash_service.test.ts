/**
 * Clash profile generation.
 *
 * WHY the assertions are whole documents: the YAML is what a client parses
 * byte for byte, and the two fields that decide whether REALITY works at
 * all (`client-fingerprint`, `reality-opts.support-x25519mlkem768`) must
 * never regress into "looks fine, never connects".
 */

import { describe, expect, it } from "vitest";

import { clashProfile } from "../../src/services/clash_service";

const UUID = "11111111-1111-1111-1111-111111111111";
const PBK = "w_OZ1uUriCcd12KatYIFBJulAFDGNp9V1wL_XiQBt08";

/** WHAT: a panel-shaped REALITY URI (the order `share_service` emits). */
const REALITY =
  `vless://${UUID}@example.com:443?encryption=none&type=tcp` +
  `&security=reality&sni=apple.com&fp=chrome&pbk=${PBK}&sid=1234` +
  "&support-x25519mlkem768=true&flow=xtls-rprx-vision#a%20b";

describe("clashProfile", () => {
  it("renders REALITY with the PQ opt-in and chrome fingerprint", () => {
    expect(clashProfile([{ uri: REALITY }])).toBe(
      [
        'proxies:',
        '  - name: "a b"',
        '    type: "vless"',
        '    server: "example.com"',
        "    port: 443",
        `    uuid: "${UUID}"`,
        "    udp: true",
        "    tls: true",
        '    network: "tcp"',
        '    servername: "apple.com"',
        '    flow: "xtls-rprx-vision"',
        '    client-fingerprint: "chrome"',
        "    reality-opts:",
        `      public-key: "${PBK}"`,
        '      short-id: "1234"',
        "      support-x25519mlkem768: true",
        "proxy-groups:",
        '  - name: "LESSV"',
        '    type: "select"',
        "    proxies:",
        '      - "a b"',
        "rules:",
        '  - "MATCH,LESSV"',
        "",
      ].join("\n"),
    );
  });

  it("renders the same proxy for a tcp and a raw link", () => {
    // WHY: the plane emits `raw`, but hand-written and older links say
    // `tcp`; both name the same transport and must produce identical YAML.
    const raw = REALITY.replace("type=tcp", "type=raw");
    expect(clashProfile([{ uri: raw }])).toBe(clashProfile([{ uri: REALITY }]));
  });

  it("keeps PQ on when a hand-written link omits the flag", () => {
    const bare = REALITY.replace("&support-x25519mlkem768=true", "");
    expect(clashProfile([{ uri: bare }])).toContain(
      "support-x25519mlkem768: true",
    );
  });

  it("honours an explicit PQ opt-out", () => {
    const off = REALITY.replace(
      "support-x25519mlkem768=true",
      "support-x25519mlkem768=false",
    );
    expect(clashProfile([{ uri: off }])).not.toContain(
      "support-x25519mlkem768:",
    );
  });

  it("leaves plain TCP without TLS alone", () => {
    const uri = `vless://${UUID}@203.0.113.5:8080?encryption=none&type=tcp#plain`;
    const yaml = clashProfile([{ uri }]);
    expect(yaml).toContain('server: "203.0.113.5"');
    expect(yaml).toContain('network: "tcp"');
    expect(yaml).not.toContain("tls:");
    expect(yaml).not.toContain("servername:");
    expect(yaml).not.toContain("client-fingerprint:");
    expect(yaml).not.toContain("reality-opts:");
  });

  it("maps a WS inbound to ws-opts with the Host header", () => {
    const uri =
      `vless://${UUID}@203.0.113.5:8080?encryption=none&type=ws` +
      "&path=%2Fws-path&host=ws.example.com#ws";
    expect(clashProfile([{ uri }])).toContain(
      [
        '    network: "ws"',
        "    ws-opts:",
        '      path: "/ws-path"',
        "      headers:",
        '        Host: "ws.example.com"',
      ].join("\n"),
    );
  });

  it("maps TLS/httpupgrade onto mihomo's ws adapter", () => {
    const uri =
      `vless://${UUID}@cdn.example.com:443?encryption=none&type=httpupgrade` +
      "&path=%2F&host=cdn.example.com&security=tls&sni=cdn.example.com" +
      "&fp=chrome&alpn=h2%2Chttp%2F1.1#upgrade";
    const yaml = clashProfile([{ uri }]);
    expect(yaml).toContain('    network: "ws"');
    expect(yaml).toContain('    servername: "cdn.example.com"');
    expect(yaml).toContain('      - "h2"');
    expect(yaml).toContain('      - "http/1.1"');
    expect(yaml).toContain("      v2ray-http-upgrade: true");
  });

  it("maps gRPC service names", () => {
    const uri =
      `vless://${UUID}@example.com:443?encryption=none&type=grpc` +
      "&security=tls&sni=example.com&serviceName=svc#grpc";
    expect(clashProfile([{ uri }])).toContain(
      ['    grpc-opts:', '      grpc-service-name: "svc"'].join("\n"),
    );
  });

  it("maps XHTTP path, host, and mode", () => {
    const uri =
      `vless://${UUID}@203.0.113.5:8080?encryption=none&type=xhttp` +
      "&path=%2Fxhttp-path&host=xhttp.example.com&mode=auto#xhttp";
    expect(clashProfile([{ uri }])).toContain(
      [
        '    network: "xhttp"',
        "    xhttp-opts:",
        '      path: "/xhttp-path"',
        '      host: "xhttp.example.com"',
        '      mode: "auto"',
      ].join("\n"),
    );
  });

  it("unbrackets an IPv6 server address", () => {
    const uri = `vless://${UUID}@[2001:db8::1]:443?encryption=none#v6`;
    expect(clashProfile([{ uri }])).toContain('server: "2001:db8::1"');
  });

  it("prefers the readable label and keeps every name unique", () => {
    const yaml = clashProfile([
      { uri: REALITY, label: "Tokyo · Reality → Direct" },
      { uri: REALITY, label: "Tokyo · Reality → Direct" },
    ]);
    expect(yaml).toContain('  - name: "Tokyo · Reality → Direct"');
    expect(yaml).toContain('  - name: "Tokyo · Reality → Direct (2)"');
    expect(yaml).toContain('      - "Tokyo · Reality → Direct (2)"');
  });

  it("escapes quotes, backslashes, and control characters in labels", () => {
    const yaml = clashProfile([{ uri: REALITY, label: 'a "b" \\ c\nd' }]);
    expect(yaml).toContain('- name: "a \\"b\\" \\\\ c\\nd"');
  });

  it("skips links that cannot become a proxy", () => {
    expect(clashProfile([])).toBe("");
    expect(
      clashProfile([
        { uri: "http://example.com" },
        { uri: "not a uri" },
        // a REALITY link without the public key can only fail silently
        { uri: REALITY.replace(`&pbk=${PBK}`, "") },
        // mihomo has no transport by this name
        {
          uri: `vless://${UUID}@example.com:443?encryption=none&type=kcp#kcp`,
        },
      ]),
    ).toBe("");
  });
});
