# Operations — certificates, nginx, node troubleshooting

Runbook for the product shape: Xray REALITY on 443 with self-steal over a
local Unix socket (`dest=/dev/shm/lessv-decoy.sock`), nginx serving the
decoy site with a Let's Encrypt certificate issued by the plane (DNS-01),
and nodes that pull their certificates from the plane.

## Topology

```
Internet ── :443 ──► Xray (REALITY, stream proxy)
                        │ realitySettings.dest = /dev/shm/lessv-decoy.sock
                        │ geoip:/geosite: ← /var/lib/lessv/assets/*.dat
                        ▼
                     nginx (TLS, decoy site; Unix socket only, :80 = 301)
                        │ ssl_certificate = /etc/lessv/certs/<path>/current/fullchain.pem
                        ▼
                     certificate files ← lessv-node sync ← GET /api/node/certs
```

- 443 belongs to Xray. Never configure nginx to listen on 443.
- The stolen origin is local by construction: Xray and nginx share the host,
  so the handshake relay never leaves the kernel. The decoy listens on the
  socket only (no TCP listener) and :80 answers a 301.
- Certificates belong to nginx (the self-stealed origin); Xray has none.
- GeoIP/GeoSite data belongs to lessv-node (`geodata_dir`, default
  `/var/lib/lessv/assets`; the Xray unit exports `XRAY_LOCATION_ASSET`).

## Presets and the base document (plane)

A preset is a fragment the plane merges into the document the admin holds;
it never saves. `GET /api/admin/nodes/{id}/presets` returns the base skeleton
and the catalog, `POST /api/admin/nodes/{id}/presets/{id}` with
`{"config": <document|null>, "options": {...}}` returns the merged document
for review, and the ordinary `PUT .../config` stores it when the admin
presses Save config.

- **Base config** — the skeleton a new node starts from:
  `inbounds: []`, `outbounds: [{tag: "BLOCK", protocol: "blackhole"}]`,
  `routing: {rules: []}`, `log: {loglevel: "warning"}`.
- **REALITY inbound** — one VLESS + REALITY inbound on 443,
  `dest=/dev/shm/lessv-decoy.sock`, `serverNames=[domain]`, a fresh
  even-length-hex `shortId`, chrome fingerprint, vision flow.
  `privateKey` stays empty; the plane injects/stores keys per inbound at
  render time (`ensureKeys`), so the private key never appears in the
  frontend. Fields (tag, domain, socket, shortId, flow) default from the
  node's configured domain and the decoy socket.
- **WARP outbound** — the plane registers a free Cloudflare WARP device
  (`POST https://api.cloudflareclient.com/v0a2158/reg`, the exchange wgcf
  performs), derives the reserved bytes from the device's `client_id`, and
  returns a `wireguard` outbound with `noKernelTun: true` (the built-in
  stack needs no `/dev/net/tun`). Every build creates a new device.
- **Geo block routing** — appends `geoip:<code>` and/or `geosite:<category>`
  rules that send matches to `BLOCK` (or another chosen tag). Two rules,
  because Xray ANDs the matchers inside one rule (`ip` + `domain` in one rule
  matches only destinations that satisfy both). When an `ip` rule is added,
  the preset sets `routing.domainStrategy: IPOnDemand` if the document has
  none: the plane appends a per-user rule that matches every connection, and
  Xray's `IPIfNonMatch` only resolves a hostname when **no** rule matched —
  the later per-user rule wins first, so an ip rule under `IPIfNonMatch`
  never sees a hostname destination. `IPOnDemand` resolves when the ip rule
  is evaluated. A document that already sets another strategy keeps it and
  the build warns. Needs the geodata files below.
- **Geo rules and real-world DNS** — `geoip:` is IP geolocation, and CDNs
  answer with regional edges: from an EU node `www.baidu.com` resolves to
  Baidu's Hong Kong range (103.235.46.0/24), not to a mainland IP, so an
  ip-only rule does not catch it even under `IPOnDemand`. Add the matching
  domain set (`categories: cn`, or `category-ru`) so the site is blocked by
  name. Both matchers are evaluated for the traffic a user sends as a
  hostname, which is the normal case through VLESS.

Merge rules: array items are keyed by `tag` (replace in place, append when
new), arrays of scalars replace, arrays of objects without a tag append
unless an identical element is already present, objects merge recursively.

`BLOCK` is the first outbound: it is the default route for unmatched
traffic, never assignable to a user, and excluded from routing allocation.
Every other outbound is rendered per node as `<node>-<tag>` (e.g.
`tokyo01-direct`). On the user authorization page select the exits the admin
added; every registered endpoint shows up on the node's Links tab, where its
name can be changed and extra link variants added.

## Xray binary and geodata updates

