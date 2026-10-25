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
 * zone/TXT API the certificate flows call. P1b.4: the plugin has no fetch
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
            // Test-only fixed secrets (P0.3): the suite runs hermetically —
            // no .dev.vars, no operator values. Production secrets come
            // from `wrangler secret` / --secrets-file only. CF_DNS_API_TOKEN
            // (P1b): every DNS call is mocked in tests, so a placeholder
            // keeps the binding shape real without network access.
            KEY_SECRET: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            ADMIN_KEY: "test-admin-key",
            CF_DNS_API_TOKEN: "test-only-token",
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
  },
});
