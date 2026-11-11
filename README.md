# LessV

一个跑在 Cloudflare Workers 上的 Xray 面板：REALITY、nginx 自偷、Let's Encrypt 自动签发、订阅。节点端是 `lessv-node`（Rust 静态单二进制，systemd/OpenRC 常驻，与面板心跳同步）。

由 Lesserv-Cloud、Lesserv-Agent、ssl-cert-worker 三个仓库合并而来。

## 拓扑

只做拓扑 A：Xray REALITY 监听 443，`dest=/dev/shm/lessv-decoy.sock`（本机 Unix
socket；旧配置的 `127.0.0.1:8443` 仍兼容），证书只属于 nginx 假站点。

```
浏览器 ── /admin ──────────► Worker (Hono SPA)
                               │  /api/admin/*  ← ADMIN_KEY (Bearer)
                               │  /api/node/*   ← 节点 token
                               │  /sub/{token}  ← 订阅
                               ▼
                              D1 (migrations/)
用户 ── /sub/{token} ──► 订阅 ◄── 用户/节点/REALITY/证书
节点 ── Xray(REALITY 443) ──► lessv-node (Rust, systemd/OpenRC)
         ▲ nginx 假站点 (unix socket) │
         └── 证书 ◄── ACME (DNS-01) ◄── Worker
```

## 仓库结构

```
src/            Worker（Hono 路由 + 服务层）
frontend/       管理面板 SPA（React + Vite，挂 /admin）
migrations/     D1 schema（0001–0004 核心，0005–0007 证书，0008 端点注册表）
node/           lessv-node（Rust 单二进制）+ install.sh + systemd/OpenRC + Rust 测试
tests/          workerd 集成测试 + pure 单元测试
scripts/        wrangler 配置引导 + deploy.mjs
docs/           PROTOCOL（pull 契约 v2）+ OPERATIONS（证书/nginx 运维）
AGENTS.md       Agent 工作约定（公开/本地边界、验证基线、不变量）
```

## 本地开发

```bash
npm install
npm run dev                      # workerd @ 127.0.0.1:8787，读 .dev.vars
npm test                         # workerd 集成 + pure（hermetic，无 .dev.vars）
npm --prefix frontend run dev    # Vite dev server，代理 API 到 :8787
```

首次运行前：`cp .dev.vars.example .dev.vars` 并填入两个 secret（生成命令见部署一节）。`.dev.vars` 的每个键必须出现在 `wrangler.jsonc` 的 `secrets.required` 里，否则本地 dev 不会绑定它（默认 401）。

## 测试矩阵

| 层 | 命令 |
|---|---|
| Worker（workerd + pure） | `npm test` |
| 类型 | `npm run types && npm run typecheck` |
| Worker 构建 | `npm run build` |
| 前端 | `npm --prefix frontend test` / `run build` |
| 节点 | `cd node && cargo test`（Linux；发布物为 musl 静态二进制） |
| 部署脚本 | `npm run deploy -- --dry-run`（无云） |

测试不读 `.dev.vars`、不依赖任何本地 secret：secret 绑定在 `vitest.config.ts` 里声明（固定测试值）。若本地存在 `.dev.vars`，miniflare 启动时会多打印一行 loading 提示，但测试绑定不受影响。

## 部署

前提：一个 Cloudflare 账号、一个已托管在该账号的域名、已建好 R2 权限（部署会用 binding `CERTS` 绑定 bucket `lessv-certs`）。

1. `cp wrangler.example.jsonc wrangler.jsonc`，把 route 改成自己的主机名（占位符会被 deploy 脚本拒绝）。
2. 生成两个 secret：
   ```bash
   node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
   node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
   ```
   写入 `.env.production`（gitignored；模板 `.env.production.example`）。`KEY_SECRET` 加密落库的 REALITY 私钥，**不可轮换**——换掉它，历史节点密钥全部不可读。
3. `CF_DNS_API_TOKEN`：在 Cloudflare 建 API Token，权限 `Zone.DNS Edit` +
   `Zone.Zone Read`，作用域限定到要签证书的 zone。填入同一个 `.env.production`。
   它驱动 DNS-01（创建/清理 `_acme-challenge` TXT）和证书页的 zone 列表。
4. 创建证书 bucket（已存在则跳过；重复创建报 code 10004 无害）：
   ```bash
   npx wrangler r2 bucket create lessv-certs
   ```
5. `npm run deploy -- --secrets-file .env.production`
6. 脚本依次执行：SPA 构建 → `wrangler deploy`（首次自动建 D1 并写回 id）→ `d1 migrations apply DB --remote` → `https://<host>/api/health` 必须回答 200。

