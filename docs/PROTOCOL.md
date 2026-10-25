# Cloud API — pull contract v2

The agent ↔ plane contract. Protocol 1 was the P0/P1a pull contract
(`X-Lesserv-Node`); protocol 2 (P1b) adds the certificate endpoint, the
`stage: "cert"` report, and renames the node-identity header to
`X-Lessv-Node`. There are no deployed protocol-1 agents to stay compatible
with; after deploying this plane, upgrade every node's agent to 0.2.1.

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
- Every response is JSON with the error envelope `{ "detail": <string> }` on
  failure (4xx/5xx). Success bodies are the objects below.

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

Request: `{ "protocol": 2, "status": "ok" | "drift" | "error" }`.

Response: `{ "desired_hash": <hex|null>, "actions": [] }` — `actions` is
reserved (always empty in v1/v2 pull mode).

### `GET /api/node/config?hash=<heartbeat's value>`

The full rendered runtime config, byte-for-byte what the node runs.

- `hash` omitted → current body.
- `hash` stale (the desired config moved since) → `409` with
  `{ "message": "desired config moved; re-heartbeat", "desired_hash": "..." }`;
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

Records one apply attempt; failures keep the old issued hash. Duplicate
reports are safe.

Base request:

```json
{ "protocol": 2, "applied_hash": "...", "health": "ok", "last_error": null }
```

The P1b additions ride on this object:

```json
{
  "stage": "cert",
  "nginx_ok": true,
  "nginx_error": null,
  "cert_etag": "\"0dfcf51c...\"",
  "cert_synced_at": 1792937643
}
```

- `stage: "cert"` is the discriminator: the agent reports it when the Xray
  config did NOT change but the certificate/nginx state changed (for
  example an nginx process-state flip). The plane updates `last_seen` and
  the cert columns only — never `applied_hash`, `health`, or `last_error`
  — because only a real apply may move those.
- Ordinary apply reports may also carry the cert fields; the server writes
  them all.
- Absent cert fields stay untouched on a plain report; a `stage:"cert"`
  report writes every cert field it carries, NULLs included when the agent
  state has nothing to repeat yet. From agent 0.2.1 the agent stops
  nulling `cert_synced_at` after the first successful adoption: nginx
  state reports and failure reports repeat the last successful epoch, so
  an nginx stop/start cycle or a renewal failure never clears
  `nodes.cert_synced_at`.

### `POST /api/node/stats`

Accepted and validated (absolute counters + boot id); storage starts in a
later milestone, so nothing is stored yet. The agent ships this shape from
v1 so history can begin the day the plane learns to keep it.

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
