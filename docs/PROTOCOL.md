# Vela ↔ vela-server — pull contract v3

The server ↔ plane contract. Protocol 1 was the original pull contract
(`X-Lesserv-Node`); protocol 2 added the certificate endpoint, the
`stage: "cert"` report, and renamed the server-identity header to
`X-Lessv-Node`; protocol 3 replaces the heartbeat's string actions with
structured objects, adds version reporting on the heartbeat, and adds the
action-result endpoint.

The identity header is `X-Vela-Server`. It names the node row a token must
prove, not a product, and it is the only header the plane requires. A server
built before the rename sends `X-Lessv-Node`; the plane still reads it, so a
plane upgrade does not lock an older build out.

The server is maintained in
[LessV-Node](https://github.com/realumino/LessV-Node); the plane's code is
this repository. Changes to the number are made in three places at once: this
file, `PROTOCOL_VERSION` in `src/routers/node.ts`, and the crate version in
the server repository. A protocol-2 server is rejected with `400` and keeps
serving its current config until it is upgraded.

The wire field names `agent_version` and `agent_uptime` predate every rename
the artifact has had; they stay for the same reason as the header.

## Transport and authentication

- Base URL: the control plane's HTTPS origin (e.g. `https://cp.example.com`).
- All node endpoints are under `/api/node/*`.
- Every request carries two headers:
  - `Authorization: Bearer <node token>` — the token minted by the admin and
    stored in `node.toml` (0600). The server keeps only a hash.
  - `X-Vela-Server: <node id>` — selects the row the token must prove; the
    old `X-Lessv-Node` is accepted as an alias. A missing header, unknown id,
    never-minted token, and wrong token all
    answer the same `401 {"detail":"invalid node credentials"}`; nothing
    about the attempt is logged.
- Every write request body carries `"protocol": 3`; anything else answers
  `400 {"detail":"unsupported protocol N"}`. The node's correct response is
  to keep serving its current config.
- Every response is JSON. Failures (4xx/5xx) use the error envelope
  `{ "detail": <string | object | array> }` — see [Error shape](#error-shape).
  Success bodies are the objects below.

## Endpoints

### `POST /api/node/enroll`

First contact; idempotent (re-running after editing `node.toml` is the
recovery action).

Request:

```json
{
  "protocol": 3,
  "agent_version": "0.6.0",
  "xray_version": "26.11.9",
  "platform": "linux/x86_64"
}
```

`detected_ip` is retired. The plane neither stores nor displays it, and the
fleet view answers "when did this node last report" from the heartbeat's
`last_seen` stamp. A server that still sends the field is not rejected — it is
accepted and ignored — and a server that stops sending it loses nothing.

Response:

```json
{
  "id": "tokyo01",
  "label": "Tokyo 01",
  "address": "vpn.example.org",
  "state": "active",
  "desired_hash": "<sha-256 hex or null>"
}
```

### `POST /api/node/heartbeat`

The 30s poll: cheap hash comparison, rarely a write.

Request (every field but `protocol` is optional; a missing field means
"nothing to report", never a failure):

```json
{
  "protocol": 3,
  "applied_hash": "<sha-256 hex>",
  "applied_at": 1792937643,
  "xray_running": true,
  "xray_pid": 4242,
  "agent_uptime": 3600,
  "agent_version": "0.6.0",
  "xray_version": "26.11.9",
  "geodata_version": "20261110230135",
  "last_error": null
}
```

Response: `{ "desired_hash": <hex|null>, "actions": [...] }`.

- The plane persists `applied_hash` from the heartbeat at face value when it
  changes (it is the node's local truth), and never writes `health` or
  `last_error` from a heartbeat. ALWAYS send `applied_hash`: omitting it
  sends `null` and clears the column. The node always sends it.
- `agent_version`, `xray_version`, and `geodata_version` are the facts the
  server currently runs; a missing field means "nothing to report" and
  preserves the stored value. The plane shows them in the fleet view and
  stores a successful update's version without waiting for the next
  heartbeat.
- Fields a server may stop reporting: every heartbeat field except
  `applied_hash` is optional, and the plane's behaviour for each is "keep
  what is stored". The only coupling is the version check: a preset that
  needs a minimum core version warns only when `xray_version` is reported
  and too old. Unknown is not the same as old, and a permanent warning about
  a field a server no longer sends would outlive its reason.
- The request's `last_error` is accepted for forward compatibility but not
  stored; the plane keeps the error from the last report.
- `actions` carries every maintenance request the admin confirmed that is
  still `pending`. An action is an object:

  ```json
  {"action": "update_geodata"}
  ```

  `update_geodata` is the only action the plane requests. `update_xray` was
  withdrawn when Xray moved into the node image: a binary update is an image
  update now, so there is nothing for the plane to ask for. A result for it is
  still accepted (see `POST /api/node/action`) so a server that finishes a
  leftover row is not refused.
  A node must answer every action with `POST /api/node/action`, including
  failures. The plane only stops advertising an action when its result
  arrives; a result that never arrives leaves the action pending, so the
  node must make a repeated advertisement cheap (it compares the installed
  version before downloading again).
- A heartbeat never clears `last_error`; only an apply report does.

### `GET /api/node/config?hash=<heartbeat's value>`

The full rendered runtime config, byte-for-byte what the node runs.

- `hash` omitted → current body.
- `hash` stale →
  `409 {"detail":{"message":"desired config moved; re-heartbeat","desired_hash":"..."}}`;
  the node must NOT serve stale bytes as if applied — it re-heartbeats.
- No renderable config → `404 {"detail":"no renderable config"}`.
- `Cache-Control: no-store` always: the body carries every UUID plus the
  REALITY private key.

Response:

```json
{ "hash": "<sha-256 hex>", "config": { "inbounds": [...], "outbounds": [...], ... } }
```

### `GET /api/node/certs`

This node's certificate manifest: assigned, active cert domains whose
current certificate **in the node's own ACME environment** exists.

- The environment is the node's `cert_environment` column (`production`
  by default, `staging` when the admin selects it on the node's Certs
  tab, `PUT /api/admin/nodes/{id}` with `{"cert_environment":"staging"}`).
  Each cert domain has one current pointer per environment, so the same
  assignment serves production bytes to a production node and staging
  bytes to a staging node. The manifest shape is identical in both
  environments, so one contract covers both.
- A node never receives the other environment's certificate: a staging
  node whose domain has no current staging certificate gets an empty
  `certs` array, not the production one.
- Staging certificates are for testing only: clients do not trust the
  Let's Encrypt staging root, they are never renewed, and they are swept
  7 days after issuance (see `docs/OPERATIONS.md`).

- `Cache-Control: no-store` (the body carries private keys).
- `ETag: "<64-hex>"` — a composite hash over all assigned domains'
  `(domain, fingerprint)` pairs, sorted; any renewal or assignment change
  rotates it. Send `If-None-Match: "<64-hex>"` and the plane answers
  `304` with no body when nothing changed.
- Failure is all-or-nothing: a missing artifact answers `500` naming the
  certificate id and the missing field, never a partial manifest. The server
  keeps its previous files on any failure.

Response:

```json
{
  "etag": "\"0dfcf51c...\"",
  "certs": [
    {
      "domain": "tokyo01.example.com",
      "path": "tokyo01.example.com",
      "sans": ["tokyo01.example.com"],
      "serial": "06559c13...",
      "fingerprint_sha256": "337d80c8...",
      "not_before": "2026-10-25T13:17:53.000Z",
      "not_after": "2026-12-09T13:17:52.000Z",
      "profile": "tlsserver",
      "fullchain_pem": "-----BEGIN CERTIFICATE-----...",
      "private_key_pem": "-----BEGIN PRIVATE KEY-----..."
    }
  ]
}
```

Wildcard entries use `path: "wildcard.<zone>"` and `sans: ["<zone>", "*.<zone>"]`.

### `POST /api/node/report`

Records one apply attempt; failures keep the old applied hash. Duplicate
reports are safe.

Request (`hash` and `ok` are required):

```json
{
  "protocol": 3,
  "hash": "<sha-256 hex this report is about>",
  "ok": true,
  "stage": "applied",
  "error": null,
  "xray_exit_code": null
}
```

`stage` is one of `fetched`, `test`, `applied`, `started`,
`rolled_back`, `cert`.

- `ok: true` with `stage` `applied` or `started` → `nodes.applied_hash`
  becomes `hash`, `health` becomes `ok`, `last_error` becomes `null`.
- `ok: false` → `health` becomes `error:<stage>` and `last_error`
  becomes `error` (truncated to 500 chars by the node). `applied_hash`
  does not move.
- Any other stage with `ok: true` (e.g. `test`, `rolled_back`) leaves
  the liveness columns untouched.
- `stage: "cert"` leaves `applied_hash`, `health`, and `last_error`
  untouched in every case — only `last_seen` and the cert columns move.

Certificate fields ride on the same object and are written when present
on a plain report, or whenever `stage` is `cert`:

```json
{
  "stage": "cert",
  "nginx_ok": true,
  "nginx_error": null,
  "cert_etag": "\"0dfcf51c...\"",
  "cert_synced_at": 1792937643
}
```

Absent cert fields stay untouched on a plain report. A `stage:"cert"`
report writes every cert field it carries, NULLs included when the node
state has nothing to repeat yet. From server 0.3.0 the server never
clears `cert_synced_at`: nginx state flips and cert failures repeat the last
successful epoch.

`nginx_error` carries the failure reason only: a node whose nginx is serving
reports `nginx_ok: true` and `nginx_error: null`. There is no "healthy but
degraded" state — in particular, the decoy always offers the post-quantum
group, and a host whose TLS library cannot do so fails the decoy apply and
reports `nginx_ok: false`.

### `POST /api/node/action`

The result of one maintenance action. Idempotent: a result for an action the
plane no longer tracks is accepted and changes nothing.

Request (`action` is `update_geodata`; `update_xray` is accepted only as a
result for a row written before the plane stopped requesting it):

```json
{
  "protocol": 3,
  "action": "update_geodata",
  "ok": true,
  "version": "20261110230135",
  "error": null
}
```

- `ok: true` finishes the action as `ok` and stores `version` as
  `geodata_version` for `update_geodata`; a legacy `update_xray` result stores
  `xray_version` the same way.
- `ok: false` finishes it as `failed` with `error` as the message. The
  installed versions do not move: the node rolls back (or never swaps), so
  the previous value is still the truth.
- The action row is visible in `GET /api/admin/nodes/{id}/sync` under
  `actions`; a failed row stays visible until the admin requests the action
  again.
- `update_xray` is gone from the request list because the plane no longer
  owns the binary: Xray is part of the server image, and replacing it means
  replacing the image. The result stays accepted so a server that finishes a
  row written by an older plane is not refused.

### `POST /api/node/stats`

Request:

```json
{ "protocol": 3, "boot_id": "<string>", "counters": { "<name>": <int> } }
```

Accepted and validated (absolute, non-negative counters + boot id);
storage starts in a later milestone, so nothing is stored yet. The node
ships this shape from v1 so history can begin the day the plane learns to
keep it.

## The config the plane renders

The document is the operator's, with three additions the plane owns: the
client list and per-user routing rules, the REALITY private keys (generated
per inbound and sealed at rest), and the transport name. `tcp` is rendered as
`raw`; Xray renamed the transport and still accepts both, and `tcpSettings`
stays next to the renamed value. The decoy socket path
`/dev/shm/lessv-decoy.sock` is rendered as REALITY `dest` and is as frozen as
the identity header: the server creates its decoy there.

A server must treat the body as opaque: it validates and tests the document
before swapping, and never merges or rewrites it.

## Renewal contract (server-visible behavior)

- The daily cron (03:17 UTC) renews production certificates whose age
  exceeds 1/3 of their actual lifetime (45-day LE `tlsserver` → renew at
  day 15; override with `cert_domains.renew_before_days`).
- A successful renewal writes a new current row and re-renders the node's
  desired hash; the node's next `GET /api/node/certs` (new ETag) delivers
  the new files, `current` flips atomically, `nginx -t` + reload runs, and
  a `stage:"cert"` report follows. Xray is never restarted by this path.
- Renewal failures surface in the panel: `issue_runs` rows and the domain
  `last_error` (production only). The node's on-disk files stay untouched.

## Error shape

Every 4xx/5xx body is `{ "detail": <string | object | array> }`:

- semantic failures → `{"detail":"node not found"}`;
- schema failures (`parseJsonBody`) → `422 {"detail":[{"msg":"..."}]}`;
- protocol mismatch → `400 {"detail":"unsupported protocol N"}`;
- stale config fetch → `409 {"detail":{"message":"...","desired_hash":"..."}}`;
- an unreadable certificate artifact → `500`, naming the certificate id and
  the missing field, never a partial manifest.
