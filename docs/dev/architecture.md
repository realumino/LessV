# Architecture

Vela is a self-hosted Xray management plane. One Cloudflare Worker serves the
admin SPA, the admin API, the server pull API, and subscription URLs. Each node
runs `vela-server`, a container image that pulls its desired state from the
plane and converges Xray, nginx, and certificates inside the container.

This document describes the system as implemented. Protocol details live in
[`docs/PROTOCOL.md`](../PROTOCOL.md); certificate and nginx operations live in
[`docs/OPERATIONS.md`](../OPERATIONS.md); operator procedures live in the
top-level `README.md`.

## Design constraints

- **Pull only.** The plane never connects to a node. A node polls the plane;
  the plane being unavailable costs staleness, not access.
- **One deployable unit.** Worker, SPA, D1 schema, and Workflow ship
  together from this repository.
- **The plane never ships the node's software.** The server is an image built
  and tested in its own repository; Xray, nginx and the reconciler are inside
  it. The plane owns the contract and the data, not the host.
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
                                    D1 (state + certificate artifacts)
                                    Workflow (ACME issuance)

User ── /sub/{token} ──► subscription ──► links (rendered from D1)

Node ── Xray (REALITY :443) ──► vela-server (container image)
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
  200 body, and the three answers are asserted byte-identical — a stale holder
  must not learn that the token is merely dead rather than never minted.
- Static assets are matched before the Worker. The built SPA lives under
  `/admin/**`; every path that misses an asset and looks like a navigation is
  answered with the assets root `index.html`, which `frontend/vite.config.ts`
  writes from `frontend/spa-fallback.html`. That document is deliberately
  inert: empty title, no product name, no bundle reference. It fetches the
  real shell (`/admin/`) only when `location.pathname` is inside the mount,
  which is what keeps `/admin` deep links refreshable without handing a panel
  to the site root, a mistyped path, or a subscription URL opened in a
  browser. The SPA repeats the rule in `main.tsx` (`isAdminMount`), so the
  shell cannot paint itself outside `/admin` even when it is loaded directly.
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
subsystem with its own D1 access module.

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

A link's readable name is derived, never stored: a per-combination literal
(`link_names`) wins, then the stored format (`plane_settings.link_name_template`),
then the built-in `{node} · {subject} → {outbound}`, then
`<inbound> → <outbound>` as the last resort. The naming page and the link /
subscription renderers run the same `linkNameFields` / `resolveLinkName` pair,
so what the admin sees is what the client imports; a rename never enters the
runtime config.

### Subscriptions

`src/services/subscription_service.ts` resolves the token to an entitled user,
aggregates links, and chooses a format:

- default: base64 of the newline-joined VLESS URI list;
- Clash family (`clash`, `mihomo`, `stash` user agents) or `?target=clash`:
  a mihomo profile with one `vless` proxy per link, one `select` group, and
  `MATCH,VELA`;
- `?target=uri` forces the URI list.

Every failure (unknown, disabled, expired, nothing configured) is an empty
200 body. The response is `Cache-Control: no-store`.

An entitled response may also carry `profile-title: base64:<utf8>`, resolved
from `plane_settings.subscription_title_template` with `{username}` and
`{status}`. The header is absent when the format is empty, so a plane that
never sets it keeps byte-identical responses. An unentitled token gets neither
the body nor the title, which is what makes the four failure states
indistinguishable.

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
| `certificate_artifacts` | certificate id | the three leaf PEMs and the sealed leaf private key |
| `certificates` | domain | environment, serial/fingerprint, SANs, validity, current flag |
| `acme_accounts` | environment | one ACME account per staging/production, sealed key |
| `issue_runs` | domain | workflow run, phase, error, timing |
| `challenge_records` | run | DNS-01 TXT records created and cleaned up |
| `node_cert_domains` | (node, domain) | assignment; which domains a node pulls |

