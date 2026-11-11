# Operations — certificates, nginx, node troubleshooting

Runbook for the product shape: Xray REALITY on 443 with self-steal over a
local Unix socket (`dest=/dev/shm/lessv-decoy.sock`), nginx serving the
decoy site with a Let's Encrypt certificate issued by the plane (DNS-01),
and nodes that pull their certificates from the plane.

## Topology

```
Internet ── :443 ──► Xray (REALITY, stream proxy)
                        │ realitySettings.dest = /dev/shm/lessv-decoy.sock
                        ▼
                     nginx (TLS, decoy site; also on 127.0.0.1:8443)
                        │ ssl_certificate = /etc/lessv/certs/<path>/current/fullchain.pem
                        ▼
                     certificate files ← lessv-node sync ← GET /api/node/certs
```

- 443 belongs to Xray. Never configure nginx to listen on 443.
- The stolen origin is local by construction: Xray and nginx share the host,
  so the handshake relay never leaves the kernel. `127.0.0.1:8443` remains as
  a compatibility listener for configs authored before the socket default;
  new configs should point `dest` at the socket.
- Certificates belong to nginx (the self-stealed origin); Xray has none.

## What the REALITY preset generates

The panel's REALITY preset button authors one inbound plus two outbounds:

- inbound `reality` (VLESS + REALITY, `dest=/dev/shm/lessv-decoy.sock`).
  `privateKey` stays empty; the plane injects/stores keys per inbound at
  render time (`ensureKeys`), so the private key never appears in the
  frontend. The socket path is the same contract as the generated decoy
  config (`nginx_socket` in `/etc/lessv/node.toml`, default
  `/dev/shm/lessv-decoy.sock`).
- outbounds `BLOCK` (blackhole) first, then `direct` (freedom). The plane
  guarantees `BLOCK` stays the first outbound and excludes it from routing
  allocation — it is the default route, not an exit. Every other outbound
  is rendered per node as `<node>-<tag>` (e.g. `tokyo01-direct`).
- On the user authorization page select `direct` (and any exits the admin
  added by editing the JSON). `BLOCK` is never offered: it is the fallback
  route for unmatched traffic, and the plane now rejects an access payload
  that names it (422). Every registered endpoint shows up on the node's
  Links tab, where its name can be changed and extra link variants added.

## Certificate lifecycle (plane)

1. **Admin UI → Certificates page** (`/certs`): pick a zone (from
   `GET /api/admin/zones`, backed by `CF_DNS_API_TOKEN`), add a cert domain
   (`example.com`, `*.example.com`, or `vpn.example.com`). `include
   wildcard` adds a `*.<name>` SAN alongside `<name>`; a wildcard-only
   row starts with `*.` and issues just the wildcard.
2. **Test issue** (`POST /api/admin/cert-domains/:id/test-issue`) runs the full
   ACME flow against the Let's Encrypt **staging** directory and flips only
   the staging current pointer. Production stays untouched. Use it to
   validate DNS reachability before spending production rate limits.
3. **Issue** (`POST /api/admin/cert-domains/:id/issue`, body
   `{"confirm":"<exact domain>"}`) issues a **production** certificate.
   Rate limits apply (5 duplicates/week per name) — do not retry in a loop.
4. **Assignment** (node page → Certs tab, `PUT
   /api/admin/nodes/:id/cert-domains` with `{"domain_ids":[...]}`) decides
   which cert domains a node receives. Assignments act on the
   certificate **domain**, so renewals flow automatically.
5. **Environment** (node page → Certs tab, or `PUT /api/admin/nodes/:id`
   with `{"cert_environment":"staging"|"production"}`, default
   `production`) decides *which* current certificate of each assigned
   domain the node pulls: the production current pointer or the staging
   one. Same assignment, one pointer per environment — switching back and
   forth needs no re-assignment, and an update that does not name the field
   leaves it alone.
   - **Staging certificates are test-only.** They are signed by an
     untrusted root: browsers and normal clients reject them, so any test
     client must be told to trust the Let's Encrypt staging root
     explicitly. A staging node whose domain has no current staging
     certificate receives an empty manifest, not the production bytes, so
     the fail-safe is "serve nothing", never "serve the wrong
     environment".
   - Staging certificates are never renewed and are swept 7 days after
     issuance; after that the staging manifest for those domains is empty,
     so switch the node back to `production` when the test is over.
6. **Renewal**: the daily cron (`17 3 * * *` UTC) renews production
   certificates older than 1/3 of their lifetime (45 days → day 15), with a
   per-run jitter and idempotent date-range locking. Staging certificates
   are never renewed and are swept after 7 days.

