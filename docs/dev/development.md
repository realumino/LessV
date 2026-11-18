# Development

This is the contributor guide for the Worker, SPA, and the node server. Operator
procedures are in the top-level `README.md`; system design is in
[`architecture.md`](architecture.md); the node contract is in
[`docs/PROTOCOL.md`](../PROTOCOL.md); certificate and nginx operations are in
[`docs/OPERATIONS.md`](../OPERATIONS.md).

## Prerequisites

- Node.js 22 LTS or newer, with npm.
- No Cloudflare account is needed for tests. A real account is needed only
  to deploy or to exercise real ACME/DNS.

## First checkout

```bash
npm install
npm --prefix frontend install
cp .dev.vars.example .dev.vars       # test-only values are fine locally
cp wrangler.example.jsonc wrangler.jsonc   # if the pre-hooks have not done it
npx wrangler d1 migrations apply DB --local
```

`wrangler.jsonc` is gitignored because it carries the real hostname and the
D1 id written back after the first deploy. The npm pre-hooks copy the
template when the file is missing. `.dev.vars` is a local `wrangler dev`
feature; it is never read by tests or by a deploy. Every key in it must be
declared in `wrangler.example.jsonc` under `secrets.required`, or wrangler
will not bind it at runtime.

## Local loop

```bash
npm run dev                         # Worker + D1 + Workflow at 127.0.0.1:8787
npm --prefix frontend run dev       # Vite at 5173, proxies /api to 8787
```

`npm run dev` stubs `frontend/dist` so the Worker can start without a SPA
build. For SPA work, run Vite separately; its proxy targets port 8787. The
SPA is served under `/admin` in production; public URLs are
`/admin/nodes`, `/admin/certs`, and so on, while the router's internal paths
omit the `/admin` base.

