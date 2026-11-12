# Architecture

LessV is a self-hosted Xray management plane. One Cloudflare Worker serves the
admin SPA, the admin API, the node pull API, and subscription URLs. Nodes run
`lessv-node`, a static Rust reconciler that pulls its desired state from the
plane and converges Xray, nginx, and certificates on the host.

This document describes the system as implemented. Protocol details live in
[`docs/PROTOCOL.md`](../PROTOCOL.md); certificate and nginx operations live in
[`docs/OPERATIONS.md`](../OPERATIONS.md); operator procedures live in the
top-level `README.md`.

## Design constraints

- **Pull only.** The plane never connects to a node. A node polls the plane;
  the plane being unavailable costs staleness, not access.
- **One deployable unit.** Worker, SPA, D1 schema, R2 binding, and Workflow
  ship together from this repository.
- **No runtime dependency on the node.** `lessv-node` is one static musl
  binary. nginx and Xray are provisioned from their vendors by `install.sh`,
  not linked into the agent.
- **Deterministic rendering.** A node's desired Xray config is a pure function
  of database state plus stored keys; the same state must hash identically
  every time.
- **Fail closed at the route boundary.** Only the three path prefixes plus
  `/api/health` are routable; anything else answers 404 before routing.
- **Secrets are either sealed or hashed.** REALITY and ACME private keys are
  sealed with `KEY_SECRET`; node tokens are stored as hashes; subscription
  tokens are stored in plaintext because they must remain re-displayable. The
  sealed format is `v1:<base64(iv || ciphertext+tag)>` (AES-256-GCM, 96-bit
  IV). A D1 dump yields only ciphertext; this is a seatbelt, not a substitute
  for database access control.

## Topology