Every issuance records an `issue_runs` row with phases
(`load` → `ensure-account` → `new-order-<n>` → `publish-txt-<n>` →
`wait-propagation-<n>` → `accept-challenges-<n>` → `await-authz-<n>` →
`key+csr` → `finalize+store` → `purge-previous` → `cleanup-txt` →
`finish-run`; `<n>` is the attempt number, an expired order reopens via
`order-expired-<n>`, and a failed run adds `cleanup-failed-artifacts`);
failures keep the raw Let's Encrypt error text in `error` — that is the
first place to look.

## Node delivery layout (lessv-node)

```
/etc/lessv/certs/<domain path>/
├── <fingerprint sha256>/        # one directory per certificate version
│   ├── fullchain.pem            # 0644
│   └── privkey.pem              # 0600 (0600/0640+cert_group when set)
└── current -> <fingerprint>/    # symlink, swapped atomically
```

- The node validates the manifest (ETag + fingerprint shape + safe
  domain paths) before writing; any invalid entry aborts the whole sync.
- Files are written straight into the content-addressed version directory
  (`<fingerprint>/`, so re-syncing the same certificate is idempotent and a
  crashed write leaves the old version intact); `current` then swaps via a
  temp symlink + rename — readers never see a missing or half-updated
  pointer, and a `current` that is a real directory is refused instead of
  overwritten.
- On any write/test/reload failure the node rolls the symlinks back to
  the previous state and does NOT advance its stored ETag; the next loop
  retries.
- The node also writes the decoy nginx configuration (next section) and
  restarts nginx when it is found stopped, on every poll.

## nginx decoy configuration (generated by lessv-node)

`install.sh` removes the distribution's default site and writes nothing
else; the node renders one file from the certificate manifest:

- Debian/Ubuntu/RHEL: `/etc/nginx/conf.d/lessv-decoy.conf`
- Alpine: `/etc/nginx/http.d/lessv-decoy.conf`

One `server` block per assigned certificate, the first one carrying
`default_server` so an unmatched SNI still gets a certificate:

```nginx
# Managed by lessv-node. Regenerated from GET /api/node/certs on every sync;
# edits are overwritten. Xray owns 443 — this decoy listens on a Unix socket
# (REALITY's dest) and on loopback for pre-socket authored configs.

server {
    listen unix:/dev/shm/lessv-decoy.sock ssl default_server;
    listen 127.0.0.1:8443 ssl;
    server_name <domain>;

    ssl_certificate     /etc/lessv/certs/<path>/current/fullchain.pem;
    ssl_certificate_key /etc/lessv/certs/<path>/current/privkey.pem;
    ssl_protocols       TLSv1.3;
    ssl_ecdh_curve      X25519MLKEM768:X25519;

    root  /var/www/lessv-decoy;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

- **Post-quantum, without a fallback.** `ssl_ecdh_curve
  X25519MLKEM768:X25519` makes a TLS 1.3 handshake prefer the ML-KEM-768 +
  X25519 hybrid and fall back to X25519 for clients that do not offer it.
  The linked TLS library resolves the group at `nginx -t` time: OpenSSL ≥ 3.5
  (Debian 13, Ubuntu 25.04, Alpine 3.22, current nginx images) knows it;
  older hosts reject the whole file. There is **no classical-only render**:
  the apply fails, the previous nginx config is restored, and the node reports
  `nginx_ok: false` with the `nginx -t` output. `install.sh` refuses to
  install on a host whose nginx links an older OpenSSL.
- **Local socket, not a port.** The decoy's primary listener is
  `/dev/shm/lessv-decoy.sock`; REALITY relays every handshake there, so the
  stolen origin never touches the network stack. The loopback listener
  exists for configs authored before the socket default and can be removed
  once every node's `dest` names the socket.
- `nginx_socket` in `/etc/lessv/node.toml` moves the socket (absolute path;
  keep the preset's `dest` in sync). Both services run as root here, so the
  socket's default ownership is enough; with a non-root Xray, set
  `user=`/`group=` on the `listen` line instead.
- `xray.service` starts after `nginx.service` (`after nginx` + `want nginx`
  under OpenRC) because the socket must exist before the first handshake;
  `install.sh` enables nginx so it comes up at boot.
- Wildcard certificates use `wildcard.<zone>` as the `path` and the wildcard
  name as `server_name`.
- The file references `current`, so certificate renewals need no nginx config
  change — the reload after each sync picks the new bytes.
- `cert_group` is only needed when nginx does not run as root; Debian's
  master runs as root, so `0600` alone is fine.
- Never configure nginx to listen on 443: REALITY owns that port.

### Trusting the staging root

A node on `cert_environment: staging` serves the Let's Encrypt staging
chain. REALITY clients do not need the CA (they validate the REALITY
handshake, not the decoy site chain), but browsers and `curl` do. Install
the staging root into the test client's trust store:

```sh
curl -fsSL -o /usr/local/share/ca-certificates/le-staging-root-x1.crt   https://letsencrypt.org/certs/staging/letsencrypt-stg-root-x1.pem
update-ca-certificates
```

Alpine: `apk add ca-certificates` and put the PEM in
`/etc/ssl/certs/` after `update-ca-certificates` (or use `-k` for a
one-off check).

## Routine operations

```bash
# issue / re-issue (forced renewal) for a domain
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"confirm":"<domain>"}' https://<cp>/api/admin/cert-domains/<id>/issue

