/**
 * WHAT: run every test inside workerd through the Workers vitest plugin.
 *
 * WHY the migrations are read here and applied in tests/setup.ts: D1 in
 * tests is real D1 semantics, and the schema must match production. WHY the
 * assets directory is overridden to tests/stub-assets: the local wrangler
 * config (seeded from the committed wrangler.example.jsonc) points at the
 * gitignored frontend/dist, and tests must never depend on a SPA build.
 * Paths are relative to the repo root, like the wrangler configPath beside
 * this override.
 */

/**
 * WHAT: the script of a test-only worker that intercepts every outbound
 * request (via miniflare's `outboundService`) and answers the offline
 * zone/TXT API the certificate flows call. The plugin has no fetch
 * mock, so outbound interception is the only hermetic way to exercise
 * zone-dependent endpoints over HTTP.
 */
const OUTBOUND_MOCK_SCRIPT = `
const ZONES = [
  { id: "zone-test", name: "example.com", status: "active" },
  { id: "zone-example", name: "example.com", status: "active" },
];
const TXT = new Map();
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin === "https://api.cloudflare.com") {
      const list = url.pathname === "/client/v4/zones";
      const byId = url.pathname.match(/^\\/client\\/v4\\/zones\\/([^\\/]+)$/);
      if (list && request.method === "GET") {
        const name = url.searchParams.get("name");
        return Response.json({
          success: true,
          result: name ? ZONES.filter((z) => z.name === name.toLowerCase()) : ZONES,
        });
      }
      if (byId && request.method === "GET") {
        const zone = ZONES.find((z) => z.id === decodeURIComponent(byId[1]));
        if (!zone) return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
        return Response.json({ success: true, result: zone });
      }
      return Response.json({ success: false, errors: [{ message: "unexpected DNS API request" }] }, { status: 500 });
    }
    if (url.origin === "https://api.cloudflareclient.com" && url.pathname.includes("/reg")) {
      // The WARP preset registers a device and then switches it to MASQUE;
      // these canned responses keep the preset path hermetic while preserving
      // the real response shapes of both calls.
      if (request.method === "PATCH") {
        return Response.json({
          config: {
            peers: [{
              public_key: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIw==",
              endpoint: { v4: "162.159.198.2:0", v6: "[2606:4700:103::2]:0" },
            }],
            interface: { addresses: { v4: "172.16.0.2", v6: "2606:4700:110:8a78:72d9:6e7f:da52:294f" } },
          },
        });
      }
      return Response.json({
        id: "warp-device-test",
        token: "warp-token-test",
        config: { client_id: "UVHc", peers: [], interface: { addresses: {} } },
      });
    }
    if ((url.origin === "https://cloudflare-dns.com" && url.pathname === "/dns-query") ||
        (url.origin === "https://dns.google" && url.pathname === "/resolve")) {
      const name = url.searchParams.get("name");
      const answer = (TXT.get(name ?? "") ?? []).map((data) => ({ type: 16, data: "\\"" + data + "\\"" }));
      return Response.json({ Status: 0, Answer: answer });
    }
    return Response.json({ error: "unexpected outbound request", url: url.href }, { status: 500 });
  },
};
`;

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * WHAT: run every test inside workerd through the Workers vitest plugin.
 *
 * WHY the migrations are read here and applied in tests/setup.ts: D1 in
 * tests is real D1 semantics, and the schema must match production. WHY the
 * assets directory is overridden to tests/stub-assets: the local wrangler
 * config (seeded from the committed wrangler.example.jsonc) points at the
 * gitignored frontend/dist, and tests must never depend on a SPA build.
 * Paths are relative to the repo root, like the wrangler configPath beside
 * this override.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("migrations");
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          outboundService: "outbound-mock",
          workers: [
            {
              name: "outbound-mock",
              modules: true,
              compatibilityDate: "2026-09-17",
              script: OUTBOUND_MOCK_SCRIPT,
            },
          ],
          bindings: {
            TEST_MIGRATIONS: migrations,
            // The one test-only secret: the suite runs hermetically — no
            // .dev.vars, no operator values. Production values come from
            // `wrangler secret` / --secrets-file only. Panel identities and
            // the DNS token are D1 rows: identity is seeded in
            // tests/setup.ts, and every DNS call is mocked outbound, so no
            // credential binding exists to drift from production.
            KEY_SECRET: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          },
          // WHY the binding is declared here and not in wrangler.jsonc:
          // the deploy config never fetches assets from the Worker, so
          // it relies on the default (absent) binding. The asset tests
          // need one to reach the assets service; keeping it in the test
          // harness leaves the deployed config untouched. See
          // tests/workerd/admin_assets.test.ts.
          assets: { directory: "tests/stub-assets", binding: "ASSETS" },
        },
      };
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    // WHY files run one at a time: the tier shares one D1, and the plane has
    // global rows (plane_settings) that a naming test must change to prove
    // the render. Unique ids isolate everything else; a global row cannot be
    // made unique, so overlapping files could observe each other's template.
    fileParallelism: false,
  },
});
