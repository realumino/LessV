# Releasing

Two artifacts are versioned independently, in two repositories:

- **Plane** — Worker + SPA + migrations. Version in `package.json`; deployed
  with `npm run deploy`.
- **Server** — the node image. Version in the server repository; published
  there by its own workflow.

The server↔plane protocol is a third, separate number. `docs/PROTOCOL.md` and
`PROTOCOL_VERSION` in `src/routers/node.ts` (plus the server repo's
`Cargo.toml`) move together only when the wire contract changes; the version is
pinned by `tests/pure/protocol_freeze.test.ts`. A plane deploy that changes the
protocol requires a server release, and vice versa. On the server side that
release is a **MAJOR** image bump: the image version is the release unit (MAJOR
= protocol or data-format break, MINOR = additive capability, PATCH = contents
only), so the tag identifies one artifact and the bump names the break.

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

   The pipeline applies the remote D1 migrations **before** uploading the
   Worker, then verifies that no migration is left pending, requires
   `https://<host>/api/health` to answer 200, and probes a nonexistent
   `/sub/<random>` token (200, empty body) — that path is public and still
   performs a D1 read, so a green pipeline proves routing and database
   reachability. The order is the safety property: an upload and a migration
   have no transaction between them, so the interval where code and schema
   disagree must fall on "old code + new schema", which the running Worker
   survives, never on "new code + old schema", where its writes fail. A failed
   migration aborts before the Worker changes and the previous deployment
   keeps serving.
4. Verify:

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

A schema change that cannot stay additive follows the expand/contract rule,
and its phases never share a release:

1. **Expand** (release N): add the new table or column. Additive, invisible to
   the running code.
2. **Migrate** (release N, after the expand): backfill the old rows into the
   new shape. The backfill is a migration or script that is idempotent —
   re-runnable against an already-migrated row — because a failed deploy is
   re-run whole.
3. **Contract** (release N+1): switch the code to the new shape only, then
   drop the old one. `wrangler rollback` is **not** available past a contract
   step; a contract migration that goes wrong is repaired with D1 Time Travel
   by an explicit operator decision, not rolled back.

Both expand and contract must also leave the *previous* release working: the
old Worker runs against the expanded schema, and the code in the contract
release must not touch the dropped shape.

The first deploy needs `--secrets-file` because `wrangler secret put` cannot
address a Worker that does not exist yet. Later secret changes use
`npx wrangler secret put <NAME>`; `KEY_SECRET` is never rotated.

Deploying with Cloudflare Access already enabled is fine only if the pipeline
can reach `/api/health`; that path is deliberately left unprotected. Do not
put Access in front of `/api/health`, `/api/node/*`, or `/sub/*`.

## Server release

The node server is built, tested and published in
[LessV-Node](https://github.com/realumino/vela-server): the crate, the
`Dockerfile`, the compose file and the image workflow all live there, and its
`docs/` describe the release procedure. Releases are `v<version>` tags on the
image's own version (strict SemVer; a pre-release never moves `latest`), built
per architecture on native runners and merged into one multi-arch index. This
repository ships no server artifact and no installer.

The plane side of a server release is the contract: `docs/PROTOCOL.md` and
`tests/pure/protocol_freeze.test.ts` are what a new image has to satisfy, and
[`testing.md`](testing.md) describes the environment in which that is checked
(tier D — one node under test).

## Moving a deployment to D1-backed certificate artifacts

A deployment created before `migrations/0014_certificate_artifacts.sql` holds
its certificate artifacts in an R2 bucket, and its `certificates` rows carry an
`r2_prefix` column the new schema does not have. A plain `d1 export --table
certificates` therefore cannot be imported; the backfill reads the old rows and
objects and emits importable SQL.

1. Copy every table whose shape did not change first (migrations are additive,
   so this works against the new schema):

   ```bash
   npx wrangler d1 export <old-d1> --remote --no-schema --table <table> \
     --output <file.sql>
   npx wrangler d1 execute <new-d1> --remote --file <file.sql>
   ```

2. Emit the certificate rows plus their artifacts, then apply them:

   ```bash
   node scripts/migrate_cert_artifacts.mjs \
     --bucket <old-r2-bucket> --database <old-d1> --out <artifacts.sql> --remote
   npx wrangler d1 execute <new-d1> --remote --file <artifacts.sql>
   ```

The script refuses a certificate whose sealed leaf key is missing or is not
`v1:`-prefixed, and prints its id; such a row would answer 500 on delivery and
download until it is reissued. Verify with a render: `GET
/api/admin/nodes/{id}/sync` must return a `desired_hash` and no warnings, and
`GET /api/admin/certificates/{id}/download?file=fullchain` must return the PEM
the bucket held.

## Release checklist

- [ ] Full test baseline green.
- [ ] No secrets, real hostnames, IPs, serials, or operator paths in the
      tracked diff.
- [ ] Protocol files agree, or none changed.
- [ ] Migration is additive and applied by the deploy pipeline.
- [ ] `worker-configuration.d.ts` regenerated if bindings changed.
- [ ] Plane deploy health check passed.
- [ ] Release notes name the version, protocol, and operator-visible change.