部署同时注册 Workflow `lessv-cert-issuance` 并设置每日 cron `17 3 * * *`（UTC，只对生产证书续期）。验证：`npx wrangler deployments list`、`npx wrangler workflows list`。

回滚：`npx wrangler rollback`。

## 首节点（≤30 分钟）

前提：VPS（Debian 13+/Ubuntu 25.04+/Alpine 3.22+，root SSH，443 空闲，可出站
443 与 GitHub/Gitee）；一个 **DNS only**（proxied 关闭）的 A 记录指向服务器
IP（REALITY 与 nginx 都必须直连）；面板已部署（上节）。发行版的要求来自 TLS
1.3 + PQ：nginx 链接的 OpenSSL 必须 ≥ 3.5 才能协商 `X25519MLKEM768`；更老的
发行版仍可运行，但 decoy 会退回 X25519 并在面板的 sync warnings 里说明。
`install.sh` 负责 nginx、Xray、服务单元与 enroll，计时从第 1 条命令开始，
到第 6 步的客户端探针成功结束。

```bash
CP=https://<cp-host>; NODE=<node-id>; NAME=<节点域名>
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
```

1. **建节点 + mint token**（面板或 API；token 只显示一次）：
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"id\":\"$NODE\",\"label\":\"First node\",\"address\":\"$NAME\"}" \
     $CP/api/admin/nodes
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
     $CP/api/admin/nodes/$NODE/token
   ```
2. **在节点上下载 release 并安装**（Gitee Release 分发；`install.sh` 从
   GitHub 装 Xray、从发行版仓库装 nginx）：
   ```bash
   ssh root@<server-ip>
   VERSION=0.4.0; BASE=https://gitee.com/realumino/lessv/releases/download/node-v$VERSION
   case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; esac
   curl -fsSLO $BASE/lessv-node-$VERSION-linux-$ARCH.tar.gz
   curl -fsSLO $BASE/SHA256SUMS
   grep " lessv-node-$VERSION-linux-$ARCH.tar.gz\$" SHA256SUMS | sha256sum -c -
   tar -xzf lessv-node-$VERSION-linux-$ARCH.tar.gz
   cd lessv-node-$VERSION-linux-$ARCH
   read -rs -p 'Node token: ' TOKEN; printf '%s\n' "$TOKEN" | ./install.sh --cp $CP --node $NODE
   ```
   期望：`lessv-node installed and started`。systemd：
   `journalctl -u lessv-node -n 20`；OpenRC：`tail -n 20 /var/log/lessv-node.log`。
   `install.sh` 装 curl/tar/unzip/ca-certificates、nginx 与 Xray v26.11.9
   （官方 release，`.dgst` 校验）、二进制到 `/usr/local/bin/lessv-node`；
   建 `/etc/lessv`、`/etc/lessv/certs`、`/var/lib/lessv`、
   `/var/www/lessv-decoy`；写 `lessv-node.service` + `xray.service`（xray 在
   nginx 之后启动，因为 REALITY 依赖它的 socket）
   （OpenRC 为 `/etc/init.d/lessv-node` + `/etc/init.d/xray`）；删除发行版
   默认 nginx site；写 `/etc/lessv/node.toml`（0600）并 enroll；enable +
   start。重复执行即原位升级：已有 node.toml 时复用 token，不要求重新粘贴。
   （维护者构建：`npm run release:node -- --targets amd64,arm64`，Linux 或
   配好 musl 交叉工具链的主机；`GITEE_TOKEN=<私人令牌> npm run release:node
   -- --targets amd64 --upload` 会创建/复用 tag `node-v<版本>` 的发行版并
   上传 tarball、`install.sh`、`VERSION`、`SHA256SUMS`。）
3. **写一份 REALITY 配置**：节点页用 **REALITY preset** 按钮生成自偷结构
   （`dest=/dev/shm/lessv-decoy.sock`、`serverNames=[节点域名]`、随机 8 位
   `shortId`、chrome fingerprint、vision flow；outbounds 恒为
   `BLOCK` + `direct`）。dest 是 lessv-node 生成的 decoy 的 Unix socket，
   两端必须一致；只有 nginx 与 Xray 同机时才有意义。
   点 Fill editor 后自己按 Save config。`privateKey` 保持为空：配置时
   `ensureKeys` 生成并注入，私钥永远不会出现在前端。等价的 API 方式：
   ```bash
   curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     --data @/tmp/reality.json $CP/api/admin/nodes/$NODE/config
   ```
   等 ≤60s：`GET /api/admin/nodes/$NODE/sync` 的 `applied_hash ==
   desired_hash`，`health=ok`。
4. **签证书**（详见下节）：前端 Certificates 页添加证书域名 → 先 **Test
   issue**（LE staging，不动生产）→ succeeded 后再决定是否 **Issue**（生产，
   输入域名确认）。
5. **分配证书 + 选环境**：节点页 Certs tab 勾选证书域名，并在
   Production/Staging 选择器里选环境（默认 production），保存。等 fleet
   的 applied = desired；lessv-node 自动拉取证书到
   `/etc/lessv/certs/<域名 path>/current/`，按清单生成 nginx 假站点配置，
   `nginx -t` + reload（未运行时改为 start）。
6. **建用户 + 订阅 + 客户端探针**（详见下节）：
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"username\":\"<user>\",\"access\":{\"$NODE\":{\"allowed_inbounds\":[\"reality\"],\"allowed_outbounds\":[\"direct\"]}}}" \
     $CP/api/admin/users
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
     $CP/api/admin/users/<user>/sub-token   # 201，只显示一次
   curl -sS $CP/sub/<sub-token> -o /tmp/sub.txt
   ```
   等 fleet 的 applied = desired（心跳 30s + apply，首次 60–90s）；导入
   v2rayN / NekoBox / Shadowrocket / Hiddify，更新订阅后连接，打开
   `https://api.ipify.org` 确认出口 IP 是节点地址；浏览器打开
   `https://<域名>/` 应看到假站点且证书有效（无需 `-k`）。使用 staging
   证书时，浏览器/curl 需要信任 Let's Encrypt staging 根
   （`https://letsencrypt.org/certs/staging/letsencrypt-stg-root-x1.pem`，
   装进系统信任库）；REALITY 隧道本身不依赖该信任。