The certificate subsystem keeps two independent `current` pointers per domain
(production and staging); `nodes.cert_environment` selects which one
`GET /api/node/certs` serves. Assignment is per node; renewal follows the
assignment automatically. Artifacts are rows in `certificate_artifacts`
(one per certificate id, deleted on purge), so the database is the only store
the subsystem reads.

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
- `store/d1.ts` also stores the artifacts: the three PEMs and the sealed
  leaf private key live in `certificate_artifacts`, keyed by certificate id.
  The sealed key is written before the order runs, because a retried workflow
  has to find the key it already generated; the PEMs are filled in when the
  order becomes valid, and the row is deleted when the certificate is purged.
  A certificate set is a few kilobytes, three orders of magnitude inside D1's
  row limit, and one store cannot disagree with itself about which certificate
  is current. The server pulls a manifest with an ETag, validates fingerprints
  and safe domain paths, writes each version into its own directory, and swaps
  `current` atomically.

Issuance is serialized per domain by an active-run unique index. The
`_acme-challenge` TXT names collide across environments, so one run per domain
is enough; a staging test never flips the production pointer.

## The server

The node-side software is a separate repository
([LessV-Node](https://github.com/realumino/LessV-Node)); what this tree owns is
the contract in [`docs/PROTOCOL.md`](../PROTOCOL.md). A server satisfies the
plane if it:

1. speaks protocol 3 and identifies itself with the `X-Lessv-Node` header on
   every `/api/node/*` call;
2. heartbeats the applied config hash, then fetches, validates and tests
   `GET /api/node/config` before swapping the live file, and reports through
   `POST /api/node/report`;
3. polls `GET /api/node/certs`, writes the content-addressed tree under
   `/etc/vela/certs/<domain path>/<fingerprint>/` (`fullchain.pem` 0644,
   `privkey.pem` 0600) and swaps `current` atomically;
4. renders the nginx decoy and reaches it through the Unix socket the plane
   renders as REALITY `dest`, `/dev/shm/lessv-decoy.sock`;
5. executes advertised actions and answers through `POST /api/node/action`.

The image is the delivery vehicle, and it has one operator-facing requirement:
publish port 80 and port 443/tcp and nothing else needs exposing. Inside, the
server owns Xray on 443 and nginx on the decoy's Unix socket, and it keeps its
two directories as volumes (`/etc/vela` for identity and certificates,
`/var/lib/vela` for state, the live config and geodata). How the process is
supervised — s6 in the image, systemd or OpenRC outside it, a bare binary on a
developer machine — is invisible to the plane. The plane never connects to a
node: every call is server-initiated, so a node behind NAT needs no inbound
port except the two it serves traffic on.

A server is upgraded by replacing its image. The plane cannot and does not
update Xray, nginx or the reconciler on a running host.

## Reported addresses

`reported_address` is display data: the fleet view's answer to "where is this
node". The plane prefers the server's `detected_ip` only when it is a globally
routable IP literal, and otherwise falls back to `cf-connecting-ip`. A
container reports its bridge address and a NATed host can report a private one;
neither is a fact about how the node is reached, while the edge header is.
Nothing else reads the field.

## Secrets

`KEY_SECRET` is a Worker secret, not a Secrets Store binding. The store is an
account-level resource whose id every deployment — including a second,
staging one — would have to carry, its value is read through an async hop on
the hottest crypto path (render, delivery, issuance, admin download), and its
only real benefit is rotation across Workers. `KEY_SECRET` is never rotated by
design; it seals REALITY, certificate and ACME account keys, and rotating it
makes every sealed value unreadable. Revisit only if a second Workers-side
consumer of the same secret appears.

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
- The protocol version is pinned in `docs/PROTOCOL.md` and
  `src/routers/node.ts`, and frozen by `tests/pure/protocol_freeze.test.ts`;
  the server repo carries the matching crate version.
- The blackhole outbound tag is uppercase `BLOCK`; it is never assignable to
  a user.
- The decoy is PQ-only (`X25519MLKEM768:X25519`) with no classical fallback;
  hosts whose nginx links OpenSSL < 3.5 are rejected at install and at apply.
- `workers_dev` and preview URLs stay disabled; the custom domain is the only
  public hostname.
