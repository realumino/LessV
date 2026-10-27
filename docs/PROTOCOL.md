# Cloud API — pull contract v2

The agent ↔ plane contract. Protocol 1 was the P0/P1a pull contract
(`X-Lesserv-Node`); protocol 2 (P1b) adds the certificate endpoint, the
`stage: "cert"` report, and renames the node-identity header to
`X-Lessv-Node`. There are no deployed protocol-1 agents to stay compatible
with; every agent in this repository has spoken protocol 2 since 0.2.1.

Changes are made in three places at once: this file, `src/routers/node.ts`
(`PROTOCOL_VERSION`), and `agent/lessv_agent/__init__.py`.

## Transport and authentication

- Base URL: the control plane's HTTPS origin (e.g. `https://cp.example.com`).
- All agent endpoints are under `/api/node/*`.
- Every request carries two headers:
  - `Authorization: Bearer <node token>` — the token minted by the admin and
    stored in `agent.toml` (0600). The server keeps only a hash.
  - `X-Lessv-Node: <node id>` — selects the row the token must prove. A
    missing header, unknown id, never-minted token, and wrong token all
    answer the same `401 {"detail":"invalid node credentials"}`; nothing
    about the attempt is logged.
- Every write request body carries `"protocol": 2`; anything else answers
  `400 {"detail":"unsupported protocol N"}`. The agent's correct response is
  to keep serving its current config.
- Every response is JSON. Failures (4xx/5xx) use the error envelope
  `{ "detail": <string | object | array> }` — see [Error shape](#error-shape).
  Success bodies are the objects below.

## Endpoints

### `POST /api/node/enroll`

First contact; idempotent (re-running after editing `agent.toml` is the
recovery action).

Request:

```json
{
  "protocol": 2,
  "agent_version": "0.2.1",
  "xray_version": "26.10.21",
  "detected_ip": "203.0.113.7",
  "platform": "Linux-6.1-x86_64"
}
```

`detected_ip` is display data for the fleet view (who reported in from
where); it never feeds share links.

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
  "protocol": 2,
  "applied_hash": "<sha-256 hex>",
  "applied_at": 1792937643,
  "xray_running": true,
  "xray_pid": 4242,
  "agent_uptime": 3600,
  "last_error": null
}
```

Response: `{ "desired_hash": <hex|null>, "actions": [] }`.

- The plane persists `applied_hash` from the heartbeat at face value when it
  changes (it is the agent's local truth), and never writes `health` or
  `last_error` from a heartbeat. ALWAYS send `applied_hash`: omitting it
  sends `null` and clears the column. The agent always sends it.
- The request's `last_error` is accepted for forward compatibility but not
  stored; the plane keeps the error from the last report.
- The plane never emits actions today. The agent still honors
  `"restart_xray"` if one ever appears (restart Xray unchanged).
- A heartbeat never clears `last_error`; only an apply report does.

### `GET /api/node/config?hash=<heartbeat's value>`

The full rendered runtime config, byte-for-byte what the node runs.

- `hash` omitted → current body.
- `hash` stale →
  `409 {"detail":{"message":"desired config moved; re-heartbeat","desired_hash":"..."}}`;
  the agent must NOT serve stale bytes as if applied — it re-heartbeats.
- No renderable config → `404 {"detail":"no renderable config"}`.
- `Cache-Control: no-store` always: the body carries every UUID plus the
  REALITY private key.

Response:

```json
{ "hash": "<sha-256 hex>", "config": { "inbounds": [...], "outbounds": [...], ... } }
```

### `GET /api/node/certs`

This node's **production** certificate manifest: assigned, active cert
domains whose current **production** certificates exist. Staging
("test issue") certificates never appear here, whatever the assignment.

- `Cache-Control: no-store` (the body carries private keys).
- `ETag: "<64-hex>"` — a composite hash over all assigned domains'
  `(domain, fingerprint)` pairs, sorted; any renewal or assignment change
  rotates it. Send `If-None-Match: "<64-hex>"` and the plane answers
  `304` with no body when nothing changed.
- Failure is all-or-nothing: an unreadable artifact answers `500` with the
  object path in the message, never a partial manifest. The agent keeps its
  previous files on any failure.

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
  "protocol": 2,
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
  becomes `error` (truncated to 500 chars by the agent). `applied_hash`
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
report writes every cert field it carries, NULLs included when the agent
state has nothing to repeat yet. From agent 0.2.1 the agent never clears
`cert_synced_at`: nginx state flips and cert failures repeat the last
successful epoch.

### `POST /api/node/stats`

Request:

```json
{ "protocol": 2, "boot_id": "<string>", "counters": { "<name>": <int> } }
```

Accepted and validated (absolute, non-negative counters + boot id);
storage starts in a later milestone, so nothing is stored yet. The agent
ships this shape from v1 so history can begin the day the plane learns to
keep it.

## Renewal contract (agent-visible behavior)

- The daily cron (03:17 UTC) renews production certificates whose age
  exceeds 1/3 of their actual lifetime (45-day LE `tlsserver` → renew at
  day 15; override with `cert_domains.renew_before_days`).
- A successful renewal writes a new current row and re-renders the node's
  desired hash; the agent's next `GET /api/node/certs` (new ETag) delivers
  the new files, `current` flips atomically, `nginx -t` + reload runs, and
  a `stage:"cert"` report follows. Xray is never restarted by this path.
- Renewal failures surface in the panel: `issue_runs` rows and the domain
  `last_error` (production only). The agent's on-disk files stay untouched.

## Error shape

Every 4xx/5xx body is `{ "detail": <string | object | array> }`:

- semantic failures → `{"detail":"node not found"}`;
- schema failures (`parseJsonBody`) → `422 {"detail":[{"msg":"..."}]}`;
- protocol mismatch → `400 {"detail":"unsupported protocol N"}`;
- stale config fetch → `409 {"detail":{"message":"...","desired_hash":"..."}}`;
- an unreadable certificate artifact → `500 {"detail":"<R2 object path>"}`,
  never a partial manifest.