## 证书

- **添加域名**：Certificates 页（`/certs`）选 zone（`GET /api/admin/zones`，
  由 `.env.production` 的 `CF_DNS_API_TOKEN` 驱动）→ 添加 `example.com`、
  `*.example.com` 或 `vpn.example.com`；`include wildcard` 会额外加一个
  `*.<name>` SAN（wildcard-only 行以 `*.` 开头，只签 wildcard）。
- **Test issue**：`POST /api/admin/cert-domains/:id/test-issue` 跑完整
  ACME/DNS-01 流程，但只翻 staging 的 current 指针，production 不动。用来
  验证 DNS/CAA 可达性，不耗生产限额。
- **Issue**：`POST /api/admin/cert-domains/:id/issue`，body
  `{"confirm":"<exact domain>"}`。LE 生产限额 5 张/周/域名，失败不要循环
  重试。
- **分配**：节点页 Certs tab（`PUT /api/admin/nodes/:id/cert-domains`）按
  证书域名分配，续期后自动跟随，无需重新勾选。
- **环境**：同一 Certs tab 的 Production/Staging 选择器（等价于
  `PUT /api/admin/nodes/:id` 带 `{"cert_environment":"staging"}`，默认
  production）决定该节点拉哪个环境的 current 证书：同一个分配、两个独立
  的 current 指针。staging 证书仅供测试——不受客户端信任（测试客户端需
  信任 LE staging 根）、不续期、7 天后清扫；节点没有 staging 证书时拿到
  空清单，不会回退到生产证书。
- **续期**：每日 cron（`17 3 * * *` UTC）对寿命超过 1/3 的生产证书续期
  （45 天 `tlsserver` → 第 15 天；`renew_before_days` 可覆盖），按域名加锁
  + 抖动；staging 不续期、7 天后清扫。续期成功会重渲染节点 desired hash，
  lessv-node 拉新 ETag、原子切换 `current`、`nginx -t` + reload——Xray 永不重启。
- **面板能看到什么**：域名页的 Runs（LE 错误原文 + 失败 phase）、
  production/staging current 证书（serial/not_after/profile）、节点 Certs
  tab、fleet 的 `nginx_ok`/`nginx_error`/`cert_synced_at`，以及证书 lint
  警告（如 `serverNames ... is not covered by an assigned certificate`）。

## 端点与链接（节点页 Links tab）

节点配置里的每个 inbound/outbound 都会在保存配置时登记进端点注册表，
得到稳定的 id（tag 本身合法时 id 就是 tag）：

- **Inbounds**：每一条都要管理，不论是否需要附加设置。inbound 的名称就是
  它默认链接的备注；额外的 variant（CDN 前置、另一个端口）用同一 id 关联，
  只覆盖 URI 参数（`address`/`port`/`sni`/`host`/`path`…）。改名与 variant
  都不进入运行时配置，节点无需重新渲染或重启。
