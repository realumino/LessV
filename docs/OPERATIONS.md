# Operations — certificates, nginx, node troubleshooting

Runbook for the P0/P1a/P1b product shape: Xray REALITY on 443 with
loopback self-steal (`dest=127.0.0.1:8443`), nginx serving the decoy site
with a Let's Encrypt certificate issued by the plane (DNS-01), and agents
that pull their certificates from the plane.

## Topology

```
Internet ── :443 ──► Xray (REALITY, stream proxy)
                        │ realitySettings.dest = 127.0.0.1:8443
                        ▼
                     nginx (TLS, decoy site)
                        │ ssl_certificate = /etc/lessv/certs/<path>/current/fullchain.pem
                        ▼
                     certificate files ← agent cert sync ← GET /api/node/certs
```

- 443 belongs to Xray. Never configure nginx to listen on 443.
- Certificates belong to nginx (the self-stealed origin); Xray has none.

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
   which cert domains an agent receives. Assignments act on the
   certificate **domain**, so renewals flow automatically.
5. **Renewal**: the daily cron (`17 3 * * *` UTC) renews production
   certificates older than 1/3 of their lifetime (45 days → day 15), with a
   per-run jitter and idempotent date-range locking. Staging certificates
   are never renewed and are swept after 7 days.

Every issuance records an `issue_runs` row with phases
(`create-account` → `create-order` → `publish-txt` → `accept` →
`wait-propagation` → `finalize` → `store`); failures keep the raw
Let's Encrypt error text in `error` — that is the first place to look.

## Node delivery layout (agent)

```
/etc/lessv/certs/<domain path>/
├── <fingerprint sha256>/        # one directory per certificate version
│   ├── fullchain.pem            # 0644
│   └── privkey.pem              # 0600 (0600/0640+cert_group when set)
└── current -> <fingerprint>/    # symlink, swapped atomically
```

- The agent validates the manifest (ETag + fingerprint shape + safe
  domain paths) before writing; any invalid entry aborts the whole sync.
- Writes go to a temp directory, then `current` swaps via
  temp-symlink + rename — readers never see a missing or half-updated
  pointer.
- On any write/test/reload failure the agent rolls the symlinks back to
  the previous state and does NOT advance its stored ETag; the next loop
  retries.

## nginx snippet (manual, P1b)

Per node, with `<domain>` the cert domain and its `path`:

```nginx
server {
    listen 127.0.0.1:8443 ssl;
    server_name <domain>;

    ssl_certificate     /etc/lessv/certs/<path>/current/fullchain.pem;
    ssl_certificate_key /etc/lessv/certs/<path>/current/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root  /var/www/lessv-decoy;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

- Wildcard certificates use `wildcard.<zone>` as the path.
- The snippet references `current`, so certificate renewals need no nginx
  config change — the agent's reload after each sync picks the new bytes.
- `cert_group` is only needed when nginx does not run as root; Debian's
  master runs as root, so `0600` alone is fine.

## Routine operations

```bash
# issue / re-issue (forced renewal) for a domain
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"confirm":"<domain>"}' https://<cp>/api/admin/cert-domains/<id>/issue

# watch an issuance
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/cert-domains/<id>/runs

# certificate state the agent reports (admin view)
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp>/api/admin/nodes/<id>/certs
```

Agent side:

```bash
systemctl status lessv-agent
journalctl -u lessv-agent -n 100 --no-pager
ls -l /etc/lessv/certs/<path>/          # versions
readlink -f /etc/lessv/certs/<path>/current
nginx -t && systemctl reload nginx
```

## Troubleshooting playbook (in order)

1. **Panel: Certificates page → domain → Runs.** The LE error is verbatim
   (`caa`, `rateLimited`, `dns problem`, expired order...). Phase tells you
   where it died.
2. **Panel: node sync** (`GET /api/admin/nodes/<id>/sync`): `nginx_ok`,
   `nginx_error`, and certificate lint warnings (`serverNames ... is not
   covered by an assigned certificate`, `dest ... is not 127.0.0.1:<port>`,
   invalid `shortIds`).
3. **Node**: `journalctl -u lessv-agent -n 100`; `ls -l /etc/lessv/certs/<path>/`;
   `readlink -f .../current`. The agent's state file
   (`/var/lib/lessv/state.json`) carries `cert_etag`, `cert_synced_at`,
   and `last_nginx_ok`.
4. **nginx**: `nginx -t`; `systemctl status nginx`; `journalctl -u nginx -n 50`.
5. **HTTP checks**: `curl -v https://<domain>` (must validate without
   `-k`); `openssl s_client -connect <host>:443 -servername <domain>`.
6. **Xray**: `systemctl status xray`; `xray run -test -c /var/lib/lessv/config.json`;
   `journalctl -u xray -n 30`. Cert issuance and nginx reload must never
   restart Xray (`systemctl show xray -p MainPID` stays constant).
7. **Artifacts missing**: check R2 under `certs/<env>/<path>/<cert id>/`
   (binding `CERTS`, bucket `lessv-certs`). Do not hand-edit `current` —
   the agent reconciles it; a manual pointer will be overwritten or rolled
   back on the next sync.

### Failure cookbook

| Symptom | Meaning | First fix |
|---|---|---|
| `wait-propagation` loops then fails | TXT record not visible to DoH resolvers | check the `_acme-challenge` TXT in the Cloudflare dashboard; check the DNS token's zone scope |
| LE CAA error on a name | a CAA record forbids issuance | fix/remove the CAA record (`0 issue "none"` blocks everything) |
| `too many certificates already issued` | production rate limit | wait; use staging for any further testing |
| `nginx unit is not active` in warnings | nginx stopped/crashed | `systemctl start nginx`; the next cert-report cycle clears it |
| agent reports cert failure, files unchanged | artifact read/validate failed | check the object path from the error; do not edit files by hand |
| renewed cert never appears on the node | assignment changed or ETag stuck | re-check assignment; the agent reports `cert_etag` — compare with the manifest |

## Deleting an acceptance fixture

When a VPS is no longer needed: `node scripts/linode_provision.mjs delete
--token-file ~/.lessv/linode.env --label <label>`. The plane has no
node-delete API; leave the node row as history, or clean it with a
deliberate D1 statement (and `node_cert_domains`) if you accept losing
that evidence. The plane keeps domain/cert records; soft-deleted cert
domains disappear from the UI but their history stays in the database.