The admin confirms both on the node page (**Maintenance**); the plane records
a `node_actions` row and the node executes it on its next heartbeat, then
reports through `POST /api/node/action`. Neither action is automatic except
the weekly geodata refresh.

- **Xray binary**: the node resolves the requested tag (`latest` by default)
  through the GitHub API, downloads `Xray-linux-*.zip` plus the vendor
  `.dgst`, verifies the SHA-256, extracts the binary itself (no `unzip`
  runtime dependency), runs `version` and a full `run -test` against the live
  config, copies the current binary to `xray.lessv-backup`, swaps the new
  one in, restarts the service and verifies it stays up. Any failure leaves
  or restores the previous binary. A repeated request for the version it
  already runs is answered without downloading anything.
- **Geodata**: the node installs `geoip-full.dat` and `geosite.dat` from
  `XTLS/Xray-rules-dat` (latest release, SHA-256 sidecars verified,
  decompressed in-process) into `geodata_dir`, restarts Xray, and restores
  the previous pair if it does not stay up. The full GeoIP edition carries
  per-country sets; the lite edition would only know the regional
  whitelists.
  - First run: the node installs the data once regardless of its config.
  - Then: every 7 days while the live config references `geoip:`/`geosite:`,
    and on every admin request. A failed refresh is retried after 24 hours.

Both actions are visible in `GET /api/admin/nodes/{id}/sync` under `actions`
(`pending`/`ok`/`failed`, target, message, timestamps); a failure stays
visible until the admin requests the action again.

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
- GeoIP/GeoSite data lives in `/var/lib/lessv/assets/geoip.dat` and
  `geosite.dat` (see the update section above); a stale `.prev` sibling is
  the last rollback copy.

## nginx decoy configuration (generated by lessv-node)

`install.sh` removes the distribution's default site and writes nothing
else; the node renders one file from the certificate manifest:

- Debian/Ubuntu/RHEL: `/etc/nginx/conf.d/lessv-decoy.conf`
- Alpine: `/etc/nginx/http.d/lessv-decoy.conf`

One `server` block per assigned certificate, listening **only** on the
decoy's Unix socket, plus one plain-HTTP block that redirects everything to
HTTPS:

```nginx
# Managed by lessv-node. Regenerated from GET /api/node/certs on every sync;
# edits are overwritten. Xray owns 443 — this decoy listens on a Unix socket
# (REALITY's dest) only, and redirects plain HTTP on :80 to HTTPS.

server {
    listen 80 default_server;
    server_name <domain> [<domain> ...];
    return 301 https://$host$request_uri;
}

server {
    listen unix:/dev/shm/lessv-decoy.sock ssl default_server;
    server_name <domain>;

    ssl_certificate     /etc/lessv/certs/<path>/current/fullchain.pem;
    ssl_certificate_key /etc/lessv/certs/<path>/current/privkey.pem;
    ssl_protocols       TLSv1.3;
    ssl_ecdh_curve      X25519MLKEM768:X25519;

    server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options DENY always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Robots-Tag "noindex, nofollow, noarchive, nosnippet" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src https://api.ipify.org https://api64.ipify.org; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;

    root  /var/www/lessv-decoy;
    index index.html;

    location = /robots.txt {
        default_type text/plain;
        return 200 "User-agent: *
Disallow: /
";
    }

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
- **Local socket, not a port.** The decoy's only listener is
  `/dev/shm/lessv-decoy.sock`; REALITY relays every handshake there, so the
  stolen origin never touches the network stack. An authored `dest` that is
  not this socket (for example `127.0.0.1:8443`) is a lint warning and a
  broken fallback — the compatibility loopback listener was removed.
- **Plain HTTP only redirects.** The `:80` block answers every assigned name
  with `301 https://$host$request_uri`; it carries no certificate. Port 80
  must be free (the installer removes the distribution's default site), and a
  bind conflict fails `nginx -t`/reload, which surfaces as a cert-stage
  failure instead of a silent half-config.
- **Anti-crawl headers and a managed page.** The decoy sends `X-Robots-Tag:
  noindex, nofollow, noarchive, nosnippet`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `nosniff`, a restrictive CSP, and a
  `robots.txt` that disallows everything. `index.html` is rendered by
  lessv-node from a template that starts with
  `<!-- lessv-node-decoy-page -->`: while that marker is present the page
  follows upgrades; delete the marker to keep your own page untouched.
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
   file stale). The decoy page lives at `/var/www/lessv-decoy/index.html`.
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
Delete the node itself with `DELETE /api/admin/nodes/<id>` (or the node
page's **Delete node**): one batch removes the row plus its token, config,
user access, endpoint registry, REALITY keys, and certificate assignments.
Domain-scoped evidence (cert domains, certificates, issue runs) is untouched,
and the machine keeps running its last applied config — decommission it
separately. The plane keeps domain/cert records; soft-deleted cert
domains disappear from the UI but their history stays in the database.