```
Browser ── /admin ──────────────► Worker (Hono, static SPA)
                                     │  /api/admin/*  ← ADMIN_KEY (Bearer)
                                     │  /api/node/*   ← node token
                                     │  /sub/{token}  ← subscription token
                                     ▼
                                    D1 (state)
                                    R2 (certificate artifacts)
                                    Workflow (ACME issuance)

User ── /sub/{token} ──► subscription ──► links (rendered from D1)

Node ── Xray (REALITY :443) ──► lessv-node (Rust, systemd/OpenRC)
         ▲ nginx decoy (Unix socket) │
         └── certificate files ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

The real data path does not traverse the Worker: user traffic terminates at
the node's Xray/nginx pair. The Worker is the management plane and the
subscription renderer.

## Worker

### Routing and trust boundary

- `src/worker.ts` exports the `fetch` handler; `src/main.ts` builds the Hono
  app at module scope (workerd snapshots the top-level scope, so construction
  is side-effect free).
- `src/route_groups.ts` defines the only routable prefixes:
  `/api/admin/`, `/api/node/`, `/sub/`, plus the exact `/api/health`.
  `main.ts` checks the path before routing and answers a bare 404 outside the
  groups. This is a fail-closed guard: a route registered at the wrong path
  stays unreachable.
- The same `*` middleware authenticates every `/api/admin/*` path, including
  unknown ones, with the `ADMIN_KEY` bearer key. The key is compared through
  SHA-256 digests and a constant-time XOR loop (`src/auth/admin_key.ts`), so
  neither content nor length leaks.
- `/api/node/*` authenticates with a node bearer token (hash lookup) plus the
  `X-Lessv-Node` header; every mismatch is the same 401. `/sub/:token` is a
  capability URL: unknown, disabled, expired, and empty users all get an empty
  200 body.
- Cloudflare Access is an optional edge layer in front of the hostname. The
  operator protects the whole host with one Access application and adds
  Bypass applications for `/sub/*`, `/api/node/*`, and `/api/health` so those
  contracts stay reachable. The Worker does not validate
  `Cf-Access-Jwt-Assertion`; it relies on the fact that the only public
  hostname is the Access-protected custom domain (`workers_dev` and preview
  URLs are disabled in the template).

### HTTP surface

| Router | Prefix | Authentication | Purpose |
|---|---|---|---|
| `adminNodes` | `/api/admin/nodes` | `ADMIN_KEY` | fleet CRUD, config, tokens, sync, presets, maintenance, cert assignment |
| `adminUsers` | `/api/admin/users` | `ADMIN_KEY` | users, per-node access, subscription tokens, share links |
| `adminCerts` | `/api/admin/cert-domains`, `/api/admin/zones` | `ADMIN_KEY` | cert domains, test issue, production issue, runs |
| `adminInboundLinks` | `/api/admin/nodes/{id}/inbound-links` | `ADMIN_KEY` | link variants |
| `adminReality` | `/api/admin/nodes/{id}/reality-keys` | `ADMIN_KEY` | inspect/rotate REALITY keys |
| `nodeApi` | `/api/node/*` | node token | enroll, heartbeat, config, certs, report, action, stats |
| `subRouter` | `/sub/:token` | subscription token | base64 URI list or mihomo profile |
| `health` | `/api/health` | none | constant liveness body |

Routers translate HTTP to service calls; services hold rules; `src/db.ts` is
the only module that speaks SQL. `src/cert/` is a self-contained ACME
subsystem with its own D1 and R2 access modules.

### Rendering pipeline

The stored document is the **authored config**: the admin's JSON, with
registered endpoint identities resolved to current tags. Rendering a node's
runtime config (`src/services/render_service.ts`) is:

1. Load the registry (`node_inbounds`, `node_outbounds`, `inbound_links`)
   from the authored config (`src/services/registry_service.ts`). New tags get
   stable ids; a rebind keeps access, keys, and variants attached.
2. Project each `user_node_access` row into the pure core's user shape,
   resolving registered ids to tags.
3. Qualify tags per node (`src/services/qualify_service.ts`): inbounds and
   outbounds become `<node>-<tag>`; `BLOCK` stays unqualified and is forced to
   be the first outbound.
4. Generate or load REALITY keys per inbound (`ensureKeys`), sealing private
   keys with `KEY_SECRET`.
5. Run the pure `buildConfig` core: inject per-user VLESS clients, UUIDs
   keyed by `username@outbound`, and routing rules that send each entitled
   user's traffic to its selected exits.
6. Canonicalize the result (`src/core/python_json.ts`) and hash it. The hash
   is the node's `desired_hash`; `applied_hash` is what the node reports.

The authored config never enters the runtime document verbatim: templating,
per-user client injection, key injection, and tag qualification all happen at
render time. Saving a config therefore changes the desired hash without
rewriting user rows.

Share links are rendered on read from the same registry and the node's
admin-set `address` (`src/services/share_service.ts`,
`src/services/link_service.ts`). Subscription bodies use the same link list as
the admin UI, so the two presentations cannot disagree.

### Subscriptions

`src/services/subscription_service.ts` resolves the token to an entitled user,
aggregates links, and chooses a format:

- default: base64 of the newline-joined VLESS URI list;
- Clash family (`clash`, `mihomo`, `stash` user agents) or `?target=clash`:
  a mihomo profile with one `vless` proxy per link, one `select` group, and
  `MATCH,LESSV`;
- `?target=uri` forces the URI list.

Every failure (unknown, disabled, expired, nothing configured) is an empty
200 body. The response is `Cache-Control: no-store`.

## Data model

D1 is the only database. Migrations are append-only under `migrations/` and
declare no foreign keys by convention; deletion order is explicit in
`src/db.ts` and `src/cert/store/d1.ts`.

| Table | Scope | Purpose |
|---|---|---|
| `nodes` | plane | identity, authored config, token hash, applied/desired state, versions, nginx/cert status, cert environment |
| `users` | plane | account, status, expiry, note, subscription token |
| `user_node_access` | (user, node) | allowed inbound/outbound ids, per-outbound UUIDs |
| `reality_keys` | (node, inbound id) | sealed REALITY private keys |
| `node_inbounds`, `node_outbounds` | (node, id) | stable endpoint registry; current tag and label |
| `inbound_links` | (node, id) | client-side link variants (CDN front, port, SNI overrides) |
| `node_actions` | (node, action) | pending/ok/failed maintenance requests |
| `cert_domains` | plane | certificate names, zone, profile, renewal policy |
| `certificates` | domain | issued artifacts, environment, serial/fingerprint, R2 prefix, current flag |
| `acme_accounts` | environment | one ACME account per staging/production, sealed key |
| `issue_runs` | domain | workflow run, phase, error, timing |
| `challenge_records` | run | DNS-01 TXT records created and cleaned up |
| `node_cert_domains` | (node, domain) | assignment; which domains a node pulls |

The certificate subsystem keeps two independent `current` pointers per domain
(production and staging); `nodes.cert_environment` selects which one
`GET /api/node/certs` serves. Assignment is per node; renewal follows the
assignment automatically.

## Certificate subsystem

`src/cert/` owns ACME end to end:

- `client.ts`, `jws.ts`, `crypto/` implement the ACME client with WebCrypto.
- `dns/cloudflare.ts` creates and deletes `_acme-challenge` TXT records using
  `CF_DNS_API_TOKEN` (Zone.DNS Edit + Zone.Zone Read).
- `issue/workflow.ts` is the Cloudflare Workflow (`CertificateWorkflow`,
  binding `ISSUANCE`). Each step persists a phase; failures keep the raw
  Let's Encrypt error in `issue_runs.error`.
- `issue/cron.ts` runs daily at 03:17 UTC and renews production certificates
  whose remaining lifetime is under one third (45-day `tlsserver` profile, so
  around day 15). Staging certificates are never renewed and are swept seven
  days after issuance.
- `store/r2.ts` stores certificate artifacts under a content-addressed prefix;
  D1 stores metadata and the current pointer. The node pulls a manifest with
  an ETag, validates fingerprints and safe domain paths, writes each version
  into its own directory, and swaps `current` atomically.

Issuance is serialized per domain by an active-run unique index. The
`_acme-challenge` TXT names collide across environments, so one run per domain
is enough; a staging test never flips the production pointer.

## Node agent

`node/` is a Rust crate with two commands:

- `lessv-node enroll --cp <url> --node <id>` writes `/etc/lessv/node.toml`
  (0600) from the token on stdin and first-contacts the plane.
- `lessv-node run --config /etc/lessv/node.toml` is the daemon.

The daemon (`src/reconcile.rs`) loop:

1. Heartbeat every 30 s with the applied hash, versions, health, and nginx
   state; receive `desired_hash` and pending actions.
2. If the hash differs (or the last apply failed), `GET /api/node/config`,
   validate, test with `xray run -test`, write atomically, restart Xray, and
   report success/failure.
3. Poll `GET /api/node/certs`; validate the manifest, write content-addressed
   certificate versions, swap `current` symlinks, render the nginx decoy
   config, run `nginx -t`, reload nginx.
4. Execute maintenance actions (`update_xray`, `update_geodata`) and report
   through `POST /api/node/action`.
5. Back off exponentially (5 s to 300 s, with jitter) when the plane is
   unreachable.

State lives in `/var/lib/lessv/state.json`; the live Xray config is
`/var/lib/lessv/config.json`; certificates are under `/etc/lessv/certs/`;
geodata is under `/var/lib/lessv/assets/`. The agent never accepts a remote
shell and never edits `/etc/lessv/node.toml` after enrollment.

Startup repairs from the last-known-good config: no bad config survives a
`kill -9` or a host reboot. nginx never owns 443; Xray owns 443 and relays
non-REALITY handshakes to the decoy's Unix socket, so the decoy's TLS
certificate is the one clients see.

## Failure model

- **Plane unavailable:** nodes keep serving their current config and retry
  with backoff. Subscriptions and admin UI are unavailable.
- **Bad config:** the node validates and tests before swapping; a failed
  apply restores the previous live config and reports `last_error`.
- **Bad certificate manifest:** validation aborts the whole sync, the old
  `current` pointer stays, and the node does not advance its ETag.
- **nginx rejects the decoy:** the node rolls back the decoy config and
  reports `nginx_ok=0` with the `nginx -t` output.
- **Node lost:** the plane keeps the last known state. Deleting the node row
  revokes its token and removes node-scoped data; the machine keeps running
  its last applied config and must be decommissioned separately.

## Invariants

- `ADMIN_KEY` is root-equivalent for the plane.
- `KEY_SECRET` is never rotated. It seals stored REALITY, certificate, and
  ACME account keys; rotating it makes them unreadable.
- The protocol version is pinned in `docs/PROTOCOL.md`,
  `src/routers/node.ts`, and `node/Cargo.toml`, and frozen by
  `tests/pure/protocol_freeze.test.ts`.
- The blackhole outbound tag is uppercase `BLOCK`; it is never assignable to
  a user.
- The decoy is PQ-only (`X25519MLKEM768:X25519`) with no classical fallback;
  hosts whose nginx links OpenSSL < 3.5 are rejected at install and at apply.
- `workers_dev` and preview URLs stay disabled; the custom domain is the only
  public hostname.