# watch an issuance
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/cert-domains/<id>/runs

# certificate state the node reports (admin view)
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/nodes/<id>/certs
```

Node side (systemd, then OpenRC equivalents):

```bash
systemctl status lessv-node
journalctl -u lessv-node -n 100 --no-pager
# Alpine/OpenRC:
#   rc-service lessv-node status
#   tail -n 100 /var/log/lessv-node.log
ls -l /etc/lessv/certs/<path>/          # versions
readlink -f /etc/lessv/certs/<path>/current
nginx -t && systemctl reload nginx      # rc-service nginx reload on Alpine
```

## Troubleshooting playbook (in order)

1. **Panel: Certificates page → domain → Runs.** The LE error is verbatim
   (`caa`, `rateLimited`, `dns problem`, expired order...). Phase tells you
   where it died.
2. **Panel: node sync** (`GET /api/admin/nodes/<id>/sync`): `nginx_ok`,
   `nginx_error`, and certificate lint warnings (`serverNames ... is not
   covered by an assigned certificate`, `dest ... is not a local Unix socket
   or 127.0.0.1:<port>`, invalid `shortIds`).
3. **Node**: `journalctl -u lessv-node -n 100` (OpenRC:
   `tail -n 100 /var/log/lessv-node.log`); `ls -l /etc/lessv/certs/<path>/`;
   `readlink -f .../current`. The node's state file
   (`/var/lib/lessv/state.json`) carries `cert_etag`, `cert_synced_at`,
   `last_nginx_ok`, and `certs` (the certificate set the decoy config was
   rendered from; used to notice that a renderer upgrade made the generated
   file stale).
4. **nginx**: `nginx -t`; `systemctl status nginx` (`rc-service nginx status` on
   Alpine); `journalctl -u nginx -n 50` (`tail -n 50 /var/log/nginx/error.log`).
5. **HTTP checks**: `curl -v https://<domain>` (must validate without
   `-k`); `openssl s_client -connect <host>:443 -servername <domain>`.
6. **Xray**: `systemctl status xray` (`rc-service xray status`); `xray run
   -test -c /var/lib/lessv/config.json`; `journalctl -u xray -n 30`
   (`tail -n 30 /var/log/xray.log`). Cert issuance and nginx reload must never
   restart Xray (`systemctl show xray -p MainPID` stays constant).
7. **Artifacts missing**: check R2 under `certs/<env>/<path>/<cert id>/`
   (binding `CERTS`, bucket `lessv-certs`). Do not hand-edit `current` —
   `lessv-node` reconciles it; a manual pointer will be overwritten or rolled
   back on the next sync.

### Failure cookbook

| Symptom | Meaning | First fix |
|---|---|---|
| `wait-propagation` loops then fails | TXT record not visible to DoH resolvers | check the `_acme-challenge` TXT in the Cloudflare dashboard; check the DNS token's zone scope |
| LE CAA error on a name | a CAA record forbids issuance | fix/remove the CAA record (`0 issue "none"` blocks everything) |
| `too many certificates already issued` | production rate limit | wait; use staging for any further testing |
| panel warning `nginx is not healthy: nginx unit is not active` | nginx stopped/crashed — the text after the colon is the node's `nginx_error` field | the node restarts nginx on its next poll; if it stays down, `systemctl start nginx` / `rc-service nginx start` and read the node log |
| `nginx -t rejected the decoy (post-quantum X25519MLKEM768:X25519 requires OpenSSL >= 3.5): SSL_CTX_set1_curves_list(...) failed` | the host's TLS library cannot negotiate the hybrid group; the node refuses to serve classical-only TLS and restored the previous decoy config | move the node to Debian 13+/Ubuntu 25.04+/Alpine 3.22+ (or build nginx against OpenSSL ≥ 3.5). There is no fallback to enable |
| node reports cert failure, files unchanged | artifact read/validate failed | check the object path from the error; do not edit files by hand |
| renewed cert never appears on the node | assignment changed or ETag stuck | re-check assignment; compare `nodes.cert_etag` (the node's adopted ETag) with the manifest ETag from `GET /api/node/certs` — equal means the node already has this version |

## Tearing down a provisioned node VPS

When a VPS is no longer needed: `node scripts/linode_provision.mjs delete
--token-file <token-file> --label <label> [--tag <tag>]` (same tag as
create; pass the same `--out` to strike the instance from the inventory).
The plane has no
node-delete API; leave the node row as history, or clean it with a
deliberate D1 statement (and `node_cert_domains`) if you accept losing
that evidence. The plane keeps domain/cert records; soft-deleted cert
domains disappear from the UI but their history stays in the database.
