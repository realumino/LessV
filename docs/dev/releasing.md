# Releasing

Two artifacts are versioned independently:

- **Plane** — Worker + SPA + migrations. Version in `package.json`; deployed
  with `npm run deploy`.
- **Node** — `lessv-node` static binary + `install.sh` + unit files. Version in
  `node/Cargo.toml`; published as a Gitee Release tag `node-v<version>`.

The node↔plane protocol is a third, separate number. `docs/PROTOCOL.md`,
`PROTOCOL_VERSION` in `src/routers/node.ts`, and `node/Cargo.toml` move
together only when the wire contract changes; the version is pinned by
`tests/pure/protocol_freeze.test.ts`. A plane deploy that changes the
protocol requires a node release, and vice versa.

## Plane release

1. Run the full baseline from [`development.md`](development.md): `npm test`,
   `npm run typecheck`, frontend tests and build, `cargo test`, and
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

## Node release

`scripts/release_node.mjs` builds the static bundles from a clean tree and
publishes them. `node/Cargo.toml` is the single version source; the script
does not accept `--version`.

1. Bump the version in `node/Cargo.toml`. If the wire contract changed, bump
   the protocol in all three files and update the freeze test.
2. Run `(cd node && cargo test)` and the full baseline.
3. Build both architectures on a Linux host with the musl targets (or the
   documented cross toolchain):

   ```bash
   npm run release:node -- --targets amd64,arm64
   ```

   Output in `dist/`:

   ```
   lessv-node-<version>-linux-amd64.tar.gz
   lessv-node-<version>-linux-arm64.tar.gz
   SHA256SUMS
   install.sh
   VERSION
   *.sha256
   ```

   Each tarball contains the binary, `install.sh`, `VERSION`, `systemd/`, and
   `openrc/`. It deliberately does not contain `src/`, `Cargo*`, or
   `target/`.
4. Inspect the artifacts: `tar -tzf` each tarball, run
   `sha256sum -c SHA256SUMS`, and confirm the binary reports the version in
   its filename (`./lessv-node version`).
5. Publish the Gitee release. `--upload` creates or reuses the tag
   `node-v<version>` and uploads the tarballs, `install.sh`, `VERSION`, and
   `SHA256SUMS`:

   ```bash
   GITEE_TOKEN=<token> npm run release:node -- \
     --targets amd64,arm64 --upload
   ```

   The token needs Gitee release permissions. It is read from the environment
   or `--token-file`; never put it in a command line that lands in shell
   history or a log.
6. Verify from a clean host: download the tarball, check `SHA256SUMS`, run
   `install.sh --help`, and install on a disposable node. The installer
   refuses an nginx linked against OpenSSL < 3.5; that is intentional.

`install.sh` in a release tarball already carries the version, and it also
supports downloading a release by itself. Re-running it on an installed node
is the upgrade path: it reuses `/etc/lessv/node.toml` and does not re-enroll.
A node binary upgrade does not require a plane deploy unless the protocol
changed.

Do not publish a tarball built from a dirty tree, a binary built for the wrong
libc, or an artifact whose `VERSION` disagrees with the tag. The node trusts
`SHA256SUMS`; a mismatched release is worse than no release.

## Release checklist

- [ ] Full test baseline green.
- [ ] No secrets, real hostnames, IPs, serials, or operator paths in the
      tracked diff.
- [ ] Protocol files agree, or none changed.
- [ ] Migration is additive and applied by the deploy pipeline.
- [ ] `worker-configuration.d.ts` regenerated if bindings changed.
- [ ] Plane deploy health check passed.
- [ ] Node tarballs checksum-verified and installed on a disposable host.
- [ ] Release notes name the version, protocol, and operator-visible change.