Useful endpoints while developing:

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s -H "Authorization: Bearer $ADMIN_KEY" http://127.0.0.1:8787/api/admin/nodes
```

A fresh local D1 has no admin row, and the plane has no env fallback, so the
first key is minted into it once:

```bash
node scripts/admin_key.mjs create --label dev --local --out .env.admin
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.admin | cut -d= -f2-)
```

The same script is the recovery path: with every key disabled, or after
`rm -rf .wrangler/state`, it is the only way back into the panel.

## Verification

Environment tiers (local Worker, staging Worker, a node under test) live in
[`testing.md`](testing.md); this section is the command baseline only.

Baseline before declaring work done (all green):

```bash
npm test
npm run typecheck
npm --prefix frontend test
npm --prefix frontend run build
```

| Layer | Command | Notes |
|---|---|---|
| Worker integration + pure | `npm test` | workerd via `@cloudflare/vitest-plugin`; hermetic |
| Types | `npm run types && npm run typecheck` | regenerates `worker-configuration.d.ts` |
| Worker build | `npm run build` | `wrangler deploy --dry-run` |
| Frontend | `npm --prefix frontend test` / `run build` | Vitest + `tsc --noEmit` + Vite |
| Deploy pipeline | `npm run deploy -- --dry-run` | build + wrangler dry-run, no cloud |

The server is tested in its own repository; the plane only owns the contract
([`docs/PROTOCOL.md`](../PROTOCOL.md)).

The suite is hermetic: it does not depend on `.dev.vars`, the network, or
real DNS. ACME runs against a mock CA, Cloudflare DNS calls are intercepted,
and the WARP registration endpoint returns a canned device (`vitest.config.ts`).
Tests declare fixed secret bindings, so a local `.dev.vars` only adds a
miniflare loading line; it cannot change test behavior. Tests apply the real
migrations from `migrations/` through `tests/setup.ts`, so a schema change is
exercised by the same DDL production runs.

Real staging/production issuance touches Let's Encrypt state and real DNS.
Only do it on explicit operator request, and never in a retry loop:
production allows 5 certificates per week per domain.

## Where code goes

- `src/worker.ts` — workerd entry; `src/main.ts` — Hono app, middleware,
  route registration.
- `src/routers/` — HTTP translation only. Routers parse and validate bodies,
  call services, and return DTOs from `src/models.ts`.
- `src/services/` — business rules, rendering, registry, sharing,
  subscriptions, maintenance.
- `src/db.ts` — the only module with SQL for the main schema.
- `src/cert/` — the ACME subsystem. `src/cert/store/d1.ts` is its only SQL
  module; `src/cert/issue/workflow.ts` is the Workflow entry point.
- `src/core/` — pure ports of the Python core: canonical JSON, URI helpers,
  allocation. Keep them side-effect free.
- `frontend/src/` — React SPA. `api.ts` is the only module that calls the
  admin API; `lib/` holds pure helpers; `pages/` holds routes.

The node server is a separate repository; this tree never contains its source.
Do not put SQL in routers or services. Do not put HTTP concerns in services.
Do not add a second data store; D1 and the Workflow are the backend.

## Adding a route

1. Add the handler to an existing router when it belongs to that resource.
   A new resource gets a new `src/routers/admin_*.ts` (or `node.ts` / `sub.ts`
   for those contracts).
2. Register the router in `src/main.ts` with `app.route("/", ...)`.
3. The path must sit under `/api/admin/`, `/api/node/`, `/sub/`, or be the
   exact `/api/health`. The `route_groups` guard is fail-closed; a path
   outside the groups is a 404 before routing.
4. Admin routes automatically require a stored panel admin key; node routes
   authenticate through `requireNode`; subscription routes are capability
   URLs.
5. Add the method to `frontend/src/api.ts` and a page/component only when the
   admin needs it.
6. Cover the behavior in `tests/workerd/` (integration) or `tests/pure/`
   (pure logic). A new admin route that leaks a 404/401 distinction is a test
   case, not a detail.

## Changing the schema

Migrations are append-only. Add `migrations/00NN_<name>.sql`; never edit an
applied file. No foreign keys, by convention: deletes are explicit in
`src/db.ts` (and `src/cert/store/d1.ts` for certificate tables). Update the
row types and every query in the same commit. `npm test` applies the new
migration in workerd; `npm run deploy` applies it remotely after
`wrangler deploy`.

Certificate tables live in their own migration history (`0005` onward) and
are documented in `docs/OPERATIONS.md`.

## Changing the node protocol

The protocol is a two-file invariant in this repository:

- `docs/PROTOCOL.md`
- `PROTOCOL_VERSION` in `src/routers/node.ts`

the server repo's crate version is the third value, changed there. Bump only
for a wire change, update all three in one commit, and keep the node's correct
fallback ("serve the current config") true. Add a protocol test in
`tests/workerd/node_protocol.test.ts` or the relevant node module.

## Secrets and local data

- Never commit `.dev.vars`, `.env.production`, `wrangler.jsonc`, inventories,
  rendered cloud-init user data, or node tokens. `.gitignore` covers the
  common paths; check `git status` before committing.
- `KEY_SECRET` is not rotatable. Tests use a fixed key; production uses the
  operator's key and must never be regenerated casually.
- Use a different `KEY_SECRET` locally and in production; an admin key is a
  row, so its value is per-database by construction.
- `worker-configuration.d.ts` is generated (`npm run types`), tracked, and
  regenerated whenever bindings change.
- `docs/` and the README are public. Use placeholders (`cp.example.com`,
  `node1.example.com`, `203.0.113.10`) in examples.

## Style

- TypeScript strict, no `any` unless the generated binding forces it.
- Comments state invariants and reasons, not a narration of the code. No
  references to plans, sessions, or files outside the tree.
- Keep the diff one concern. Imperative commit subjects, no phase prefixes.
- Delete dead code instead of leaving a commented-out alternative.
- The SPA uses the existing design system; do not add a second component
  library or a second fetch wrapper.
