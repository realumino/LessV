# Testing the plane

WHAT: the environments in which the control plane is exercised — what each one
proves, what it costs, and what must never be touched while testing.

The baseline command list (what "all green" means before declaring work done)
stays in [`development.md`](development.md#verification); this page is about
*environments*. It deliberately does not restate those commands.

Not here: how the node and its image are tested — see
`docs/testing.md` in [LessV-Node](https://github.com/realumino/vela-server).
The contract between the two (protocol number, endpoints, socket path,
certificate environments) lives in [`../PROTOCOL.md`](../PROTOCOL.md) and in
`src/routers/node.ts`; a second copy here would drift.

---

## Environments

| Tier | Environment | Proves | Assets at risk | Cost |
|---|---|---|---|---|
| A | hermetic workerd tests | routes, D1 schema, render, ACME state machine | none | seconds |
| B | `wrangler dev` (local) | the real renderer + a real agent, no cloud | none | minutes |
| C | `vela-staging` Worker | everything except production certificates, with automation | test rows only | ~free |
| D | one node under test | real 443, real ACME (staging CA), real decoy | test domain only | cents–5 USD |
| — | production | *not a test environment* | real certificates, users | — |

Production is listed to be excluded. Node rows created for testing in
production are still production rows: their certificates come from the
production pointer, and one careless `issue` spends a real rate limit. Test in
C/D instead.

---

## Tier A — hermetic

`npm test` runs the Worker inside `workerd` with real D1 semantics: the real
migrations from `migrations/` are applied by `tests/setup.ts`, so a schema
change is exercised by the same DDL production runs. Outbound calls are
intercepted (Cloudflare DNS, the ACME directory, the WARP registration
endpoint), which is what makes the suite safe to run anywhere and what keeps it
from proving anything about the network.

Consequences to keep in mind when reading a green run:

- a passing ACME test proves the *state machine* and JWS handling, not
  reachability of `acme-v02.api.letsencrypt.org` or of any zone's nameservers;
- a passing DNS test proves the request shape, not the token's scope;
- D1 here is miniflare's SQLite with D1 semantics, not a preview database.

## Tier B — local plane, real renderer, no cloud

```sh
npx wrangler d1 migrations apply DB --local --persist-to /tmp/vela-dev
npx wrangler dev --port 8788 --persist-to /tmp/vela-dev --ip 0.0.0.0
```

`--persist-to` keeps all local state out of the repository; `--ip 0.0.0.0` is
only needed when the node under test runs in a container on another host.

Bootstrap a node through the admin API. `ADMIN_KEY` is the value from
`.dev.vars` (wrangler does not export it into your shell):

```sh
AK=<ADMIN_KEY from .dev.vars>
BASE=http://127.0.0.1:8788
curl -X POST -H "Authorization: Bearer $AK" -H 'Content-Type: application/json' \
  -d '{"id":"local01","label":"local01"}' $BASE/api/admin/nodes
TOK=$(curl -sX POST -H "Authorization: Bearer $AK" \
  $BASE/api/admin/nodes/local01/token | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')

# the authored config: exactly the object the SPA's config page would PUT
curl -X PUT -H "Authorization: Bearer $AK" -H 'Content-Type: application/json' \
  --data-binary @- $BASE/api/admin/nodes/local01/config <<'JSON'
{
  "log": {"loglevel": "warning"},
  "inbounds": [{
    "tag": "reality", "listen": "0.0.0.0", "port": 443, "protocol": "vless",
    "settings": {"clients": [], "decryption": "none", "flow": "xtls-rprx-vision"},
    "streamSettings": {"network": "raw", "security": "reality", "realitySettings": {
      "dest": "/dev/shm/lessv-decoy.sock", "serverNames": ["decoy.example.test"],
      "privateKey": "<32-byte url-safe base64>", "shortIds": ["0a1b2c3d"],
      "settings": {"fingerprint": "chrome", "spiderX": "/"}}}
  }],
  "outbounds": [{"tag": "BLOCK", "protocol": "blackhole"}],
  "routing": {"rules": []}
}
JSON

# node-side endpoints, as the agent calls them
curl -X POST -H "Authorization: Bearer $TOK" -H 'X-Vela-Server: local01' \
  -H 'Content-Type: application/json' -d '{"protocol":3,"agent_version":"0.6.0"}' \
  $BASE/api/node/enroll
```

A fresh REALITY key for `privateKey` (the node will not apply an empty one):
`xray x25519` prints one, or `openssl rand -base64 32` for a throwaway plane
that only renders.

What this tier proves: the plane's *own* renderer — validation, preset merge
order, DEFAULT injection, hash computation — feeding a real agent. What it does
not: certificates. A local Worker configured with a placeholder
`CF_DNS_API_TOKEN` fails issuance by design; keep it that way and expect an
empty certificate manifest.

A useful boundary: tier B is the only tier where the plane's source can be
edited and observed in seconds. Use it before touching anything involving the
renderer or the protocol.

## Tier C — a separate deployment, created and destroyed by one command

```sh
node scripts/stage.mjs create --config wrangler.staging.jsonc   --secrets-file .env.staging --generate-secrets
# ... the test run, e.g. scripts/accept.mjs --plane https://<host> ...
node scripts/stage.mjs destroy --config wrangler.staging.jsonc
```

The config is the only input — copy `wrangler.example.jsonc` and edit its
`name`, route, `database_name` and workflow name. `create` deploys through the
pipeline (real SPA, remote migrations, health probe), uploads the secrets, and
generates the two plane-owned ones (`ADMIN_KEY`, `KEY_SECRET`) when told to;
the DNS token is a third-party credential, so it is copied from an existing env
file, never invented. `destroy` removes the workflow, the Worker (its
custom-domain record goes with it) and the database, in that order — a
workflow's records outlive its Worker, and `wrangler delete` never touches D1.
The secrets file is not deleted: its values are only disposable once the
database is gone, and the operator deletes it last.

Without the script, the same steps are:

```sh
cp wrangler.example.jsonc wrangler.staging.jsonc     # then edit the four names
npm run deploy -- --config wrangler.staging.jsonc --secrets-file .env.staging
npx wrangler secret bulk .env.staging --config wrangler.staging.jsonc
npx wrangler workflows delete <workflow> --config wrangler.staging.jsonc
npx wrangler delete --config wrangler.staging.jsonc
npx wrangler d1 delete <database> --config wrangler.staging.jsonc
```

Isolation is structural, not procedural: its own D1, its own `ADMIN_KEY`, its
own `KEY_SECRET`. The DNS token in it should be scoped to the test zone only —
a token scoped to the wrong zone makes the plane blind to the test zone, which
fails at the first `test-issue`, not at deploy time.

Two deliberate differences from production, both for automation:

- no Cloudflare Access in front of it (the SPA login is an operator convenience,
  not the API's security model — the admin key is), so scripts and CI can use it;
- no cron trigger in a staging config, so nothing issues or renews on a
  schedule while you test.

## Tier D — a node under test

One command runs the whole tier — node row, staging certificate, a disposable
host booted with the document the plane renders, the assertions, the report, and
a teardown that happens even when a check fails:

```sh
node scripts/accept.mjs --plane https://staging.example.com \
  --admin-key-file .env.staging --zone example.com \
  --linode-token-file .plans/KEYS \
  --image ghcr.io/owner/vela-server:latest \
  [--proxy socks5://127.0.0.1:7890] [--keep] [--timeout 900]
```

It creates everything under a per-run name (`acc<suffix>`, certificate
`*.lvtest-<suffix>.<zone>`), prints `PASS`/`FAIL` per check, writes
`.plans/accept/<timestamp>/report.json`, and deletes the host, the node row and
the certificate domain afterwards — `--keep` leaves them and prints the ids.
Only `test-issue` is ever used; a production certificate is never requested.
`--proxy` exists because an operator machine may not reach the provider's
addresses directly; the TLS checks are the only steps that need it.

The checks are: plane health, the zone visible to its DNS token, node + preset,
staging issuance to `complete`, the certificate assigned in the staging
environment, the rendered document, the host booting from it, `in_sync` with
`health: ok`, no render warnings, `nginx_ok: 1`, the certificate in the
manifest, `:80` answering 301, the host answering ICMP echo, and `:443`
presenting the staging issuer with `X25519MLKEM768`.

By hand, if you want to watch it: **Nodes → Add node → Re-generate token**
returns the document beside the token, with the node id, the control-plane URL,
the token, the image and the entrypoint already filled in. Paste it as the
provider's user-data — nothing to edit, and the whole first boot is the thing
under test.

The node-side procedure (what the image asserts about itself, and the stub-plane
tier) is [`docs/testing.md` in
LessV-Node](https://github.com/realumino/vela-server/blob/main/docs/testing.md).
What the plane side checks after a boot, in order:

```sh
# enrolled and converged: last_seen set, applied_hash == desired_hash
curl -sS -H "Authorization: Bearer $ADMIN_KEY"   https://<cp>/api/admin/nodes/<id>/sync | jq '{health,in_sync,warnings,nginx_ok,certs}'

# the published ports and the firewall's ICMP exception, from outside the host
curl -I http://<id>.lvtest.<zone>/            # 301 to https
ping -c 2 <ip>                                # echo is allowed, nothing else is
openssl s_client -connect <ip>:443 -servername <id>.lvtest.<zone> </dev/null 2>/dev/null   | grep -E 'issuer=|Negotiated TLS'          # staging CA, X25519MLKEM768
```

Two failure modes are worth recognising on a first boot, because both look like
"the node never appeared" from the panel:

- `cannot start docker as cgroups would not start` — the image booted without a
  mounted cgroup hierarchy. The document mounts cgroup2 itself; if it still
  happens, `/var/log/cloud-init-output.log` has the cgroups/docker status the
  bootstrap prints before it exits.
- `failed to copy: … read tcp …` during `docker pull` — a stalled layer, not a
  missing image. The document retries three times; finished layers are cached,
  so a manual `docker pull` on the host resumes cheaply. A test image that is
  not published yet can be pushed to an ephemeral public registry (`ttl.sh`) and
  passed as `?image=` when minting the token.

The plane-side rules that make tier D safe:

1. **Certificates for tests are issued against Let's Encrypt staging.**
   `POST /api/admin/cert-domains/:id/test-issue` runs the whole ACME flow
   against the staging directory and flips only the *staging* current pointer.
   Production keeps its own pointer for the same domain, so nothing changes for
   real nodes.
2. **`cert_environment` selects the pointer.** `PUT
   /api/admin/nodes/:id` with `{"cert_environment":"staging"}` makes the test
   node pull staging certificates. A staging node whose domain has no current
   staging certificate receives an **empty** manifest — never the production
   bytes. That fail-safe is the reason this is safe to run against a shared
   zone.
3. **Staging certificates are never renewed and are swept 7 days after
   issuance.** Re-run `test-issue` before a demo; switch the node back to
   `production` when the test is over.
4. **Never `issue` a production certificate for a test.** 5 duplicates/week per
   name is a hard limit, and a wasted one delays a real renewal.
5. Test clients must trust the staging root to verify the decoy
   ([`../OPERATIONS.md](../OPERATIONS.md), "Trusting the staging root"); Xray /
   REALITY clients do not validate the decoy certificate, so proxy traffic
   works unmodified.

Ephemeral beats permanent. A node can be created, booted, tested and destroyed
inside one release cycle by one command: the document from the token dialog
*is* the environment-as-code. A cert domain row is unique by name even after it
is soft-deleted, which is why every run uses its own `lvtest-<suffix>` label —
a test plane accumulates deleted rows, not live ones. A permanent test node is only worth it when it is also the
canary that runs every release first. Destroy in this order: the instance, the
node row, the certificate domain (which takes its certificate and artifact rows
and the TXT records with it), then the DNS records you added.

---

## Credentials: what actually needs care

Sort every value into one bucket first. The plane generates whatever it can; you
only create what a third party issues.

| Bucket | Members | Losing it costs |
|---|---|---|
| **Disposable** — regenerated per environment | `ADMIN_KEY`; node tokens; REALITY and certificate keys (plane-generated); Access and registry tokens | re-auth / re-enroll |
| **Back it up** — generated once | `KEY_SECRET` | in production: every sealed key unreadable |
| **You create — know the scope** | `CF_DNS_API_TOKEN`; the provider token (Linode et al.) | the token reaches real assets |

### In a disposable test environment, only the third row matters

Everything a test environment generates is destroyed with it, so `ADMIN_KEY`,
`KEY_SECRET`, node tokens and every plane-generated key are **not** things to be
careful about: mint them per run (`node -e
"console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`),
use them, delete the environment. A leaked test `KEY_SECRET` opens nothing once
its D1 is gone.

That leaves two credentials that can still reach something you own:

| Credential | Reaches | Before you create it |
|---|---|---|
| `CF_DNS_API_TOKEN` | every DNS record in its zone — production names included if the test shares the zone — and, via DNS-01, certificates for any name in it | point it at a test zone or a delegated subdomain, or accept that the test can rewrite production DNS |
| provider token (Linode et al.) | every instance **on the account** (scopes are per resource type, not per instance) | a token made for testing, with an expiry, revoked after the run — the same token can delete your real nodes |

### Three ways "it dies with the environment" stops being true

1. **The test DB is seeded from a production dump.** Then the test's
   `KEY_SECRET` must be the production one to decrypt anything, so the test
   environment now *holds* production keys. Treat that environment as
   production from then on: no shared `.env`, no public screenshot, and destroy
   the data rather than the Worker.
2. **A test node is enrolled into the production plane.** Its node token and its
   REALITY key are production assets, not test ones — the "test" only moved the
   blast radius.
3. **Teardown misses the data.** `wrangler delete` removes the Worker and
   nothing else (it has no flag for databases or buckets). The secrets are only
   disposable once these are gone too:

   ```sh
   npx wrangler delete --config wrangler.staging.jsonc
   npx wrangler d1 delete vela-staging
   rm -rf /tmp/vela-dev         # any --persist-to directory
   ```

   A leftover D1 export is exactly what a "trashed" secret still
   opens. Delete the data, then forget the key.

### In production, all of it matters — ranked by blast radius

| Credential | If it leaks |
|---|---|
| `KEY_SECRET` | with a DB dump, opens **every** sealed key: all REALITY private keys (server identity — an attacker can decrypt traffic to the nodes), every leaf certificate key, every ACME account key |
| `ADMIN_KEY` | full admin API: mint any node's token → read its rendered config (REALITY private key + every UUID), read users, delete nodes, trigger issuance. Cloudflare Access in front is a second layer, not a substitute |
| provider token | create, reboot, **delete** every instance on the account |
| `CF_DNS_API_TOKEN` | rewrite any record in its zone; obtain certificates for any name in it |
| node token | that one node's rendered config (its REALITY private key and UUIDs) and its identity to the plane |
| registry read token | pull the image |

`KEY_SECRET` seals REALITY keys, certificate leaf keys and ACME account keys
(`services/key_cipher.ts`); a REALITY key is never authored in the config —
`applyRealityKeys` overwrites whatever is there with the sealed generated key,
so an invented value would only mislead you.

### Scope details, when you do create one

| Name | Minimum permission | Never grant |
|---|---|---|
| `CF_DNS_API_TOKEN` | **Zone → Zone → Read** + **Zone → DNS → Edit**, Zone Resources: *Include → Specific zone → that zone* | Account-scoped tokens, `Zone → Zone → Edit`, `API Tokens → Edit`, Workers permissions |
| provider token | Linode: `linodes:read_write`, with an expiry | account, volume, firewall or domain scopes |
| registry token (private package only) | `read:packages` | `write:packages` outside the release workflow |

Why exactly those two Cloudflare permissions: the code calls zone lookup by
name (`GET /zones?name=…`, also the SPA's zone picker) and DNS record
create/delete (`POST`/`DELETE /zones/{id}/dns_records`). It never calls
`/accounts/*`, never verifies the token, and never touches Workers or zone
settings — `src/cert/dns/cloudflare.ts` is the complete list. D1 is a Worker
**binding**, so it needs no token at all.

Verify a token before trusting it, against the **test** zone:

```sh
ZONE=<test-zone>
TOKEN=<CF_DNS_API_TOKEN>
curl -s -H "Authorization: Bearer $TOKEN"   "https://api.cloudflare.com/client/v4/zones?name=$ZONE"   | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["success"], [z["name"] for z in d.get("result",[])])'
```

If that prints `True ['<test-zone>']`, Zone:Read is right. DNS:Edit is only
proven by a write: issue one staging certificate (`test-issue`) — a token
lacking it fails at `publish-txt-*` with a 403, which is the expected, harmless
failure mode.

Optional, only if the production admin API must be automated: Cloudflare Access
sits in front of it, so a script needs an **Access service token** (Zero Trust →
Service Auth → create service token; one policy, `Service Auth`, bound to that
one application). That is a per-application grant, revocable alone — and it is
avoidable entirely by automating against tier C instead.

## Fidelity ladder

| Keep identical | Safe to fake |
|---|---|
| the Worker code, `compatibility_date`, migrations | account, region, scale |
| protocol version and endpoint shapes | DNS zone (a test subdomain is enough) |
| the certificate *environment* semantics | certificate authority (staging CA) |
| the node image digest under test | node count, traffic |
| D1 binding names | storage size |

## Failure policy

- A test that fails on an unrelated change is quarantined (skipped with a linked
  issue) in the same commit, never deleted.
- A fixed bug gets a regression test in the same commit: a pure test when the
  cause is logic, a workerd test when it involves routing, D1 or render, a
  tier C/D run when it involves ACME, DNS or a real node.
- Do not "fix" a flaky test with a longer timeout unless the doc or the test
  names the condition it waits for.
- A red tier A run blocks everything; a red tier C/D run blocks the release of
  whatever changed.

## What CI runs today

Nothing yet — this repository has no workflow. Tier A is a **local** gate: the
baseline in [`development.md`](development.md#verification) is what "all green"
means before declaring work done. Tiers B–D are manual and need a Cloudflare
account, real DNS or a host.

The only automated pipeline across the two repos is `image.yml` in LessV-Node:
it runs the node's crate tests and builds the image for both architectures on a
`node-v*` tag. A workflow here that runs `npm test`, `npm run typecheck` and
`npm run build` on every push is the obvious next step, and it is what makes
tier A a gate rather than a habit.