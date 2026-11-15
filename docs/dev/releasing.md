# Releasing

Two artifacts are versioned independently, in two repositories:

- **Plane** — Worker + SPA + migrations. Version in `package.json`; deployed
  with `npm run deploy`.
- **Server** — the node image. Version in the server repository; published
  there by its own workflow.

The node↔plane protocol is a third, separate number. `docs/PROTOCOL.md` and
`PROTOCOL_VERSION` in `src/routers/node.ts` (plus the server repo's
`Cargo.toml`) move together only when the wire contract changes; the version is
pinned by `tests/pure/protocol_freeze.test.ts`. A plane deploy that changes the
protocol requires a server release, and vice versa.

## Plane release

1. Run the full baseline from [`development.md`](development.md): `npm test`,
   `npm run typecheck`, frontend tests and build, and
   `npm run deploy -- --dry-run`.
2. Confirm `npm run types` produced no unexpected change to
   `worker-configuration.d.ts` after a binding change.
3. Deploy only through the pipeline, never bare `wrangler deploy` (the
   prebuild swaps `frontend/dist` for stubs):

   ```bash
   npm run deploy -- --secrets-file .env.production
   ```

   The pipeline builds the SPA, uploads the Worker, applies remote D1
   migrations, and requires `https://<host>/api/health` to answer 200.
4. If the release adds a table or column that the **new** Worker reads
   (`plane_settings`, `link_names`, …), apply the migrations before the
   Worker deploy: `npx wrangler d1 migrations apply DB --remote`. They are
   additive, so the running Worker ignores them, and the pipeline's own apply
   becomes a no-op. Doing it the other way round leaves a window where the new
   Worker queries a missing table.
5. Verify:

   ```bash
   npx wrangler deployments list
   npx wrangler workflows list
   curl -fsS https://<host>/api/health
   ```

6. Tag the commit and write release notes that name the operator-visible
   change, the protocol version, and any migration. Do not put hostnames,
   certificate serials, tokens, or run output in the notes.

Rollback of code is `npx wrangler rollback`. Migrations are forward-only:
`wrangler rollback` does not undo D1 changes, so schema changes must be
additive and safe for the previous Worker version. If a migration cannot be
made backward compatible, the release needs an explicit operator plan, not a
rollback.

The first deploy needs `--secrets-file` because `wrangler secret put` cannot
address a Worker that does not exist yet. Later secret changes use
`npx wrangler secret put <NAME>`; `KEY_SECRET` is never rotated.

Deploying with Cloudflare Access already enabled is fine only if the pipeline
can reach `/api/health`; that path is deliberately left unprotected. Do not
put Access in front of `/api/health`, `/api/node/*`, or `/sub/*`.

## Server release

The node server is built, tested and published in
[LessV-Node](https://github.com/realumino/LessV-Node): the crate, the
`Dockerfile`, the compose file and the image workflow all live there, and its
`docs/` describe the release procedure. This repository ships no server
artifact and no installer.

The plane side of a server release is the contract: `docs/PROTOCOL.md` and
`tests/pure/protocol_freeze.test.ts` are what a new image has to satisfy, and
[`testing.md`](testing.md) describes the environment in which that is checked
(tier D — one node under test).

## Release checklist

- [ ] Full test baseline green.
- [ ] No secrets, real hostnames, IPs, serials, or operator paths in the
      tracked diff.
- [ ] Protocol files agree, or none changed.
- [ ] Migration is additive and applied by the deploy pipeline.
- [ ] `worker-configuration.d.ts` regenerated if bindings changed.
- [ ] Plane deploy health check passed.
- [ ] Release notes name the version, protocol, and operator-visible change.