- **Outbounds**：一行一个出口。`kind` 由配置推导——`blackhole`（或 tag
  `BLOCK`）是 `block`，`freedom` 是 `direct`，其余 `proxy`。`block` 是未匹配
  流量的默认路由，永远不能被分配给用户（API 返回 422，用户页不显示）。
- **tag 改名**：在配置里把 tag 从 `reality` 改成 `reality2` 后，旧行变成
  orphan（仍持有用户授权、REALITY 私钥与 variants），新 tag 得到一行空记录。
  在旧行上把 tag 重绑为 `reality2`（PATCH `.../inbounds/<id>`）就会接管那行
  空记录，授权/密钥/variants 全部保留；被引用的行不会被静默覆盖。
- orphan 行在没有任何引用、且配置不再声明时可以删除（否则 409 并说明是谁
  在引用它）。

## 用户与订阅

- 用户页新建用户，按节点勾选 inbound 与出口——`BLOCK` 不出现，它只是黑洞
  默认路由。授权按注册表 id 存储，会渲染成该节点的路由规则，fleet
  applied = desired 后生效。
- mint 订阅 token 后，订阅地址是 `https://<cp-host>/sub/<token>`：base64
  的 VLESS 链接列表，与用户页 Links 显示完全一致。链接携带
  `security=reality`、`sni=<节点域名>`、`flow=xtls-rprx-vision`、`pbk`、
  `sid`、`spx`、`encryption=none`、`type=tcp`。
- 探针：`curl https://api.ipify.org` 应返回节点 IP；`curl
  https://<域名>/` 应 200 且证书有效——隧道内外看到的是同一张 `tlsserver`
  证书（REALITY 把非 REALITY 流量转给 nginx 假站点）。

## 排障

`journalctl -u lessv-node -n 50`（OpenRC：`tail -n 50 /var/log/lessv-node.log`）、`journalctl -u xray -n 30`、
`xray run -test -c /var/lib/lessv/config.json`、面板 fleet 的
`health`/`last_error`/`nginx_ok`/证书 lint warnings。证书与 nginx 的运维
细节（测试签发、强制续期、停 nginx 排障、失败对照表）见
`docs/OPERATIONS.md`；node↔面板协议见 `docs/PROTOCOL.md`。不要手工改
`/var/lib/lessv/config.json`；让面板/lessv-node 收敛。

## 当前状态

- 发布物：平面 `v0.1.0`（本地 tag），节点 `lessv-node` `0.4.0`（Gitee
  Release `node-v0.4.0`，静态 musl 二进制 + `install.sh` + `SHA256SUMS`；
  构建：`npm run release:node`）。
- 测试矩阵：Worker 407 passed / 58 files；前端 41 passed；lessv-node 40 Rust 单元测试。
- 未做（候选方向）：nginx 配置面板托管、B 拓扑（TLS/WS/xhttp）、Clash
  订阅、stats/quota、到期通知、多管理员。

## 已知限制

- `expire` 只影响订阅资格（过期用户订阅为空，但配置仍保留）；
  `status=disabled` 才会从 Xray 配置移除。
- `PUT /api/admin/users` 无法把 `expire` 改回 `null`（null 表示“不变”），
  需要时用一个远期 epoch 替代。
- 没有节点删除 API：节点行保留作历史。
- nginx 假站点配置由 lessv-node 按证书清单生成；面板不渲染、不托管它的
  内容（只有证书域名的 server_name 与路径来自清单）。decoy 同时监听
  `/dev/shm/lessv-decoy.sock`（默认，REALITY 的 dest）与 `127.0.0.1:8443`
  （兼容旧配置），不监听 443。
- decoy 固定 `TLSv1.3` + `X25519MLKEM768:X25519`；链接的 OpenSSL < 3.5 时
  节点会去掉 PQ 曲线重渲染并上报说明（`nginx_ok=1` + `nginx_error` 文本），
  不会让证书同步失败。
- `ADMIN_KEY` 等价 root：持有它即可调用全部 admin API。
- `KEY_SECRET` 不可轮换——换掉它，历史节点密钥全部不可读。
- REALITY preset 发出的黑洞 outbound tag 是大写 `BLOCK`。早期 preset
  生成过小写 `block`，它会被当成可路由出口（渲染成 `<node>-block`，并多出
  一个黑洞选项）——受影响的旧节点用 preset 重新生成并保存一次配置即可。
- staging 证书不续期，7 天后由清扫任务删除；长期测试节点需要重新 Test
  issue。
