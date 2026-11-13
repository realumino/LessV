# LessV

Self-hosted traffic-forwarding management plane: a Cloudflare Worker (Hono,
D1, R2, Workflows) exposing `/api/*`, a React admin SPA under `/admin`, and
`lessv-node`, one static Rust binary per node under systemd or OpenRC. Nodes
pull their configuration and certificates from the plane; the plane never
connects to a node.

## Architecture

```
Browser ── /admin ─────────────► Worker (Hono + static SPA)
                                  │  /api/admin/*  ← ADMIN_KEY
                                  │  /api/node/*   ← node token
                                  │  /sub/{token}  ← subscription token
                                  ▼
                                 D1 (data) · R2 (certs) · Workflow (ACME)

User ── /sub/{token} ──► subscription ──► links (rendered from D1)

Node ── traffic-forwarding engine (REALITY :443) ──► lessv-node (Rust, systemd/OpenRC)
        ▲ nginx decoy (Unix socket) │
        └── certificate files ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

One node topology is supported. The traffic-forwarding engine's REALITY
listener owns 443 and forwards to the Unix socket
`/dev/shm/lessv-decoy.sock`; nginx serves the decoy site on that socket and
redirects port 80 to HTTPS. Certificates belong to nginx; the engine holds
none, and nginx never binds 443.

Node lifecycle, protocol 3:

1. `POST /api/node/enroll` with the node token.
2. `POST /api/node/heartbeat` every 30 s with `protocol`, `applied_hash`,
   runtime versions, and `last_error`. The reply carries `desired_hash` and
   pending maintenance actions.
3. `GET /api/node/config?hash=` when the hash differs, and
   `GET /api/node/certs` per manifest ETag.
4. `POST /api/node/report` and `POST /api/node/action` return apply and
   action results.

## Prerequisites

| Item | Requirement |
|---|---|
| Cloudflare | A zone on the account; R2 enabled; Workers, D1, Workflows available |
| Local machine | Node.js 22 LTS+, npm |
| Plane hostname | e.g. `cp.example.com`, Cloudflare-proxied (Custom Domain) |
| Node hostname | e.g. `node1.example.com`, **DNS only**, pointing at the node IP |
| Node host | Debian 13+ / Ubuntu 25.10+ / Alpine 3.22+, root, ports 80 and 443 free |
| Egress | The node reaches 80/443: distribution repositories, Gitee, GitHub, the plane over HTTPS |
| Backups | `KEY_SECRET`, `.env.production`, a D1 backup, and the node tokens |

Node hosts need TLS 1.3 with the `X25519MLKEM768:X25519` group; nginx must
link OpenSSL 3.5 or newer. The decoy has no classical key-exchange fallback.
`install.sh` rejects a host without it; an installed node reports the failure
through `last_error` and `nginx_ok=0`.

Order: deploy the Worker, enable Cloudflare Access if wanted, add nodes.

## Deploying the plane

### Code and dependencies

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

### Local wrangler config

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Set the route pattern in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

The template binds D1 (`DB`), R2 (`CERTS` → `lessv-certs`), the
`lessv-cert-issuance` Workflow, the daily `17 3 * * *` cron, and
`frontend/dist` as SPA assets. `workers_dev` and `preview_urls` are `false`;
the plane has one public hostname. `wrangler.jsonc` carries the real hostname
and the D1 id written after the first deploy, and is gitignored.

### Secrets

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

`.env.production`:

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

| Secret | Role |
|---|---|
| `ADMIN_KEY` | Bearer key for `/api/admin/*` and the SPA login; root-equivalent |
| `KEY_SECRET` | AES-256-GCM key sealing stored REALITY, certificate, and ACME account private keys; not rotatable |
| `CF_DNS_API_TOKEN` | `_acme-challenge` TXT records and zone reads |

`.dev.vars` serves `npm run dev`; `.env.production` serves deploys.

### DNS API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit`, `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → the certificate zone

The value goes into `.env.production` as `CF_DNS_API_TOKEN`.

### Certificate bucket

```bash
npx wrangler login
npx wrangler r2 bucket create lessv-certs
```

An existing bucket answers code 10004.

### Deploy

```bash
npm run deploy -- --secrets-file .env.production
```

The script builds the SPA, runs `wrangler deploy` with the secrets file,
applies remote D1 migrations to `DB`, and requires
`https://<plane hostname>/api/health` to answer 200. On a first deploy,
`wrangler deploy` creates the D1 database, writes its id back to
`wrangler.jsonc`, and attaches the Custom Domain.

### Verify

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

`https://cp.example.com/admin` accepts `ADMIN_KEY`. A node list means D1 and
`/api/admin/*` answer.

### Upgrade, rollback, secrets

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- `npx wrangler rollback` rolls back code only; D1 stays, and migrations
  remain forward-compatible.
- Later secret changes: `npx wrangler secret put <NAME>`.
- `ADMIN_KEY` can be rotated; every browser and script is updated with it.
  `KEY_SECRET` is never rotated.
- `npm run deploy -- --dry-run` builds and runs `wrangler deploy --dry-run`
  without touching the cloud.

## Cloudflare Access

Access adds an identity layer at the Cloudflare edge in front of the plane.
`ADMIN_KEY` remains required. Deploy the Worker before enabling Access.

| Surface | Behind Access | Credential |
|---|---|---|
| `/admin*` | yes | Access session, then `ADMIN_KEY` at the SPA login |
| `/api/admin*` | yes | Access session or service token, plus `ADMIN_KEY` |
| `/api/node/*` | no | node token |
| `/sub/*` | no | subscription token |
| `/api/health` | no | none |
| node `:443` | not applicable | node firewall |

### Applications

One Self-hosted and private application covers the whole hostname; `/admin`
and `/api/admin` share its session.

- Domain: `cp.example.com`
- Path: empty
- Session Duration: e.g. 24 hours
- Identity providers: One-time PIN or an SSO
- Policy: Action `Allow`, Include `Emails` → the operator address

Three further Self-hosted and private applications use the same domain, the
path below, and Action `Bypass`, Include `Everyone`:

| Path | Application URL |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

More specific paths win over the whole-host application. No `Allow` policies
on the Bypass applications; no Bypass for `/admin` or `/api/admin`.

### Service token for scripts

Zero Trust → Access controls → Service credentials → Service tokens →
Create. Copy the **Client ID** and **Client Secret**; the secret is shown
once. In the whole-host application add a policy: Action `Service Auth`,
Include `Service Token` → the new token.

```bash
export CF_ACCESS_CLIENT_ID='<client-id>'
export CF_ACCESS_CLIENT_SECRET='<client-secret>'
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)

curl -sS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  https://cp.example.com/api/admin/nodes
```

Browsers send only the Access cookie. The service token is a long-lived
credential: password manager or a 0600 file, never the repository, shell
history, or logs. Rotate it in Access after a leak.

### Boundary checks

```bash
# 200, not an Access login redirect
curl -i https://cp.example.com/api/health

# subscription content (or an empty 200), not Access
curl -i https://cp.example.com/sub/<token>

# the Worker's 401 JSON, not the Access login page
curl -i -X POST https://cp.example.com/api/node/enroll

# ADMIN_KEY alone is stopped by Access; both credentials answer 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

- Access is enforced at the edge only; `npm run dev` on port 8787 is not
  covered.
- `workers_dev` and `preview_urls` stay `false`; no second route.
- Access and `ADMIN_KEY` are independent gates.
- The node host does not pass through Cloudflare; its firewall admits 80/443
  only and its SSH is key-only and patched.

## Nodes

### Node row, token, DNS

Panel: **Nodes → Add node**. Id: 1–32 lowercase letters or digits (e.g.
`node1`); label: free text. Set **Domain** to `node1.example.com` and save;
the domain feeds REALITY `serverNames` and every share link.

**Re-generate token** (also for the first token) confirms and shows the
plaintext once; the plane stores a hash. A new token invalidates the old one
immediately.

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

DNS: an A record for `node1.example.com` → node IP, **DNS only**.

### Install over SSH

Debian 13+ / Ubuntu 25.10+ / Alpine 3.22+, root, `curl` and `tar` present.

```bash
ssh root@203.0.113.10

VERSION=0.6.0
BASE=https://gitee.com/realumino/lessv/releases/download/node-v$VERSION
case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch"; exit 1 ;;
esac
NAME=lessv-node-$VERSION-linux-$ARCH

curl -fsSLO $BASE/$NAME.tar.gz
curl -fsSLO $BASE/SHA256SUMS
grep " $NAME.tar.gz\$" SHA256SUMS | sha256sum -c -
tar -xzf $NAME.tar.gz
cd $NAME

./install.sh --cp https://cp.example.com --node node1
```

`install.sh` prompts for the token with echo off. It installs
`ca-certificates`, `curl`, `tar`, `unzip`, nginx, and the traffic-forwarding
engine (release archive, `.dgst` verified); installs `lessv-node` to
`/usr/local/bin/lessv-node`; creates `/etc/lessv`, `/etc/lessv/certs`,
`/var/lib/lessv`, `/var/lib/lessv/assets`, `/var/www/lessv-decoy`; writes the
systemd or OpenRC units, engine after nginx; writes `/etc/lessv/node.toml`
(0600), enrolls, enables, and starts the service.

Flags: `--version`, `--token-file`, `--release-base`, `--xray-version`,
`--skip-nginx`, `--skip-xray`, `--skip-enroll`.

Final line: `lessv-node installed and started`.

```bash
journalctl -u lessv-node -n 50          # systemd
tail -n 50 /var/log/lessv-node.log      # OpenRC
```

Upgrades repeat the download and `install.sh`, reusing `node.toml`. The
engine and geodata have separate update controls under **Maintenance**.

### Install with cloud-init

[`scripts/alpine_cloud_init.yaml`](scripts/alpine_cloud_init.yaml) provisions
an Alpine 3.22+ / OpenRC instance: BBR and fd limits, nftables with 80/443,
sshd disabled and removed, release download with `SHA256SUMS` verification,
`install.sh`, enrollment. There is no SSH after first boot.

1. Create node, domain, DNS, and token.
2. Copy the template outside the repository and fill the `/root/lessv.env`
   block:

   ```yaml
   NODE_ID="node1"
   CP_URL="https://cp.example.com"
   TOKEN="<node token>"
   VERSION="0.6.0"
   ```

3. Create an Alpine 3.22+ instance with the file as user-data; allow inbound
   TCP 80/443.
4. First boot ends with `Health: healthy` and `Applied` equal to `Desired`.
   Failures land in `/var/log/cloud-init-output.log`, read through the
   provider console.
5. A failed first boot is destroyed and recreated with a new node id and
   token.

The token stays in user-data and provider metadata. Deleting the node row
revokes it.

### First engine configuration

Node page → **Configuration**:

1. **Base config** → confirm. The editor holds `inbounds: []`, the one `BLOCK`
   blackhole outbound, and empty routing.
2. **Presets → REALITY inbound → Apply** merges:

   - listen on 443;
   - `dest=/dev/shm/lessv-decoy.sock`;
   - `serverNames=[node1.example.com]`;
   - random 8-hex-digit `shortId`;
   - vision flow control;
   - empty `privateKey`; the plane generates and injects the key at render
     time.

3. Review the merged JSON and **Save config**. A preset never saves on its
   own.

`/api/admin/nodes/node1/sync` reports `applied_hash`, `desired_hash`,
`health`, `last_error`, `nginx_ok`, and `cert_synced_at`. Applied catches
desired within about 60 seconds. An invalid config leaves the previous config
running and writes `last_error`.

Presets: REALITY inbound, WARP outbound (masque, CONNECT-IP over HTTP/3,
engine 26.10.21+), and `geoip:`/`geosite:` block rules. Extra outbounds:
`freedom` is direct; WARP is an upstream exit. `BLOCK` is the default route
for unmatched traffic and is never assignable to a user. Saving the config
registers every inbound and outbound in the endpoint registry; renaming a tag
keeps user access, REALITY keys, and link variants.

`/var/lib/lessv/config.json` is `lessv-node`-owned; the next pull overwrites
hand edits.

### Certificates

1. **Certificates → Add domain**: zone, `node1.example.com`, optional
   wildcard. Create.
2. **Test issue** runs the ACME DNS-01 flow against staging and moves only
   the staging current pointer.
3. **Issue** with the exact domain typed in the confirmation. Production
   certificates renew from the daily 03:17 UTC cron.
4. Node page → **Certificates**: check `node1.example.com`, environment
   `Production`, **Save assignment**.
5. The node writes `/etc/lessv/certs/<domain>/current/`, renders the nginx
   decoy config, runs `nginx -t`, and reloads nginx; the engine is not
   restarted.

```bash
curl -I http://node1.example.com     # 301 to https
curl -I https://node1.example.com    # 200, valid certificate
```

Staging certificates last 7 days and are not renewed; staging clients trust
the Let's Encrypt staging root. Let's Encrypt production allows 5
certificates per week per domain.

### Users, subscriptions, links

1. **Users → Add user**: username, status, optional expiry, **Access by node**
   with the allowed inbounds and outbounds. `BLOCK` is not offered.
2. Wait for `applied_hash == desired_hash`.
3. **Share → Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   **Rotate** on the same card replaces the token and invalidates the old URL.

4. Import the URL:

   - v2rayN / NekoBox / Shadowrocket / Hiddify: base64 VLESS list;
   - Clash Verge / FlClash / mihomo: mihomo profile for a user agent
     containing `clash`/`mihomo`/`stash`, or `?target=clash`;
   - `?target=uri` forces the VLESS list.

   **Names → Subscription title** sets the profile name (`{username}`,
   `{status}`); it travels as `profile-title: base64:…`.

5. Probe through the tunnel:

   ```bash
   curl https://api.ipify.org        # node egress IP
   curl https://node1.example.com/   # 200, valid certificate
   ```

The **Links** tab lists links per endpoint. Link variants (CDN front, another
port, different SNI) override URI parameters only and stay out of the runtime
config. A node without a domain generates no links.

The **Names** page sets one link format (default
`{node} · {subject} → {outbound}`; fields `{node}`, `{node_id}`, `{inbound}`,
`{inbound_tag}`, `{link}`, `{link_id}`, `{outbound}`, `{outbound_tag}`,
`{subject}`, `{protocol}`). A per-combination override wins. Renaming changes
imported links only.

## Operations

- **Engine update**: version `latest` or a fixed tag; the node verifies the
  `.dgst`, tests the config, backs up the old binary, replaces, restarts, and
  restores on failure.
- **Refresh geodata**: full `geoip.dat`/`geosite.dat` from the rules-dat
  release; installed once, then every 7 days while the config uses
  `geoip:`/`geosite:`.
- Both appear in `/api/admin/nodes/<id>/sync` under `actions`.
- **Delete** removes the token, config, user access, endpoint registry,
  REALITY keys, and certificate assignment; the machine keeps its last
  config.
- Backups: `KEY_SECRET`, `.env.production`, D1, the R2 bucket.

| Symptom | Check first | Fix |
|---|---|---|
| Node never appears | DNS is DNS only; inbound 80/443; egress 80/443; token; host clock | Fix the network or mint a new token; `journalctl -u lessv-node -n 50` |
| `health` is wrong | `last_error`, `applied_hash` vs `desired_hash` | Read the node log; the node validates before applying |
| Saved config does not apply | JSON validity; empty REALITY `privateKey`; `serverNames` covers the domain | Fix and save; the node keeps the previous config |
| `nginx_ok=0` | `nginx_error`; host OpenSSL 3.5+ | Move to Debian 13+/Ubuntu 25.10+/Alpine 3.22+ |
| Issuance fails | `issue_runs` phase/error; DNS token zone scope; CAA; LE limit | Test issue first |
| Node never receives a certificate | Assignment; environment; `cert_etag` | Re-save the assignment; compare the manifest ETag |
| Empty subscription | User status/expiry; inbound/outbound access; node address | Fix access or status; an empty body is 200, not 404 |
| Clash connects, a browser page does not | Client supports REALITY + `support-x25519mlkem768`; fingerprint | Use the generated mihomo profile |
| WARP preset returns 502 | Cloudflare WARP registration API reachable | Retry; the panel writes no partial config |

## Boundaries

- `ADMIN_KEY` is root-equivalent; Access is an additional edge gate.
- `KEY_SECRET` is not rotatable; rotating it makes every stored REALITY,
  certificate, and ACME account key unreadable.
- Node tokens are stored as hashes and shown once; `/etc/lessv/node.toml`
  stays 0600.
- A subscription URL is a bearer credential; **Rotate** replaces it.
- cloud-init leaves the token in user-data and provider metadata.
- `expire` affects subscription eligibility; `status=disabled` removes the
  user from the engine config.
- The Clash profile contains `proxies`, one `SELECT` group, and a `MATCH`
  rule; destination routing lives in the client.
- A REALITY key without a derivable public key yields a link without `pbk`.
- Deleting a node does not wipe the machine; decommission the host
  separately.
- The nginx decoy config and `index.html` are generated by `lessv-node`;
  removing the marker in `index.html` makes the page custom.
- The decoy is TLS 1.3 + `X25519MLKEM768:X25519` with no classical fallback.
- `BLOCK` is uppercase; lowercase `block` is a routable exit.
- WARP registration uses Cloudflare's app API; a failure answers 502 and
  writes no config.
- GeoIP uses the full rules-dat edition; the lite edition lacks arbitrary
  `geoip:` regions.
- Staging certificates are not renewed and are swept after 7 days.
- This document covers `lessv-node` 0.6.0 and protocol 3.

## Documentation

- Node ↔ plane contract: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Certificates, nginx, failure handling: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Architecture, development, tests, releases: [`docs/dev/`](docs/dev/README.md)

## License

LessV is licensed under the GNU Affero General Public License, version 3 or
later. The full text is in [`LICENSE`](LICENSE).

## Credits

LessV rests on open-source work for most of its machinery. The debt is large,
and the projects behind it are left unnamed in this document.
