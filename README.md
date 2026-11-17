# Vela

Vela is a self-hosted traffic-forwarding management plane on Cloudflare Workers. This file is the operator manual in Simplified Chinese, English, Persian, Russian, 조선어, and Türkmençe.

Vela 是一套自托管的流量转发管理面板：控制面跑在 Cloudflare Workers 上，管理端是挂在 `/admin` 的 React SPA，节点端是 [LessV-Node](https://github.com/realumino/vela-server) 提供的 `vela-server` 容器镜像。节点只从面板拉取配置与证书，面板不主动连接节点。

本文件是面向部署与运维的**使用手册**，包含简体中文、English、فارسی、Русский、조선어、Türkmençe 六个版本。开发者文档在 [`docs/dev/`](docs/dev/README.md)：架构、开发、测试、发布。

[简体中文](#zh) · [English](#en) · [فارسی](#fa) · [Русский](#ru) · [조선어](#ko) · [Türkmençe](#tk)

---

<a id="zh"></a>
## 简体中文

### 1. 它是什么

```
浏览器 ── /admin ─────────────► Worker（Hono + 静态 SPA）
                                  │  /api/admin/*  ← ADMIN_KEY
                                  │  /api/node/*   ← 节点 token
                                  │  /sub/{token}  ← 订阅 token
                                  ▼
                                 D1（状态与证书）· Workflow（ACME）

用户 ── /sub/{token} ──► 订阅 ──► 链接（由 D1 渲染）

节点 ── 流量转发工具内核（REALITY :443）──► vela-server（容器镜像）
        ▲ nginx 假站点（Unix socket）│
        └── 证书文件 ◄── GET /api/node/certs ◄── ACME（DNS-01）
```

只支持一种节点拓扑：流量转发工具内核的 REALITY 监听 443，`dest` 指向本机 Unix socket `/dev/shm/lessv-decoy.sock`；nginx 只在该 socket 上提供假站点，80 端口做 HTTPS 跳转；证书属于 nginx，流量转发工具内核不持有证书。节点上的 443 永远归流量转发工具内核，不要让 nginx 监听 443。

### 2. 准备

| 项目 | 要求 |
|---|---|
| Cloudflare | 一个已接入的域名（zone）；Workers、D1、Workflows 可用 |
| 本机 | Node.js 22 LTS+、npm |
| 面板域名 | 例如 `cp.example.com`，必须使用 Cloudflare Custom Domain（由 Cloudflare 托管） |
| 节点域名 | 例如 `node1.example.com`，**DNS only**（灰云），指向节点 IP |
| 节点主机 | 任何装有 Docker 及 compose 插件的 Linux，root，80/443 空闲 |
| 出站 | 节点可访问 80/443：容器镜像仓库、面板 HTTPS |
| 备份 | `KEY_SECRET`、`.env.production`、D1 备份、节点 token 的妥善保存 |

节点主机只跑一个容器、只拉一个镜像。内核、nginx 与后量子 TLS 库都在镜像里，所以宿主机用什么发行版、OpenSSL 是哪个版本都不影响：decoy 只提供 `X25519MLKEM768:X25519`，**没有经典密钥交换回退**，做不到的镜像会在 apply 时失败，而不是悄悄降级。

推荐顺序：先部署 Worker，再按需启用 Cloudflare Access，最后加节点。

### 3. 部署 Cloudflare Workers

#### 3.1 取得代码并安装依赖

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### 3.2 生成本地 wrangler 配置

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

编辑 `wrangler.jsonc` 的 `routes`，把 `cp.example.com` 换成自己的面板域名：

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

模板已经包含 D1、Workflow、每日 cron 和 SPA 资源绑定。保持 `workers_dev: false` 与 `preview_urls: false`：面板只应有一个公开主机名，否则 Cloudflare Access 可以被绕过。`wrangler.jsonc` 含真实域名和首次部署后写回的 D1 id，已被 gitignore。

#### 3.3 生成三个密钥

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

把输出写入 `.env.production`（不要提交）：

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY`：所有 `/api/admin/*` 请求的 Bearer key，也用于 SPA 登录。它等价 root，泄漏即失守。
- `KEY_SECRET`：AES-256-GCM 密钥，密封数据库里的 REALITY 私钥、证书私钥和 ACME 账户私钥。**不可轮换**；换掉它，历史密钥全部不可读。生成一次并离线备份。
- 本地开发用 `.dev.vars`，生产用 `.env.production`，两者不要复用同一组值。

#### 3.4 创建 DNS API Token

Cloudflare 控制台 → My Profile → API Tokens → Create Token → Custom token：

- Permissions：`Zone → DNS → Edit`，`Zone → Zone → Read`
- Zone Resources：Include → Specific zone → 要签发证书的 zone

把值填入 `.env.production` 的 `CF_DNS_API_TOKEN`。它只用于 Worker 创建/清理 `_acme-challenge` TXT 和读取 zone 列表，与 `wrangler login` 的凭据是两回事。

#### 3.5 部署

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy` 依次执行：构建 SPA → `wrangler deploy`（首次自动创建 D1 并写回 id，绑定 Custom Domain）→ 应用远程 D1 migrations → 请求 `https://<面板域名>/api/health` 必须 200。首次部署的 secret 只能通过 `--secrets-file` 提供，因为 `wrangler secret put` 不能作用于尚不存在的 Worker。

#### 3.6 验证

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

浏览器打开 `https://cp.example.com/admin`，粘贴 `ADMIN_KEY` 登录。页面能打开只说明 SPA 正常；还要能列出节点，才说明 D1 与 admin API 正常。

#### 3.7 升级、回滚与 secret 变更

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- 代码回滚：`npx wrangler rollback`。它不会回滚 D1；migrations 必须保持向前兼容。
- 后续修改 secret：`npx wrangler secret put <NAME>`。
- `KEY_SECRET` 不轮换。`ADMIN_KEY` 可以换，换后所有浏览器与脚本要重新登录/配置。
- 本地检查构建：`npm run deploy -- --dry-run`（不碰云）。

### 4. 配置 Cloudflare Access（推荐）

Cloudflare Access 在 Cloudflare 边缘增加一层身份认证。它**不是** `ADMIN_KEY` 的替代品：Worker 仍然要求 Bearer key；Access 只是让未认证请求到不了 Worker。必须**先完成 Worker 部署**，再启用 Access，因为部署脚本和 cloud-init 都要访问 `/api/health`。

#### 4.1 保护什么，不保护什么

| 路径 | 是否放到 Access 后面 | 原因 |
|---|---|---|
| `/admin*` | **是** | 管理 SPA、静态资源；只有人能登录 |
| `/api/admin*` | **是** | 管理 API；浏览器用 Access 会话，脚本用 service token |
| `/api/node/*` | **否** | 节点服务只发 Bearer token，不支持 Access；保护后所有节点失联 |
| `/sub/*` | **否** | 订阅客户端（v2rayN、Clash、Shadowrocket 等）不会走 Access；保护后订阅全断 |
| `/api/health` | **否** | 部署脚本和 cloud-init 用它判断面板可达；返回值只是常量 |
| 节点域名 `:443` | **不适用** | 节点 A 记录是 DNS only，流量不经过 Cloudflare；由节点防火墙只开 80/443 |

`/api/health` 若被 Access 挡住，`npm run deploy` 的最终探针和 cloud-init 的等待循环都会失败；它必须保持公开。

下面的做法是：一个整站应用保护管理面，再给三个公开路径加 Bypass；上表是最终效果。

原则：**只保护管理面**。节点面、订阅面、健康检查保持公开；它们各自有自己的凭据（节点 token、订阅 token、无）。

#### 4.2 创建一个整站 Access 应用

不要让 `/admin` 和 `/api/admin` 分别建两个 Access 应用：两个应用会生成两个应用令牌，SPA 调 API 时可能被要求重新认证。只建一个覆盖整个主机名的应用，让两者共享同一个 Access 会话。

Zero Trust → Access controls → Applications → Create new application → **Self-hosted and private** → Add public hostname：

- Domain：`cp.example.com`
- Path：**留空**（保护整个主机名；应用 URL 即 `https://cp.example.com`）
- Session Duration：例如 24 小时
- Identity providers：One-time PIN（默认）或自己的 SSO
- Policy：Action `Allow`，Include `Emails` → 你的邮箱

Service Auth 策略在第 4.4 步创建 service token 后加到这个应用。

#### 4.3 为公开路径创建 Bypass 应用

对每个必须公开的路径，再建一个 Self-hosted and private 应用：Domain 相同，Path 填对应值，策略为 Action `Bypass`、Include `Everyone`。

| Path | 应用 URL |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

更具体的路径优先于整站应用；`Bypass` 表示这个路径不要求登录。不要在 Bypass 应用里加 `Allow` 策略，也不要给 `/admin` 或 `/api/admin` 建 Bypass。`/api/health` 的 Bypass 如果漏掉，部署探针和 cloud-init 都会失败。

#### 4.4 为脚本创建 Service Token

Zero Trust → Access controls → Service credentials → Service tokens → Create：

1. 命名（例如 `vela-ops`），复制 **Client ID** 与 **Client Secret**（secret 只显示一次）。
2. 回到**整站应用**（不是 Bypass 应用），新增策略：Action `Service Auth`，Include `Service Token` → 选择刚创建的名称。
3. 脚本请求时同时带 Access 头和 Worker 的 Bearer：

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

浏览器不需要手动加这两个头，Access cookie 会自动带上。Service token 是长期凭据，放在密码管理器或 0600 文件里，不要进仓库、shell 历史或日志。泄漏后立即在 Access 里轮换。

#### 4.5 验证 Access 边界

```bash
# 应 200，不应跳转登录
curl -i https://cp.example.com/api/health

# 应返回订阅内容（或空 200），不应跳转 Access
curl -i https://cp.example.com/sub/<token>

# 应返回 Worker 的 401 JSON，而不是 Access 登录页
curl -i -X POST https://cp.example.com/api/node/enroll

# 管理 API：只带 ADMIN_KEY 应被 Access 拦截；两套凭据都带才 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

注意：

- Access 只在 Cloudflare 边缘生效；`npm run dev` 的本地 8787 不受保护。
- 只要存在 `workers.dev`、preview URL 或另一条 route，Access 就能被绕过。模板已关闭，不要手动打开。
- Access 不替代 `ADMIN_KEY`；两者是独立的两个门槛。
- `Bypass` 只用于 `/sub/*`、`/api/node/*`、`/api/health` 三个公开路径；不要给 `/admin` 或 `/api/admin` 加 Bypass，否则管理面就失去保护。
- 节点主机不经过 Cloudflare，Access 管不到它；节点安全靠只开 80/443、禁用密码登录和及时打补丁。

### 5. 添加节点

#### 5.1 先建节点行与 token

面板：**Nodes → Add node**。ID 只能是小写字母和数字、1–32 位（例如 `node1`）；Label 任意。创建后在节点页把 **Domain** 改成 `node1.example.com` 并保存——这个域名会进入 REALITY 的 `serverNames` 和分享链接。

节点页右上角 **Re-generate token**（首次也用它）→ 确认 → 复制弹出的 token。面板只存哈希，token 只显示一次。关闭对话框后无法再取回，只能重新生成（旧 token 立即失效）。

API 等价方式：

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

先建好 DNS：`node1.example.com` 的 A 记录指向节点 IP，**仅 DNS**（灰云）。REALITY 和 nginx 都必须直连 443；如果让记录经过 Cloudflare，隧道会坏。

#### 5.2 拉镜像并启动容器

主机只需要 Docker 与 compose 插件，以及镜像本身；其余都在容器里。

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# 一次性 enroll：token 走 stdin，不进参数列表
printf '%s\n' '<粘贴节点 token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

对外只发布两个端口，别的都不需要暴露。`vela-etc` 存放身份与证书目录，丢失要重新 enroll；`vela-state` 存放状态文件、运行配置与 geodata，丢失只需一次同步。日志：

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

升级：改 compose 文件里的 tag 后 `docker compose up -d`，或者交给 watchtower 一类的自动更新器。镜像里带着内核、nginx 和服务端，升级三者一起换；容器里手工改过的文件会在下次重建时消失，这是刻意的。geodata 仍由面板 **Maintenance → Refresh Geodata** 刷新。

#### 5.3 方式二：cloud-init

cloud-config 由面板生成：它是给 Alpine 3.22+ / OpenRC 且带 cloud-init 的镜像用的一次性文档，不需要手改。它会设置 BBR 与 fd 上限、安装 Docker 与 nftables（只开 80/443）、禁用并移除 sshd、写 compose 文件、执行一次 enroll 并启动服务。首次启动后节点没有 SSH，后续全部通过面板管理；故障按不可变基础设施处理，销毁重建。

步骤：

1. 按 5.1 建好节点、Domain 和 DNS。
2. 生成 token（5.1）。对话框里 token 旁边就是已经填好的 cloud-config——节点 id、面板地址、镜像和入口都已就位，token 只在这里出现一次。复制它。
3. 在 VPS 服务商处创建 Alpine 3.22+ 实例，把该文件作为 **user-data** 传入；防火墙放行入站 TCP 80/443（22 不需要，模板会禁用 sshd）。
4. 等待首启完成。面板上节点的 `Health` 变为 `healthy`、`Applied` 追上 `Desired` 即成功；失败时通过服务商控制台看 `/var/log/cloud-init-output.log`。
5. 首启失败不要原地修：销毁实例，用新的 node id 和 token 重建。`cloud-init` 只跑一次。

安全注意：token 在 user-data 中，服务商的元数据会保留它；模板会删除主机上的 `/root/vela.env` 和 bootstrap 文件，但删不掉服务商侧记录。只在可信服务商使用；吊销方式是删除面板节点行（token 立即失效）。渲染后的 user-data 不要提交到仓库。

该模板是 Alpine/OpenRC 专用；其他发行版请自行安装 Docker 后按 5.2 操作，不要直接把 OpenRC 脚本套到 systemd 主机上。

#### 5.4 写第一份流量转发工具内核配置

节点页 → **Configuration**：

1. 点 **Base config** → 确认。编辑器得到空骨架：`inbounds: []`、唯一的 `BLOCK` blackhole outbound、空 routing。
2. 右侧 **Presets → REALITY inbound → Apply**。默认值来自节点 Domain 与 decoy socket：
   - 监听 443；
   - `dest=/dev/shm/lessv-decoy.sock`；
   - `serverNames=[node1.example.com]`；
   - 随机 8 位十六进制 `shortId`；
   - vision 流控；
   - `privateKey` 留空，渲染时由面板生成并注入，私钥不会出现在前端。
3. 检查合并后的完整 JSON，按 **Save config**。预设不会自动保存。预设还包括 WARP outbound 和按 `geoip:`/`geosite:` 的封禁规则；它们同样只合并到编辑器，必须自己保存。

等 ≤60 秒，`GET /api/admin/nodes/node1/sync`（或节点页状态）应满足 `applied_hash == desired_hash`、`health=ok`。若配置非法，节点会保留上一份可用配置并把错误写进 `last_error`，面板会显示。

需要额外出口时，在配置里加 outbound（`freedom` 为直连，WARP 预设会生成 masque 出站（CONNECT-IP over HTTP/3，要求节点 Xray ≥ 26.10.21），其余按上游出口处理），再给用户分配。`BLOCK` 是未匹配流量的默认路由，永远不能分配给用户。保存配置会把每个 inbound/outbound 登记进端点注册表；改 tag 不会丢用户授权、REALITY 密钥或链接变体。

不要手工改节点上的 `/var/lib/vela/config.json`；面板是唯一事实来源，节点会在下次拉取时覆盖。

#### 5.5 签发并分配证书

节点域名必须是 `serverNames` 覆盖的名字，且证书分配给该节点后，nginx 假站点才会拿到证书。

1. 面板 **Certificates → Add domain**：选择 zone（通常自动解析），输入 `node1.example.com`；需要通配符时勾选 include wildcard。创建。
2. 点 **Test issue**：完整跑一遍 ACME/DNS-01，但只更新 staging 的 current，不动生产；用来验证 DNS 与 CAA 可达性，不消耗生产限额。
3. 成功后点 **Issue**，在确认框输入完整域名。Let's Encrypt 生产限额是每域名每周 5 张；失败不要循环重试。
4. 节点页 **Certificates** 标签：勾选 `node1.example.com`，环境选 **Production**（默认），**Save assignment**。
5. 等节点拉取：面板显示 `cert_synced_at`、`nginx_ok=1`。节点把证书写到 `/etc/vela/certs/<域名路径>/current/`，生成 nginx decoy 配置，执行 `nginx -t` 并 reload。流量转发工具内核不会重启。

验证：

```bash
curl -I http://node1.example.com     # 301 到 https
curl -I https://node1.example.com    # 200，证书有效（不用 -k）
```

用 staging 时，测试客户端需要信任 Let's Encrypt staging 根；staging 证书不续期，7 天后清扫。生产证书由每日 03:17 UTC cron 自动续期，续期后节点自动跟随，不需要重新分配。

#### 5.6 建用户、发订阅、客户端验证

1. **Users → Add user**：用户名、状态、可选到期时间；在 **Access by node** 里勾选节点，选择允许的 inbound 与 outbound；**Create user**。`BLOCK` 不会出现在出口列表里。
2. 等 `applied_hash == desired_hash`（节点下一次心跳 + apply）。
3. 用户列表 **Share** → **Subscription → Generate**。地址形如：

   ```
   https://cp.example.com/sub/<token>
   ```

   这个 URL 是 bearer capability：拿到它就能取订阅。泄漏后在同一个卡片点 **Rotate**，旧 URL 立即失效。
4. 导入客户端：
   - v2rayN / NekoBox / Shadowrocket / Hiddify：直接导入 URL，得到 base64 的 VLESS 链接列表；
   - Clash Verge / FlClash / mihomo：UA 含 `clash`/`mihomo`/`stash` 时返回 mihomo 配置；也可以强制 `?target=clash`；
   - `?target=uri` 强制回到 VLESS 列表。

   **Names → Subscription title** 可给订阅加显示标题（例如 `Vela · {username}`，字段 `{username}` `{status}`）；服务器以 `profile-title: base64:…` 头下发，v2rayN、Clash Verge 这类客户端会显示它。留空则不下发该头，行为与之前完全一致。
5. 探针：

   ```bash
   # 在客户端侧，通过隧道访问
   curl https://api.ipify.org        # 应返回节点出口 IP
   curl https://node1.example.com/   # 应 200，证书有效
   ```

   隧道内外看到的是同一张 `tlsserver` 证书：REALITY 把非 REALITY 流量转给 nginx 假站点。浏览器里应看到绿色“Your Connection is secure”卡片，展示访客出口 IP。

节点页 **Links** 标签按端点列出可用链接；同一 inbound 的额外变体（CDN 前置、另一个端口、不同 SNI）只覆盖 URI 参数，不进入运行时配置。节点没有 Domain 时不会生成链接。

顶部 **Names** 页面用一条格式串统一命名所有生成的链接（默认 `{node} · {subject} → {outbound}`，可用字段 `{node}` `{node_id}` `{inbound}` `{inbound_tag}` `{link}` `{link_id}` `{outbound}` `{outbound_tag}` `{subject}` `{protocol}`）；某个组合需要特殊名字时在同一页单独覆盖，覆盖优先于格式。改名只影响客户端导入的链接，不会让节点重新渲染。

### 6. 日常运维与排障

| 现象 | 先检查 | 处理 |
|---|---|---|
| 节点一直不出现 | DNS 是否 DNS only、是否发布 80/443、出站 80/443 与镜像仓库、token 是否复制完整、主机时间 | 修网络/重建 token；`docker compose -f /etc/vela/compose.yaml logs -n 50` |
| 面板有节点但 `health` 不对 | `last_error`、`applied_hash` 与 `desired_hash` | 看节点日志（节点在应用前会校验配置） |
| 配置保存后不生效 | JSON 是否合法、REALITY `privateKey` 是否留空、`serverNames` 是否覆盖域名 | 修正配置并 Save；节点保留上一份可用配置 |
| `nginx_ok=0` | `nginx_error` | decoy 的 TLS 库在镜像里；确认跑的是哪个 tag 并重建镜像 |
| 证书签发失败 | `issue_runs` 的 phase/error；DNS token 的 zone 权限；CAA；LE 限额 | 先用 Test issue；生产失败不要循环重试 |
| 节点拿不到证书 | 是否在节点 Certs 页勾选、环境是否选对、`cert_etag` 是否卡住 | 重新保存 assignment；对比 manifest ETag |
| 订阅为空 | 用户是否 disabled/过期、是否有 inbound/outbound 授权、节点是否配置了地址 | 修授权或状态；空 body 是 200，不是 404 |
| Clash 连不上但网页能开 | 客户端是否支持 REALITY + `support-x25519mlkem768`、是否用 chrome 指纹 | 用面板生成的 mihomo 配置；不要手改 URI |
| WARP 预设 502 | Cloudflare WARP 注册接口是否可达 | 重试；面板不会写入半份配置 |

节点维护：

- **Refresh Geodata**：从上游 rules-dat 发布页下载 full 版 `geoip.dat`/`geosite.dat`，校验后重启流量转发工具内核；首次无条件安装，之后配置里出现 `geoip:`/`geosite:` 时每 7 天自动刷新。
- 动作状态显示在节点 header，并可从 `/api/admin/nodes/<id>/sync` 的 `actions` 读取。
- **内核不由面板更新**：内核在镜像里，升级方式就是换镜像（见 5.2）。

删除节点：节点页 **Delete** 会删除该节点的 token、配置、用户授权、端点注册表、REALITY 密钥和证书分配；证书域名与签发历史属于域级资源，不受影响。机器仍会运行最后一份配置，需要单独销毁。重新生成 token 会让旧 token 立即失效，已有节点必须更新 `node.toml` 才能重新连上。

备份：至少备份 `KEY_SECRET`、`.env.production` 和 D1（Cloudflare 控制台的 D1 导出/时间点恢复）。D1 里既有状态也有证书产物。没有 `KEY_SECRET`，数据库里的 REALITY/证书/ACME 私钥都无法解密；证书可以重签，但私钥不能。

### 7. 安全边界与已知限制

- `ADMIN_KEY` 等价 root；Cloudflare Access 是额外门槛，不是替代品。
- `KEY_SECRET` 不可轮换；换掉它，历史节点密钥、证书私钥、ACME 账户全部不可读。
- 节点 token 只存哈希、只显示一次；`vela-etc` 卷里的 token 文件（`/etc/vela/node.toml`）必须保持 0600。
- 订阅 URL 是能力凭据；泄漏即等于把该用户的订阅交给对方，及时 Rotate。
- cloud-init 的 token 存在 user-data 和服务商元数据里；不可信服务商不要用。
- `expire` 只影响订阅资格（过期用户拿到空订阅），`status=disabled` 才会从流量转发工具内核配置移除。
- Clash 订阅只生成 `proxies`、一个 `SELECT` 组和 `MATCH` 规则；按目的地分流请在客户端自行添加。
- REALITY 私钥若派生不出公钥（例如配置里留了占位符），链接没有 `pbk`，该链接无法完成 REALITY 握手。
- 删除节点不会远程清空机器上的配置；节点仍需单独下线。
- nginx decoy 配置与 `index.html` 由服务端生成/托管；删掉 `index.html` 里的标记即可自定义，但换镜像会刷新未自定义的页面。
- decoy 固定 TLS 1.3 + `X25519MLKEM768:X25519`，没有非 PQ 回退；这一切只在镜像里配置。
- `X-Vela-Server` 是服务端身份头（旧构建发送的 `X-Lessv-Node` 仍被接受），`/dev/shm/lessv-decoy.sock` 是 REALITY 的 `dest`：两者都是冻结的协议值，不是产品名。
- `BLOCK` 必须是大写；小写 `block` 会被当作可路由出口。
- WARP 注册依赖 Cloudflare 的 app API，失败会显示 502，不会写半份配置；每次预览预设都会注册一个新设备，面板不保存设备凭据。
- GeoIP 使用 rules-dat full 版；lite 版不能用于任意地区代码的 `geoip:` 规则。
- staging 证书不续期，7 天后清扫；长期测试节点需要重新 Test issue。
- 本文以协议 3 与 `vela-server` 镜像为例；具体镜像 tag 以服务端仓库为准。

### 8. 延伸文档

- 节点 ↔ 面板协议：[`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- 证书、nginx、故障处理：[`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- 架构、开发、测试、发布：[`docs/dev/`](docs/dev/README.md)

---

<a id="en"></a>
## English

### 1. What Vela is

Vela is a self-hosted traffic-forwarding management plane. The control plane
runs on Cloudflare Workers; the admin SPA is served under `/admin`; each node
runs `vela-server`, a container image from
[LessV-Node](https://github.com/realumino/vela-server). Nodes pull their desired
configuration and certificates from the plane. The plane never connects to a
node.

```
Browser ── /admin ─────────────► Worker (Hono + static SPA)
                                  │  /api/admin/*  ← ADMIN_KEY
                                  │  /api/node/*   ← node token
                                  │  /sub/{token}  ← subscription token
                                  ▼
                                 D1 (state + certificates) · Workflow (ACME)

User ── /sub/{token} ──► subscription ──► links (rendered from D1)

Node ── traffic-forwarding engine (REALITY :443) ──► vela-server (image)
        ▲ nginx decoy (Unix socket) │
        └── certificate files ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

Only one node topology is supported: the traffic-forwarding engine's REALITY
listens on 443 with `dest` pointed at the local Unix socket
`/dev/shm/lessv-decoy.sock`; nginx serves the decoy site on that socket only
and redirects port 80 to HTTPS.
Certificates belong to nginx; the traffic-forwarding engine holds none. Port
443 always belongs to the traffic-forwarding engine—never make nginx listen
on 443.

### 2. Prerequisites

| Item | Requirement |
|---|---|
| Cloudflare | A zone on the account; Workers, D1, Workflows available |
| Local machine | Node.js 22 LTS+, npm |
| Plane hostname | e.g. `cp.example.com`, proxied by Cloudflare (Custom Domain) |
| Node hostname | e.g. `node1.example.com`, **DNS only** (grey cloud), pointing at the node IP |
| Node host | Any Linux with Docker and its compose plugin, root, ports 80 and 443 free |
| Egress | The node can reach 80/443: its container registry, and the plane over HTTPS |
| Backups | `KEY_SECRET`, `.env.production`, a D1 backup, and the node tokens |

The host runs one container and pulls one image. Xray, nginx and the
post-quantum TLS library are inside that image, so the host's distribution and
its OpenSSL version do not matter: the decoy only offers
`X25519MLKEM768:X25519`, with **no classical fallback**, and an image that
cannot do it fails the apply instead of quietly downgrading.

Recommended order: deploy the Worker, enable Cloudflare Access if wanted, then
add nodes.

### 3. Deploying the Cloudflare Worker

#### 3.1 Get the code and install dependencies

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### 3.2 Create the local wrangler config

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit the `routes` entry in `wrangler.jsonc` to your plane hostname:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

The template already binds D1, the Workflow, the daily cron, and the SPA
assets. Keep `workers_dev: false` and `preview_urls: false`: the plane must
have exactly one public hostname, otherwise Cloudflare Access can be
bypassed. `wrangler.jsonc` contains the real hostname and the D1 id written
back after the first deploy, so it is gitignored.

#### 3.3 Generate the three secrets

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

Write them into `.env.production` (never commit it):

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY` is the Bearer key for every `/api/admin/*` request and the SPA
  login. It is root-equivalent: leaking it loses the plane.
- `KEY_SECRET` is the AES-256-GCM key that seals stored REALITY private keys,
  certificate private keys, and ACME account keys. **It cannot be rotated**:
  rotating it makes every stored key unreadable. Generate once and back it up
  offline.
- Use `.dev.vars` for local development and `.env.production` for production;
  never reuse the same values.

#### 3.4 Create the DNS API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit`, `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → the zone that will hold the
  certificate names

Put the value in `CF_DNS_API_TOKEN` in `.env.production`. This token is used by
the Worker to create/clean `_acme-challenge` TXT records and list zones; it is
not the `wrangler login` credential.

#### 3.5 Deploy

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy` runs: build the SPA → `wrangler deploy` (first deploy
auto-creates D1 and writes back its id, and attaches the Custom Domain) →
apply remote D1 migrations → require `https://<plane-host>/api/health` to
answer 200. The first deploy can only receive its secrets through
`--secrets-file`, because `wrangler secret put` cannot address a Worker that
does not exist yet.

#### 3.6 Verify

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

Open `https://cp.example.com/admin` and paste `ADMIN_KEY`. The page loading
only proves the SPA is served; listing nodes proves D1 and the admin API work.

#### 3.7 Upgrade, rollback, and secret changes

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- Code rollback: `npx wrangler rollback`. It does not roll back D1; migrations
  must remain forward-compatible.
- Change a secret later: `npx wrangler secret put <NAME>`.
- `KEY_SECRET` is not rotated. `ADMIN_KEY` can be rotated; every browser and
  script must then be updated.
- Local build check: `npm run deploy -- --dry-run` (no cloud).

### 4. Cloudflare Access (recommended)

Cloudflare Access adds an identity layer at the Cloudflare edge. It is **not**
a replacement for `ADMIN_KEY`: the Worker still requires the Bearer key;
Access only keeps unauthenticated requests away from the Worker. Deploy the
Worker **first**, then enable Access, because the deploy script and cloud-init
both need `/api/health`.

#### 4.1 What to protect and what not to

| Path | Behind Access? | Why |
|---|---|---|
| `/admin*` | **Yes** | Admin SPA and static assets; only humans log in |
| `/api/admin*` | **Yes** | Admin API; browsers use the Access session, scripts use a service token |
| `/api/node/*` | **No** | The node server sends only its Bearer token and cannot do Access; protecting it disconnects every node |
| `/sub/*` | **No** | Subscription clients (v2rayN, Clash, Shadowrocket, etc.) cannot do Access; protecting it breaks every subscription |
| `/api/health` | **No** | The deploy script and cloud-init use it to check reachability; it returns a constant |
| Node hostname `:443` | **Not applicable** | The node A record is DNS only; traffic does not go through Cloudflare. The node firewall opens only 80/443 |

If Access blocks `/api/health`, the final probe in `npm run deploy` and the cloud-init wait loop both fail; keep it public.

The setup below uses one whole-host application for the admin surface and Bypass applications for the three public paths; the table is the effective result.

The rule: **protect the admin surface only**. The node, subscription, and
health surfaces stay public; each has its own credential (node token,
subscription token, or none).

#### 4.2 Create one whole-host Access application

Do not create separate Access applications for `/admin` and `/api/admin`: two
applications issue two application tokens, and the SPA's API calls can be
challenged again. Create one application covering the whole hostname so both
share one Access session.

Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:

- Domain: `cp.example.com`
- Path: **empty** (protect the whole hostname; the application URL is
  `https://cp.example.com`)
- Session Duration: for example 24 hours
- Identity providers: One-time PIN (default) or your SSO
- Policy: Action `Allow`, Include `Emails` → your address

Add the Service Auth policy from step 4.4 to this application.

#### 4.3 Create Bypass applications for public paths

For each path that must stay public, create another Self-hosted and private
application with the same Domain, the path below, and a policy of Action
`Bypass`, Include `Everyone`.

| Path | Application URL |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

More specific paths win over the whole-host application; `Bypass` means the
path requires no login. Do not add `Allow` policies to the Bypass
applications, and do not create Bypass applications for `/admin` or
`/api/admin`. If the `/api/health` bypass is missing, the deploy probe and
cloud-init both fail.

#### 4.4 Create a service token for scripts

Zero Trust → Access controls → Service credentials → Service tokens → Create:

1. Name it (for example `vela-ops`) and copy the **Client ID** and **Client
   Secret** (the secret is shown once).
2. Return to the **whole-host application** (not a Bypass application) and add
   a policy: Action `Service Auth`, Include `Service Token` → the token you
   just created.
3. Scripts send both the Access headers and the Worker Bearer:

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

Browsers do not add these headers manually; the Access cookie does it. A
service token is a long-lived credential: keep it in a password manager or a
0600 file, never in the repository, shell history, or logs. Rotate it in
Access if it leaks.

#### 4.5 Verify the Access boundary

```bash
# Must be 200, not an Access login redirect
curl -i https://cp.example.com/api/health

# Must return subscription content (or an empty 200), not Access
curl -i https://cp.example.com/sub/<token>

# Must return the Worker's 401 JSON, not the Access login page
curl -i -X POST https://cp.example.com/api/node/enroll

# Admin API: ADMIN_KEY alone is stopped by Access; both credentials are 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

Caveats:

- Access applies only at the Cloudflare edge; `npm run dev` on local port 8787
  is unprotected.
- If a `workers.dev` hostname, a preview URL, or another route exists, Access
  can be bypassed. The template disables them; do not turn them on.
- Access does not replace `ADMIN_KEY`; they are independent gates.
- Use `Bypass` only for the three public paths (`/sub/*`, `/api/node/*`,
  `/api/health`); never add Bypass for `/admin` or `/api/admin`—that would
  expose the admin surface.
- The node host does not pass through Cloudflare, so Access cannot protect it.
  Node security is a minimal 80/443 firewall, no password SSH, and timely
  patches.

### 5. Adding a node

#### 5.1 Create the node row and token

Panel: **Nodes → Add node**. The id must be 1–32 lowercase letters or digits
(for example `node1`); the label is free text. After creating it, edit the
node's **Domain** to `node1.example.com` and save—this domain feeds REALITY
`serverNames` and every share link.

On the node page, **Re-generate token** (also for the first token) → confirm →
copy the token from the dialog. The plane stores only its hash and shows the
plaintext once. Closing the dialog loses it; generate a new one (the old token
stops working immediately).

API equivalent:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

Create DNS first: an A record for `node1.example.com` pointing at the node IP,
**DNS only** (grey cloud). REALITY and nginx both require direct 443; a
proxied record breaks the tunnel.

#### 5.2 Pull the image and start the container

The host needs Docker with the compose plugin, and the image. Everything else
runs inside it.

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# one-shot enrollment: the token arrives on stdin, never in an argument list
printf '%s\n' '<paste node token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

Two ports are published and nothing else needs exposing. `vela-etc` holds the
identity and the certificate tree; `vela-state` holds the state file, the live
config and geodata. Losing `vela-etc` means re-enrolling; losing
`vela-state` costs one reconcile. Logs:

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

Upgrade: change the tag in the compose file and run `docker compose up -d`,
or run a watchtower-style updater that does it. The image carries Xray, nginx
and the server, so an upgrade replaces all three; a hand-edited file inside a
container disappears on the next recreate, by design. Geodata is still
refreshed from the panel (**Maintenance → Refresh Geodata**).

#### 5.3 Option B: cloud-init

The plane writes the cloud-config for you: it is a one-shot document for an
Alpine 3.22+ / OpenRC image that runs cloud-init, and it needs no edits. It
raises BBR and fd limits, installs Docker and nftables (80/443 only), disables
and removes sshd, writes the compose file, enrolls once, and starts the
service. After first boot the node has no SSH; manage it from the panel. Treat
a broken node as immutable: destroy and rebuild.

Steps:

1. Create the node, Domain and DNS as in 5.1.
2. Mint the token (5.1). The dialog shows the finished cloud-config beside the
token — the node id, the control-plane URL, the image and the entrypoint are
already filled in, and the token appears there only once. Copy it.
3. Create an Alpine 3.22+ instance at the VPS provider and pass the file as
   **user-data**. Allow inbound TCP 80/443 in the provider firewall (22 is not
   needed; the template disables sshd).
4. Wait for first boot. Success is the panel showing `Health: healthy` and
   `Applied` catching up with `Desired`. If it fails, read
   `/var/log/cloud-init-output.log` through the provider console.
5. Do not repair a failed first boot in place: destroy the instance and
   recreate it with a new node id and token. cloud-init runs once.

Security note: the token is in user-data, and the provider's metadata keeps
it. The template deletes `/root/vela.env` and the bootstrap files on the host,
but cannot delete the provider-side record. Use it only on a provider you
trust; revoke by deleting the plane node row (the token stops working
immediately). Never commit rendered user-data.

The template is Alpine/OpenRC-specific. On any other distribution install
Docker yourself and follow 5.2; do not put OpenRC scripts on a systemd host.

#### 5.4 Write the first traffic-forwarding engine configuration

Node page → **Configuration**:

1. Click **Base config** → confirm. The editor gets the skeleton:
   `inbounds: []`, one `BLOCK` blackhole outbound, empty routing.
2. **Presets → REALITY inbound → Apply**. Defaults come from the node Domain
   and the decoy socket:
   - listen on 443;
   - `dest=/dev/shm/lessv-decoy.sock`;
   - `serverNames=[node1.example.com]`;
   - a random 8-hex-digit `shortId`;
   - vision flow control;
   - `privateKey` empty; the plane generates and injects it at render time, so
     the private key never appears in the frontend.
3. Review the merged JSON and press **Save config**. A preset never saves by
   itself. The catalog also includes a WARP outbound and geodata block rules
   (`geoip:`/`geosite:`); they are merged into the editor and need an explicit
   save too.

Within about 60 seconds, `GET /api/admin/nodes/node1/sync` (or the node page)
should show `applied_hash == desired_hash` and `health=ok`. An invalid config
keeps the previous working config and writes the error to `last_error`, which
the panel displays.

For extra exits, add outbounds to the config (`freedom` is direct; the WARP
preset creates a masque outbound (CONNECT-IP over HTTP/3; needs Xray 26.10.21 or
newer); anything else is treated as an upstream exit), then assign
them to users. `BLOCK` is the default route for unmatched traffic and can
never be assigned to a user. Saving the config registers every inbound and
outbound in the endpoint registry; renaming a tag preserves user access,
REALITY keys, and link variants.

Do not hand-edit `/var/lib/vela/config.json` on the node. The panel is the
only source of truth; the next pull overwrites the file.

#### 5.5 Issue and assign a certificate

The node hostname must be covered by `serverNames`, and the certificate must
be assigned to the node before nginx can serve it.

1. Panel **Certificates → Add domain**: choose the zone (usually resolved
   automatically), enter `node1.example.com`; enable include wildcard if
   needed. Create.
2. **Test issue**: runs the full ACME/DNS-01 flow but updates only the staging
   current pointer, never production. Use it to verify DNS and CAA without
   consuming the production limit.
3. After it succeeds, **Issue** and type the exact domain in the confirmation.
   Let's Encrypt production allows 5 certificates per week per domain; do not
   retry in a loop.
4. Node page **Certificates** tab: check `node1.example.com`, choose
   **Production** (default), and **Save assignment**.
5. Wait for the pull: the panel shows `cert_synced_at` and `nginx_ok=1`. The
   node writes the certificate to `/etc/vela/certs/<domain path>/current/`,
   renders the nginx decoy config, runs `nginx -t`, and reloads nginx. The
   traffic-forwarding engine is not restarted.

Verify:

```bash
curl -I http://node1.example.com     # 301 to https
curl -I https://node1.example.com    # 200, valid certificate (no -k)
```

With staging, test clients must trust the Let's Encrypt staging root; staging
certificates are not renewed and are swept after 7 days. Production
certificates renew automatically from the daily 03:17 UTC cron, and the node
follows without a new assignment.

#### 5.6 Create a user, issue a subscription, verify a client

1. **Users → Add user**: username, status, optional expiry; under **Access by
   node**, select the node and the allowed inbounds/outbounds; **Create user**.
   `BLOCK` is not offered as an exit.
2. Wait for `applied_hash == desired_hash` (next heartbeat plus apply).
3. In the user list, **Share** → **Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   This URL is a bearer capability: anyone with it can fetch the
   subscription. If it leaks, press **Rotate** on the same card; the old URL
   stops working immediately.
4. Import it:
   - v2rayN / NekoBox / Shadowrocket / Hiddify: import the URL and get the
     base64 VLESS list;
   - Clash Verge / FlClash / mihomo: a user agent containing
     `clash`/`mihomo`/`stash` gets a mihomo profile; `?target=clash` forces it;
   - `?target=uri` forces the VLESS list.

   **Names → Subscription title** gives the profile a display name (for
example `Vela · {username}`; fields `{username}`, `{status}`). It travels as
a `profile-title: base64:…` header, which v2rayN and Clash Verge display;
leaving it empty sends no header and keeps the old bytes exactly.
5. Probe from the client side:

   ```bash
   curl https://api.ipify.org        # must return the node's egress IP
   curl https://node1.example.com/   # must be 200 with a valid certificate
   ```

   Inside and outside the tunnel you see the same `tlsserver` certificate:
   REALITY relays non-REALITY traffic to the nginx decoy. The browser should
   show the green "Your Connection is secure" card with the visitor's egress
   IP.

The node page **Links** tab lists the available links per endpoint; extra
variants for the same inbound (CDN front, another port, different SNI)
override only URI parameters and never enter the runtime config. A node
without a Domain generates no links.

The top-level **Names** page names every generated link from one format
(default `{node} · {subject} → {outbound}`; fields `{node}`, `{node_id}`,
`{inbound}`, `{inbound_tag}`, `{link}`, `{link_id}`, `{outbound}`,
`{outbound_tag}`, `{subject}`, `{protocol}`). A single combination can
override the format on the same page, and an override wins. Renaming only
changes the links clients import — no node re-renders.

### 6. Operations and troubleshooting

| Symptom | Check first | Fix |
|---|---|---|
| Node never appears | DNS is DNS only; published ports 80/443; egress 80/443 and the registry; token copied completely; host clock | Fix the network or mint a new token; `docker compose -f /etc/vela/compose.yaml logs -n 50` |
| Node exists but `health` is wrong | `last_error`, `applied_hash` vs `desired_hash` | Read the node log; the node validates the config before applying it |
| Saved config does not apply | JSON validity; REALITY `privateKey` left empty; `serverNames` covers the domain | Fix and save; the node keeps the previous working config |
| `nginx_ok=0` | `nginx_error` | The decoy's TLS library is inside the image; check which tag runs and rebuild |
| Certificate issuance fails | `issue_runs` phase/error; DNS token zone scope; CAA; LE rate limit | Run Test issue first; do not loop production failures |
| Node never receives a certificate | Assignment checked; environment correct; `cert_etag` stuck | Re-save the assignment; compare the manifest ETag |
| Empty subscription | User disabled/expired; no inbound/outbound access; node has no address | Fix access or status; an empty body is 200, not 404 |
| Clash connects but a browser page does not | Client supports REALITY + `support-x25519mlkem768`; chrome fingerprint | Use the generated mihomo profile; do not hand-edit the URI |
| WARP preset returns 502 | Cloudflare WARP registration API reachable | Retry; the panel never writes half a config |

Node maintenance:

- **Refresh Geodata**: downloads full `geoip.dat`/`geosite.dat` from the
  upstream rules-dat release, verifies, and restarts the traffic-forwarding
  engine. It installs once unconditionally, then every 7 days while the
  config uses `geoip:`/`geosite:`.
- The action is visible in the node header and in
  `GET /api/admin/nodes/<id>/sync` under `actions`.
- **The engine is not updated from the panel.** Xray ships inside the image;
  upgrade by replacing the image (5.2).

Deleting a node: **Delete** removes the node's token, config, user access,
endpoint registry, REALITY keys, and certificate assignment. Certificate
domains and issuance history are domain-scoped and unaffected. The machine
keeps running its last config; destroy it separately. Re-generating a token
invalidates the old one immediately; an existing node must update
`node.toml` before it can reconnect.

Backups: at minimum `KEY_SECRET`, `.env.production`, and D1 (export or
point-in-time restore in the Cloudflare dashboard). D1 holds the state and the
certificate artifacts. Without `KEY_SECRET`, the stored
REALITY/certificate/ACME private keys cannot be decrypted. Certificates can be
reissued; private keys cannot.

### 7. Security boundaries and known limitations

- `ADMIN_KEY` is root-equivalent; Cloudflare Access is an extra gate, not a
  replacement.
- `KEY_SECRET` is not rotatable. Rotating it makes every stored node key,
  certificate key, and ACME account unreadable.
- Node tokens are stored as hashes and shown once; the token file inside
  the `vela-etc` volume (`/etc/vela/node.toml`) must stay 0600.
- A subscription URL is a capability credential; leaking it hands that user's
  subscription to the holder. Rotate promptly.
- cloud-init puts the token in user-data and provider metadata; do not use an
  untrusted provider.
- `expire` only affects subscription eligibility (an expired user gets an
  empty subscription); `status=disabled` removes the user from the
  traffic-forwarding engine config.
- The Clash subscription contains only `proxies`, one `SELECT` group, and a
  `MATCH` rule. Add destination-based routing in the client.
- If a REALITY private key cannot derive a public key (for example a
  placeholder was left in the config), the link has no `pbk` and cannot
  complete the REALITY handshake.
- Deleting a node does not wipe the machine's applied config; decommission
  the host separately.
- The nginx decoy config and `index.html` are generated/managed by the
  server. Removing the marker from `index.html` makes it custom, but image
  upgrades refresh unmodified pages.
- The decoy is TLS 1.3 + `X25519MLKEM768:X25519` with no non-PQ fallback, and
  the image is the only place that is configured.
- `X-Vela-Server` is the server identity header (the older
  `X-Lessv-Node` is still accepted) and `/dev/shm/lessv-decoy.sock` is
  REALITY's `dest`: both are frozen protocol values, not product names.
- `BLOCK` must be uppercase; lowercase `block` is treated as a routable exit.
- WARP registration uses Cloudflare's app API; a failure returns 502 and never
  writes half a config. Every preset preview registers a new device, and the
  panel stores no device credentials.
- GeoIP uses the full rules-dat edition; the lite edition cannot serve
  arbitrary `geoip:` region rules.
- Staging certificates are not renewed and are swept after 7 days; a
  long-lived test node must run Test issue again.
- This manual describes protocol 3 and the `vela-server` image; check the
  server repository for the current image tags.

### 8. Further reading

- Node ↔ plane protocol: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Certificates, nginx, and failure handling: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Architecture, development, tests, releases: [`docs/dev/`](docs/dev/README.md)

---

<a id="fa"></a>
## فارسی

### ۱. Vela چیست

Vela یک صفحهٔ مدیریت خودمیزبان برای سرویس هدایت ترافیک است. صفحهٔ کنترل
روی Cloudflare Workers اجرا می‌شود؛ پنل مدیریت یک SPA React زیر `/admin`
است؛ هر گره تصویر `vela-server` را که در
[LessV-Node](https://github.com/realumino/vela-server) نگهداری می‌شود اجرا
می‌کند. گره‌ها پیکربندی و گواهی‌های موردنظر خود را از صفحهٔ کنترل می‌کشند.
صفحهٔ کنترل هرگز به گره متصل نمی‌شود.

```
مرورگر ── /admin ─────────────► Worker (Hono + SPA ایستا)
                                  │  /api/admin/*  ← ADMIN_KEY
                                  │  /api/node/*   ← توکن گره
                                  │  /sub/{token}  ← توکن اشتراک
                                  ▼
                                 D1 (وضعیت و گواهی‌ها) · Workflow (ACME)

کاربر ── /sub/{token} ──► اشتراک ──► پیوندها (رندر از D1)

گره ── هستهٔ ابزار هدایت ترافیک (REALITY :443) ──► vela-server (تصویر)
       ▲ سایت فریبندهٔ nginx (سوکت یونیکس) │
       └── فایل‌های گواهی ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

فقط یک توپولوژی گره پشتیبانی می‌شود: هستهٔ ابزار هدایت ترافیک با REALITY
روی 443 گوش می‌دهد و `dest` آن به سوکت یونیکس محلی
`/dev/shm/lessv-decoy.sock` اشاره می‌کند؛ nginx فقط روی همان سوکت سایت
فریبنده را سرو می‌کند و پورت 80 را به HTTPS هدایت می‌کند. گواهی‌ها متعلق
به nginx هستند؛ هستهٔ ابزار هدایت ترافیک گواهی ندارد. پورت 443 همیشه مال
هستهٔ ابزار هدایت ترافیک است—هرگز nginx را روی 443 قرار ندهید.

### ۲. پیش‌نیازها

| مورد | نیاز |
|---|---|
| Cloudflare | یک zone متصل؛ Workers، D1 و Workflows در دسترس |
| ماشین محلی | Node.js 22 LTS+ و npm |
| میزبان صفحهٔ کنترل | مثلاً `cp.example.com`، با Cloudflare (Custom Domain) |
| میزبان گره | مثلاً `node1.example.com`، فقط **DNS** (ابر خاکستری)، به IP گره |
| ماشین گره | هر لینوکسی با Docker و افزونهٔ compose، دسترسی root، پورت 80 و 443 آزاد |
| خروجی | گره به 80/443 دسترسی دارد: رجیستری تصویر و HTTPS صفحهٔ کنترل |
| پشتیبان | `KEY_SECRET`، `.env.production`، پشتیبان D1 و توکن‌های گره |

میزبان فقط یک کانتینر و یک تصویر دارد. هسته، nginx و کتابخانهٔ TLS پساکوانتومی
داخل همان تصویر هستند، پس توزیع میزبان و نسخهٔ OpenSSL آن اهمیتی ندارد: سایت
فریبنده فقط `X25519MLKEM768:X25519` را ارائه می‌دهد و **هیچ بازگشت به تبادل
کلید کلاسیک ندارد**؛ تصویری که این کار را نمی‌تواند در apply شکست می‌خورد، نه
اینکه بی‌صدا تنزل کند.

ترتیب پیشنهادی: ابتدا Worker را مستقر کنید، سپس در صورت تمایل Cloudflare
Access را فعال کنید، و در آخر گره اضافه کنید.

### ۳. استقرار Cloudflare Worker

#### ۳.۱ گرفتن کد و نصب وابستگی‌ها

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### ۳.۲ ساخت پیکربندی محلی wrangler

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

در `wrangler.jsonc` مقدار `routes` را به میزبان پنل خود تغییر دهید:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

قالب از قبل D1، Workflow، cron روزانه و دارایی‌های SPA را می‌بندد.
`workers_dev: false` و `preview_urls: false` را حفظ کنید: پنل باید دقیقاً یک
میزبان عمومی داشته باشد، وگرنه Cloudflare Access قابل دور زدن است.
`wrangler.jsonc` میزبان واقعی و شناسهٔ D1 را دارد که پس از اولین استقرار
نوشته می‌شود، بنابراین در gitignore است.

#### ۳.۳ تولید سه راز

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

آن‌ها را در `.env.production` بنویسید (هرگز commit نکنید):

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY` کلید Bearer برای همهٔ درخواست‌های `/api/admin/*` و ورود SPA
  است. معادل root است؛ افشای آن یعنی از دست رفتن پنل.
- `KEY_SECRET` کلید AES-256-GCM است که کلیدهای خصوصی REALITY، گواهی‌ها و
  حساب ACME را در پایگاه داده مهر می‌کند. **قابل چرخش نیست**: با چرخش آن همهٔ
  کلیدهای ذخیره‌شده ناخوانا می‌شوند. یک‌بار تولید و به‌صورت آفلاین پشتیبان
  بگیرید.
- برای توسعهٔ محلی از `.dev.vars` و برای تولید از `.env.production` استفاده
  کنید؛ هرگز یک مقدار را دوباره به کار نبرید.

#### ۳.۴ ساخت توکن DNS API

داشبورد Cloudflare → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit` و `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → همان zone ای که نام‌های گواهی
  در آن هستند

مقدار را در `CF_DNS_API_TOKEN` در `.env.production` بگذارید. این توکن را
Worker برای ساخت/پاک‌سازی رکوردهای TXT `_acme-challenge` و فهرست zoneها
استفاده می‌کند؛ با اعتبارنامهٔ `wrangler login` یکی نیست.

#### ۳.۵ استقرار

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy` به ترتیب: SPA را می‌سازد → `wrangler deploy` (بار اول D1 را
می‌سازد و شناسه‌اش را می‌نویسد و Custom Domain را متصل می‌کند) → migrationهای
D1 راه دور را اعمال می‌کند → `https://<میزبان-پنل>/api/health` باید 200
بدهد. اولین استقرار فقط می‌تواند رازها را از `--secrets-file` بگیرد، چون
`wrangler secret put` به Worker ای که هنوز وجود ندارد دسترسی ندارد.

#### ۳.۶ بررسی

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

`https://cp.example.com/admin` را باز کنید و `ADMIN_KEY` را بچسبانید. باز شدن
صفحه فقط یعنی SPA سرو می‌شود؛ فهرست شدن گره‌ها یعنی D1 و API مدیریت کار
می‌کنند.

#### ۳.۷ ارتقا، بازگشت و تغییر رازها

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- بازگشت کد: `npx wrangler rollback`. D1 را برنمی‌گرداند؛ migrationها باید
  سازگار با نسخهٔ قبل بمانند.
- تغییر راز بعدی: `npx wrangler secret put <NAME>`.
- `KEY_SECRET` چرخانده نمی‌شود. `ADMIN_KEY` را می‌توان چرخاند؛ پس از آن همهٔ
  مرورگرها و اسکریپت‌ها باید به‌روزرسانی شوند.
- بررسی ساخت محلی: `npm run deploy -- --dry-run` (بدون ابر).

### ۴. Cloudflare Access (توصیه‌شده)

Cloudflare Access یک لایهٔ هویت در لبهٔ Cloudflare اضافه می‌کند. این لایه
**جایگزین** `ADMIN_KEY` نیست: Worker همچنان کلید Bearer می‌خواهد؛ Access فقط
جلوی رسیدن درخواست‌های تأییدنشده به Worker را می‌گیرد. ابتدا Worker را مستقر
کنید، بعد Access را فعال کنید، چون اسکریپت استقرار و cloud-init هر دو به
`/api/health` نیاز دارند.

#### ۴.۱ چه چیزی محافظت شود و چه چیزی نه

| مسیر | پشت Access؟ | دلیل |
|---|---|---|
| `/admin*` | **بله** | SPA مدیریت و دارایی‌های ایستا؛ فقط انسان وارد می‌شود |
| `/api/admin*` | **بله** | API مدیریت؛ مرورگر از نشست Access و اسکریپت از service token استفاده می‌کند |
| `/api/node/*` | **نه** | سرور گره فقط Bearer token می‌فرستد و Access را نمی‌فهمد؛ محافظت یعنی قطع همهٔ گره‌ها |
| `/sub/*` | **نه** | کلاینت‌های اشتراک (v2rayN، Clash، Shadowrocket و…) Access را انجام نمی‌دهند؛ محافظت یعنی قطع همهٔ اشتراک‌ها |
| `/api/health` | **نه** | اسکریپت استقرار و cloud-init برای بررسی دسترسی از آن استفاده می‌کنند؛ بدنه فقط یک ثابت است |
| میزبان گره `:443` | **موضوعیت ندارد** | رکورد A گره DNS only است و ترافیک از Cloudflare نمی‌گذرد؛ فایروال گره فقط 80/443 را باز می‌کند |

اگر Access مسیر `/api/health` را ببندد، بررسی نهایی `npm run deploy` و حلقهٔ انتظار cloud-init هر دو شکست می‌خورند؛ آن را عمومی نگه دارید.

روش زیر یک برنامهٔ کل میزبان برای سطح مدیریت و برنامه‌های Bypass برای سه مسیر عمومی می‌سازد؛ جدول بالا نتیجهٔ نهایی است.

قاعده: **فقط سطح مدیریت را محافظت کنید**. سطح گره، اشتراک و سلامت عمومی
می‌مانند؛ هر کدام اعتبارنامهٔ خود را دارند (توکن گره، توکن اشتراک، یا هیچ).

#### ۴.۲ ساخت یک برنامهٔ Access برای کل میزبان

برای `/admin` و `/api/admin` دو برنامهٔ Access جدا نسازید: دو برنامه دو توکن
برنامه صادر می‌کنند و درخواست‌های API از SPA ممکن است دوباره به چالش بیفتند.
یک برنامه برای کل میزبان بسازید تا هر دو یک نشست Access داشته باشند.

Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:

- Domain: `cp.example.com`
- Path: **خالی** (کل میزبان محافظت می‌شود؛ نشانی برنامه
  `https://cp.example.com` است)
- Session Duration: مثلاً ۲۴ ساعت
- Identity providers: One-time PIN (پیش‌فرض) یا SSO خودتان
- Policy: Action `Allow`، Include `Emails` → نشانی شما

سیاست Service Auth را در گام ۴.۴ به همین برنامه اضافه کنید.

#### ۴.۳ ساخت برنامه‌های Bypass برای مسیرهای عمومی

برای هر مسیری که باید عمومی بماند، یک برنامهٔ Self-hosted and private دیگر با
همان Domain، مسیر زیر و سیاست Action `Bypass`، Include `Everyone` بسازید.

| Path | نشانی برنامه |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

مسیرهای مشخص‌تر بر برنامهٔ کل میزبان اولویت دارند؛ `Bypass` یعنی این مسیر
ورود نمی‌خواهد. به برنامه‌های Bypass سیاست `Allow` اضافه نکنید و برای
`/admin` یا `/api/admin` برنامهٔ Bypass نسازید. اگر Bypass مربوط به
`/api/health` جا بیفتد، بررسی استقرار و cloud-init هر دو شکست می‌خورند.

#### ۴.۴ ساخت service token برای اسکریپت‌ها

Zero Trust → Access controls → Service credentials → Service tokens → Create:

1. نامی بدهید (مثلاً `vela-ops`) و **Client ID** و **Client Secret** را
   کپی کنید (secret فقط یک‌بار نشان داده می‌شود).
2. به **برنامهٔ کل میزبان** برگردید (نه برنامهٔ Bypass) و سیاستی اضافه کنید:
   Action `Service Auth`، Include `Service Token` → همان توکن.
3. اسکریپت‌ها هم هدرهای Access و هم Bearer Worker را می‌فرستند:

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

مرورگر این هدرها را دستی نمی‌فرستد؛ کوکی Access این کار را می‌کند. service
token یک اعتبارنامهٔ بلندمدت است: آن را در مدیر رمز یا فایل 0600 نگه دارید،
نه در مخزن، تاریخچهٔ شل یا گزارش‌ها. در صورت افشا، در Access آن را بچرخانید.

#### ۴.۵ بررسی مرز Access

```bash
# باید 200 باشد، نه هدایت به ورود Access
curl -i https://cp.example.com/api/health

# باید محتوای اشتراک (یا 200 خالی) باشد، نه Access
curl -i https://cp.example.com/sub/<token>

# باید 401 JSON خود Worker را بدهد، نه صفحهٔ ورود Access
curl -i -X POST https://cp.example.com/api/node/enroll

# API مدیریت: فقط ADMIN_KEY را Access می‌گیرد؛ با هر دو اعتبارنامه 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

نکته‌ها:

- Access فقط در لبهٔ Cloudflare اثر دارد؛ `npm run dev` روی پورت محلی 8787
  محافظت‌شده نیست.
- اگر `workers.dev`، preview URL یا مسیر دیگری وجود داشته باشد، Access دور
  زده می‌شود. قالب آن‌ها را خاموش کرده؛ روشنشان نکنید.
- Access جای `ADMIN_KEY` را نمی‌گیرد؛ دو دروازهٔ مستقل‌اند.
- از `Bypass` فقط برای سه مسیر عمومی (`/sub/*`، `/api/node/*`،
  `/api/health`) استفاده کنید؛ هرگز برای `/admin` یا `/api/admin` Bypass
  نسازید—سطح مدیریت بی‌محافظت می‌شود.
- میزبان گره از Cloudflare عبور نمی‌کند، پس Access از آن محافظت نمی‌کند.
  امنیت گره یعنی فایروال حداقلی 80/443، بدون SSH با رمز، و وصله‌های به‌موقع.

### ۵. افزودن گره

#### ۵.۱ ساخت ردیف گره و توکن

پنل: **Nodes → Add node**. شناسه باید ۱ تا ۳۲ حرف کوچک یا رقم باشد (مثلاً
`node1`)؛ برچسب آزاد است. پس از ساخت، **Domain** گره را به
`node1.example.com` تغییر دهید و ذخیره کنید—این دامنه در `serverNames` مربوط
به REALITY و همهٔ پیوندهای اشتراک استفاده می‌شود.

در صفحهٔ گره، **Re-generate token** (برای اولین توکن هم همین) → تأیید → توکن
را از پنجره کپی کنید. پنل فقط هش را ذخیره می‌کند و متن اصلی یک‌بار نشان داده
می‌شود. بستن پنجره یعنی از دست رفتن آن؛ توکن جدید بسازید (توکن قبلی فوراً
بی‌اعتبار می‌شود).

معادل API:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

اول DNS را بسازید: رکورد A برای `node1.example.com` به IP گره،
**فقط DNS** (ابر خاکستری). REALITY و nginx هر دو به 443 مستقیم نیاز دارند؛
رکوردی که از Cloudflare عبور کند تونل را خراب می‌کند.

#### ۵.۲ گرفتن تصویر و اجرای کانتینر

میزبان فقط Docker با افزونهٔ compose و خود تصویر را لازم دارد؛ بقیه داخل
کانتینر است.

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# enroll یک‌باره: توکن از stdin می‌آید، نه از فهرست آرگومان‌ها
printf '%s\n' '<paste node token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

فقط دو پورت منتشر می‌شود و چیز دیگری لازم نیست باز شود. `vela-etc` هویت و
درخت گواهی را دارد؛ `vela-state` فایل وضعیت، پیکربندی زنده و geodata را.
از دست دادن `vela-etc` یعنی enroll دوباره؛ از دست دادن `vela-state` فقط یک
همگام‌سازی هزینه دارد. گزارش‌ها:

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

ارتقا: tag را در فایل compose عوض کنید و `docker compose up -d` بزنید، یا
یک به‌روزرسان از نوع watchtower این کار را بکند. تصویر هسته، nginx و سرور را
با خود دارد، پس ارتقا هر سه را عوض می‌کند؛ فایلی که دستی داخل کانتینر عوض
شده باشد در بازسازی بعدی ناپدید می‌شود و این عمدی است. geodata همچنان از پنل
(**Maintenance → Refresh Geodata**) تازه می‌شود.

#### ۵.۳ روش ب: cloud-init

پنل خود cloud-config را می‌سازد: سندی یک‌بارمصرف برای Alpine 3.22+ / OpenRC با
cloud-init که نیازی به ویرایش ندارد. سقف‌های BBR و fd را بالا می‌برد، Docker و
nftables را نصب می‌کند (فقط 80/443)، sshd را غیرفعال و حذف می‌کند، فایل compose
را می‌نویسد، یک‌بار enroll می‌کند و سرویس را بالا می‌آورد. پس از اولین بوت،
گره SSH ندارد؛ مدیریت از پنل است. گرهٔ خراب را immutable بدانید: نابود و
بازسازی کنید.

مراحل:

1. طبق ۵.۱ گره، Domain و DNS را بسازید.
2. توکن را بسازید (۵.۱). پنجره، cloud-config آماده را کنار توکن نشان می‌دهد —
   شناسهٔ گره، نشانی پنل، تصویر و entrypoint از پیش پر شده‌اند و توکن فقط
   همان‌جا یک‌بار دیده می‌شود. آن را کپی کنید.
3. در ارائه‌دهندهٔ VPS یک نمونهٔ Alpine 3.22+ بسازید و فایل را به‌عنوان
   **user-data** بدهید. در فایروال ارائه‌دهنده ورودی TCP 80/443 را باز کنید
   (22 لازم نیست؛ قالب sshd را غیرفعال می‌کند).
4. منتظر اولین بوت بمانید. موفقیت یعنی پنل `Health: healthy` و رسیدن
   `Applied` به `Desired` را نشان دهد. در شکست،
   `/var/log/cloud-init-output.log` را از کنسول ارائه‌دهنده بخوانید.
5. بوت اولِ شکست‌خورده را درجا تعمیر نکنید: نمونه را نابود و با شناسه و توکن
   جدید بازسازی کنید. cloud-init یک‌بار اجرا می‌شود.

نکتهٔ امنیتی: توکن در user-data است و متادیتای ارائه‌دهنده آن را نگه می‌دارد.
قالب `/root/vela.env` و فایل‌های bootstrap را روی میزبان پاک می‌کند، ولی
رکورد سمت ارائه‌دهنده را نمی‌تواند پاک کند. فقط روی ارائه‌دهندهٔ مورد اعتماد
استفاده کنید؛ ابطال با حذف ردیف گره در پنل است (توکن فوراً بی‌اعتبار می‌شود).
user-data رندرشده را هرگز commit نکنید.

این قالب مخصوص Alpine/OpenRC است. روی هر توزیع دیگری Docker را خودتان نصب
کنید و ۵.۲ را دنبال کنید؛ اسکریپت‌های OpenRC را روی میزبان systemd نگذارید.

#### ۵.۴ نوشتن اولین پیکربندی هستهٔ ابزار هدایت ترافیک

صفحهٔ گره → **Configuration**:

1. **Base config** → تأیید. ویرایشگر اسکلت را می‌گیرد: `inbounds: []`، یک
   outbound سیاه‌چاله `BLOCK`، routing خالی.
2. **Presets → REALITY inbound → Apply**. پیش‌فرض‌ها از Domain گره و سوکت
   فریبنده می‌آیند:
   - گوش دادن روی 443؛
   - `dest=/dev/shm/lessv-decoy.sock`؛
   - `serverNames=[node1.example.com]`؛
   - `shortId` تصادفی ۸ رقم هگز؛
   - کنترل جریان vision؛
   - `privateKey` خالی؛ پنل هنگام رندر آن را می‌سازد و تزریق می‌کند، پس کلید
     خصوصی هرگز در فرانت‌اند دیده نمی‌شود.
3. JSON ادغام‌شده را بررسی و **Save config** را بزنید. preset خودش ذخیره
   نمی‌شود. فهرست presetها یک outbound WARP و قواعد مسدودسازی
   `geoip:`/`geosite:` هم دارد؛ آن‌ها هم فقط در ویرایشگر ادغام می‌شوند و ذخیرهٔ
   دستی می‌خواهند.

حدود ۶۰ ثانیه بعد، `GET /api/admin/nodes/node1/sync` (یا صفحهٔ گره) باید
`applied_hash == desired_hash` و `health=ok` را نشان دهد. پیکربندی نامعتبر،
پیکربندی سالم قبلی را نگه می‌دارد و خطا را در `last_error` می‌نویسد که پنل
نشان می‌دهد.

برای خروجی‌های بیشتر، outbound اضافه کنید (`freedom` مستقیم است؛ preset WARP
یک masque (CONNECT-IP روی HTTP/3؛ نیازمند Xray 26.10.21 یا جدیدتر) می‌سازد؛ بقیه خروجی بالادست‌اند)، سپس به کاربران اختصاص دهید. `BLOCK`
مسیر پیش‌فرض ترافیک بی‌تطبیق است و هرگز به کاربر داده نمی‌شود. ذخیرهٔ پیکربندی
هر inbound/outbound را در رجیستری ثبت می‌کند؛ تغییر tag دسترسی کاربران،
کلیدهای REALITY و variantهای پیوند را حفظ می‌کند.

`/var/lib/vela/config.json` را روی گره دستی ویرایش نکنید. پنل تنها منبع
حقیقت است؛ کشیدن بعدی فایل را بازنویسی می‌کند.

#### ۵.۵ صدور و تخصیص گواهی

نام میزبان گره باید در `serverNames` باشد و گواهی به گره تخصیص یابد تا nginx
بتواند آن را سرو کند.

1. پنل **Certificates → Add domain**: zone را انتخاب کنید (معمولاً خودکار)،
   `node1.example.com` را وارد کنید؛ در صورت نیاز include wildcard را
   بزنید. Create.
2. **Test issue**: کل جریان ACME/DNS-01 را اجرا می‌کند ولی فقط اشاره‌گر current
   محیط staging را عوض می‌کند، نه تولید را. برای بررسی DNS و CAA بدون مصرف
   سهمیهٔ تولید.
3. پس از موفقیت، **Issue** و در تأیید، دامنهٔ دقیق را تایپ کنید. Let's
   Encrypt تولید هفته‌ای ۵ گواهی برای هر دامنه می‌دهد؛ در حلقه دوباره تلاش
   نکنید.
4. تب **Certificates** صفحهٔ گره: `node1.example.com` را تیک بزنید، محیط
   **Production** (پیش‌فرض) را انتخاب و **Save assignment** را بزنید.
5. منتظر کشیدن بمانید: پنل `cert_synced_at` و `nginx_ok=1` را نشان می‌دهد.
   گره گواهی را در `/etc/vela/certs/<domain path>/current/` می‌نویسد،
   پیکربندی فریبندهٔ nginx را می‌سازد، `nginx -t` و reload می‌کند. هستهٔ ابزار
   هدایت ترافیک راه‌اندازی مجدد نمی‌شود.

بررسی:

```bash
curl -I http://node1.example.com     # 301 به https
curl -I https://node1.example.com    # 200، گواهی معتبر (بدون -k)
```

با staging، کلاینت آزمایشی باید ریشهٔ staging را trust کند؛ گواهی staging
تمدید نمی‌شود و بعد از ۷ روز پاک می‌شود. گواهی تولید با cron روزانهٔ 03:17
UTC خودکار تمدید می‌شود و گره بدون تخصیص دوباره پیروی می‌کند.

#### ۵.۶ ساخت کاربر، صدور اشتراک، بررسی کلاینت

1. **Users → Add user**: نام کاربری، وضعیت، انقضای اختیاری؛ در **Access by
   node** گره را انتخاب و inbound/outboundهای مجاز را تیک بزنید؛ **Create
   user**. `BLOCK` در فهرست خروجی‌ها نمی‌آید.
2. منتظر `applied_hash == desired_hash` بمانید (heartbeat بعدی + apply).
3. در فهرست کاربران **Share** → **Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   این URL یک capability bearer است: هر کس آن را داشته باشد اشتراک را
   می‌گیرد. در صورت افشا، روی همان کارت **Rotate** را بزنید؛ URL قبلی فوراً
   بی‌اعتبار می‌شود.
4. وارد کردن:
   - v2rayN / NekoBox / Shadowrocket / Hiddify: URL را وارد کنید و فهرست
     base64 VLESS را بگیرید؛
   - Clash Verge / FlClash / mihomo: user-agent شامل
     `clash`/`mihomo`/`stash` پروفایل mihomo می‌گیرد؛ `?target=clash` آن را
     مجبور می‌کند؛
   - `?target=uri` فهرست VLESS را مجبور می‌کند.

   **Names → Subscription title** یک نام نمایشی به پروفایل می‌دهد (مثلاً
   `Vela · {username}`؛ فیلدها `{username}`، `{status}`). این نام در هدر
   `profile-title: base64:…` می‌آید که v2rayN و Clash Verge نشان می‌دهند؛
   خالی گذاشتن آن هیچ هدری نمی‌فرستد و پاسخ دقیقاً مثل قبل می‌ماند.
5. آزمون از سمت کلاینت:

   ```bash
   curl https://api.ipify.org        # باید IP خروجی گره را بدهد
   curl https://node1.example.com/   # باید 200 با گواهی معتبر باشد
   ```

   داخل و بیرون تونل همان گواهی `tlsserver` دیده می‌شود: REALITY ترافیک غیر
   REALITY را به سایت فریبندهٔ nginx می‌فرستد. مرورگر باید کارت سبز
   "Your Connection is secure" را با IP خروجی بازدیدکننده نشان دهد.

تب **Links** صفحهٔ گره پیوندهای موجود را به‌ازای هر endpoint فهرست می‌کند؛
variantهای اضافی همان inbound (CDN، پورت دیگر، SNI متفاوت) فقط پارامترهای URI
را عوض می‌کنند و هرگز وارد پیکربندی زمان اجرا نمی‌شوند. گرهٔ بدون Domain هیچ
پیوندی نمی‌سازد.

صفحهٔ **Names** همهٔ پیوندهای تولیدشده را با یک رشتهٔ قالب نام‌گذاری می‌کند
(پیش‌فرض `{node} · {subject} → {outbound}`؛ فیلدها: `{node}`، `{node_id}`،
`{inbound}`، `{inbound_tag}`، `{link}`، `{link_id}`، `{outbound}`،
`{outbound_tag}`، `{subject}`، `{protocol}`). برای یک ترکیب می‌توان در همان
صفحه نام جدا گذاشت و آن نام بر قالب اولویت دارد. تغییر نام فقط پیوندهایی را
که کلاینت وارد می‌کند عوض می‌کند و گره دوباره رندر نمی‌شود.

### ۶. عملیات و عیب‌یابی

| نشانه | اول بررسی کنید | رفع |
|---|---|---|
| گره هرگز ظاهر نمی‌شود | DNS فقط DNS باشد؛ انتشار 80/443؛ خروجی 80/443 و رجیستری؛ توکن کامل؛ ساعت میزبان | شبکه را درست کنید یا توکن جدید بسازید؛ `docker compose -f /etc/vela/compose.yaml logs -n 50` |
| گره هست ولی `health` درست نیست | `last_error`، `applied_hash` در برابر `desired_hash` | گزارش گره (گره پیش از اعمال، پیکربندی را بررسی می‌کند) |
| پیکربندی ذخیره شد ولی اعمال نشد | اعتبار JSON؛ خالی بودن `privateKey`؛ پوشش `serverNames` | درست کنید و Save؛ گره پیکربندی سالم قبلی را نگه می‌دارد |
| `nginx_ok=0` | `nginx_error` | کتابخانهٔ TLS سایت فریبنده داخل تصویر است؛ tag اجراشده را بررسی و تصویر را بازسازی کنید |
| صدور گواهی شکست می‌خورد | phase/error در `issue_runs`؛ دامنهٔ zone توکن DNS؛ CAA؛ سهمیهٔ LE | اول Test issue؛ شکست تولید را در حلقه تکرار نکنید |
| گره گواهی نمی‌گیرد | تیک تخصیص؛ محیط درست؛ گیر کردن `cert_etag` | assignment را دوباره ذخیره کنید؛ ETag manifest را مقایسه کنید |
| اشتراک خالی است | کاربر disabled/منقضی؛ نبود دسترسی inbound/outbound؛ نبود address گره | دسترسی یا وضعیت را درست کنید؛ بدنهٔ خالی 200 است نه 404 |
| Clash وصل می‌شود ولی صفحهٔ وب باز نمی‌شود | پشتیبانی کلاینت از REALITY + `support-x25519mlkem768`؛ fingerprint کروم | از پروفایل mihomo تولیدشده استفاده کنید؛ URI را دستی تغییر ندهید |
| preset WARP خطای 502 | دسترسی به API ثبت WARP | دوباره تلاش کنید؛ پنل هرگز پیکربندی نیمه‌کاره نمی‌نویسد |

نگهداری گره:

- **Refresh Geodata**: نسخهٔ full `geoip.dat`/`geosite.dat` را از
  انتشار rules-dat بالادست می‌گیرد، بررسی و هستهٔ ابزار هدایت ترافیک را
  restart می‌کند. بار اول بی‌قید نصب می‌شود، بعد تا وقتی پیکربندی `geoip:`/`geosite:` دارد هر ۷ روز.
- وضعیت این کار در header گره و در `actions` مسیر
  `GET /api/admin/nodes/<id>/sync` دیده می‌شود.
- **هسته از پنل به‌روز نمی‌شود**: هسته داخل تصویر است؛ ارتقا یعنی عوض کردن
  تصویر (۵.۲).

حذف گره: **Delete** توکن، پیکربندی، دسترسی کاربران، رجیستری endpoint، کلیدهای
REALITY و تخصیص گواهی آن گره را حذف می‌کند. دامنه‌های گواهی و تاریخچهٔ صدور
در سطح دامنه‌اند و دست‌نخورده می‌مانند. ماشین آخرین پیکربندی را ادامه می‌دهد؛
جداگانه نابودش کنید. تولید دوبارهٔ توکن، توکن قبلی را فوراً بی‌اعتبار می‌کند؛
گرهٔ موجود باید `node.toml` را به‌روز کند تا دوباره وصل شود.

پشتیبان: حداقل `KEY_SECRET`، `.env.production` و D1 (export یا
point-in-time restore در داشبورد). D1 هم وضعیت و هم محصول گواهی را دارد.
بدون `KEY_SECRET`، کلیدهای خصوصی REALITY/گواهی/ACME قابل رمزگشایی نیستند.
گواهی‌ها را می‌توان دوباره صادر کرد؛ کلیدهای خصوصی را نه.

### ۷. مرزهای امنیتی و محدودیت‌های شناخته‌شده

- `ADMIN_KEY` معادل root است؛ Cloudflare Access دروازهٔ اضافی است، نه
  جایگزین.
- `KEY_SECRET` قابل چرخش نیست. چرخش آن همهٔ کلیدهای گره، گواهی و حساب ACME
  را ناخوانا می‌کند.
- توکن گره فقط هش ذخیره می‌شود و یک‌بار نمایش داده می‌شود؛ فایل توکن داخل
  جلد `vela-etc` (`/etc/vela/node.toml`) باید 0600 بماند.
- URL اشتراک یک اعتبارنامهٔ capability است؛ افشای آن یعنی دادن اشتراک آن
  کاربر. سریع Rotate کنید.
- cloud-init توکن را در user-data و متادیتای ارائه‌دهنده می‌گذارد؛ از
  ارائه‌دهندهٔ نامطمئن استفاده نکنید.
- `expire` فقط صلاحیت اشتراک را تغییر می‌دهد (کاربر منقضی اشتراک خالی
  می‌گیرد)؛ `status=disabled` کاربر را از پیکربندی هستهٔ ابزار هدایت
  ترافیک حذف می‌کند.
- اشتراک Clash فقط `proxies`، یک گروه `SELECT` و قاعدهٔ `MATCH` دارد.
  مسیریابی مقصد را در کلاینت اضافه کنید.
- اگر از کلید خصوصی REALITY نتوان کلید عمومی گرفت (مثلاً placeholder در
  پیکربندی مانده باشد)، پیوند `pbk` ندارد و handshake کامل نمی‌شود.
- حذف گره پیکربندی اعمال‌شده روی ماشین را پاک نمی‌کند؛ میزبان را جداگانه
  از رده خارج کنید.
- پیکربندی فریبنده و `index.html` توسط سرور ساخته/مدیریت می‌شوند. حذف نشانگر
  از `index.html` آن را سفارشی می‌کند، ولی ارتقای تصویر صفحه‌های
  اصلاح‌نشده را تازه می‌کند.
- سایت فریبنده TLS 1.3 + `X25519MLKEM768:X25519` است و بازگشت غیر PQ ندارد؛
  این تنها جایی که تنظیم می‌شود خود تصویر است.
- `X-Vela-Server` هدر هویت سرور است (نام قدیمی `X-Lessv-Node` هم پذیرفته
  می‌شود) و `/dev/shm/lessv-decoy.sock` همان `dest` REALITY است: هر دو مقدار
  ثابت پروتکل‌اند، نه نام محصول.
- `BLOCK` باید بزرگ باشد؛ `block` کوچک به‌عنوان خروجی قابل مسیریابی رفتار
  می‌کند.
- ثبت WARP از API اپ Cloudflare استفاده می‌کند؛ شکست 502 می‌دهد و هرگز
  پیکربندی نیمه نمی‌نویسد. هر پیش‌نمایش preset یک دستگاه تازه ثبت می‌کند و
  پنل هیچ اعتبارنامهٔ دستگاهی نگه نمی‌دارد.
- GeoIP از نسخهٔ full rules-dat استفاده می‌کند؛ نسخهٔ lite برای `geoip:`
  هر منطقه‌ای کافی نیست.
- گواهی staging تمدید نمی‌شود و بعد از ۷ روز پاک می‌شود؛ گرهٔ آزمایشی
  بلندمدت باید دوباره Test issue بگیرد.
- این راهنما پروتکل ۳ و تصویر `vela-server` را توصیف می‌کند؛ tagهای فعلی
  تصویر را در مخزن سرور ببینید.

### ۸. مطالعهٔ بیشتر

- پروتکل گره ↔ پنل: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- گواهی، nginx و رفع خرابی: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- معماری، توسعه، آزمون و انتشار: [`docs/dev/`](docs/dev/README.md)

---

<a id="ru"></a>
## Русский

### 1. Что такое Vela

Vela — саморазмещаемая панель управления сервисом пересылки трафика.
Панель управления работает на Cloudflare Workers; административный SPA
отдаётся по `/admin`; на каждом узле запущен образ `vela-server` из
[LessV-Node](https://github.com/realumino/vela-server). Узлы сами забирают
желаемую конфигурацию и сертификаты с панели. Панель никогда не подключается
к узлу.

```
Браузер ── /admin ─────────────► Worker (Hono + статический SPA)
                                   │  /api/admin/*  ← ADMIN_KEY
                                   │  /api/node/*   ← токен узла
                                   │  /sub/{token}  ← токен подписки
                                   ▼
                                  D1 (состояние и сертификаты) · Workflow (ACME)

Пользователь ── /sub/{token} ──► подписка ──► ссылки (рендер из D1)

Узел ── ядро инструмента пересылки трафика (REALITY :443) ──► vela-server (образ)
        ▲ сайт-заглушка nginx (Unix-сокет) │
        └── файлы сертификатов ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

Поддерживается только одна топология узла: ядро инструмента пересылки
трафика с REALITY слушает 443, а `dest` указывает на локальный Unix-сокет
`/dev/shm/lessv-decoy.sock`; nginx отдаёт заглушку только на этом сокете
и перенаправляет порт 80 на HTTPS.
Сертификаты принадлежат nginx; у ядра инструмента пересылки трафика их
нет. Порт 443 всегда принадлежит ядру инструмента пересылки трафика —
никогда не заставляйте nginx слушать 443.

### 2. Требования

| Компонент | Требование |
|---|---|
| Cloudflare | Подключённая зона; доступны Workers, D1, Workflows |
| Локальная машина | Node.js 22 LTS+ и npm |
| Имя панели | Например `cp.example.com`, находится за Cloudflare (Custom Domain) |
| Имя узла | Например `node1.example.com`, **только DNS** (серое облако), на IP узла |
| Хост узла | Любой Linux с Docker и плагином compose, root, порты 80 и 443 свободны |
| Исходящий доступ | Узел достигает 80/443: реестр образов и панель по HTTPS |
| Резервные копии | `KEY_SECRET`, `.env.production`, копия D1 и токены узлов |

Хост запускает один контейнер и тянет один образ. Ядро, nginx и
постквантовая TLS-библиотека находятся внутри образа, поэтому дистрибутив
хоста и версия его OpenSSL не важны: заглушка предлагает только
`X25519MLKEM768:X25519` и **не имеет классического отката**, а образ, который
этого не умеет, падает при apply вместо тихого понижения.

Рекомендуемый порядок: развернуть Worker, при желании включить Cloudflare
Access, затем добавлять узлы.

### 3. Развёртывание Cloudflare Worker

#### 3.1 Получить код и установить зависимости

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### 3.2 Создать локальный конфиг wrangler

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

В `wrangler.jsonc` замените `routes` на имя своей панели:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

Шаблон уже привязывает D1, Workflow, ежедневный cron и ресурсы SPA.
Оставьте `workers_dev: false` и `preview_urls: false`: у панели должно быть
ровно одно публичное имя, иначе Cloudflare Access можно обойти.
`wrangler.jsonc` содержит реальное имя и id D1, который записывается после
первого развёртывания, поэтому он в gitignore.

#### 3.3 Сгенерировать три секрета

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

Запишите их в `.env.production` (никогда не коммитьте):

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY` — Bearer-ключ для всех запросов `/api/admin/*` и входа в SPA.
  Он эквивалентен root: утечка означает потерю панели.
- `KEY_SECRET` — ключ AES-256-GCM, которым запечатаны приватные ключи
  REALITY, сертификатов и аккаунта ACME. **Его нельзя менять**: после смены
  все сохранённые ключи станут нечитаемыми. Сгенерируйте один раз и храните
  офлайн-копию.
- Для локальной разработки используйте `.dev.vars`, для продакшена —
  `.env.production`; не повторяйте значения.

#### 3.4 Создать токен DNS API

Панель Cloudflare → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit`, `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → зона, где будут имена сертификатов

Поместите значение в `CF_DNS_API_TOKEN` в `.env.production`. Этот токен Worker
использует для создания и очистки TXT-записей `_acme-challenge` и списка зон;
это не учётные данные `wrangler login`.

#### 3.5 Развернуть

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy` выполняет: сборку SPA → `wrangler deploy` (при первом
запуске создаёт D1, записывает id и привязывает Custom Domain) → применяет
удалённые миграции D1 → требует, чтобы
`https://<хост-панели>/api/health` вернул 200. При первом развёртывании
секреты можно передать только через `--secrets-file`, потому что
`wrangler secret put` не работает с ещё не созданным Worker.

#### 3.6 Проверить

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

Откройте `https://cp.example.com/admin` и вставьте `ADMIN_KEY`. Загрузка
страницы доказывает только работу SPA; список узлов доказывает работу D1 и
admin API.

#### 3.7 Обновление, откат и смена секретов

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- Откат кода: `npx wrangler rollback`. D1 он не откатывает; миграции должны
  оставаться совместимыми с предыдущей версией.
- Смена секрета позже: `npx wrangler secret put <NAME>`.
- `KEY_SECRET` не меняется. `ADMIN_KEY` можно сменить; после этого все
  браузеры и скрипты нужно обновить.
- Локальная проверка сборки: `npm run deploy -- --dry-run` (без облака).

### 4. Cloudflare Access (рекомендуется)

Cloudflare Access добавляет слой идентификации на периметре Cloudflare. Это
**не** замена `ADMIN_KEY`: Worker по-прежнему требует Bearer-ключ; Access лишь
не пускает неаутентифицированные запросы до Worker. Сначала разверните
Worker, затем включайте Access, потому что скрипт развёртывания и cloud-init
обращаются к `/api/health`.

#### 4.1 Что защищать, а что нет

| Путь | За Access? | Почему |
|---|---|---|
| `/admin*` | **Да** | Административный SPA и статические ресурсы; вход только для людей |
| `/api/admin*` | **Да** | Admin API; браузер использует сессию Access, скрипты — service token |
| `/api/node/*` | **Нет** | Сервер узла отправляет только Bearer-токен и не умеет Access; защита отключит все узлы |
| `/sub/*` | **Нет** | Клиенты подписки (v2rayN, Clash, Shadowrocket и т. д.) не проходят Access; защита сломает все подписки |
| `/api/health` | **Нет** | Скрипт развёртывания и cloud-init проверяют им доступность; ответ — константа |
| Имя узла `:443` | **Не применимо** | A-запись узла — DNS only; трафик не идёт через Cloudflare. Брандмауэр узла открывает только 80/443 |

Если Access закроет `/api/health`, финальная проверка `npm run deploy` и цикл ожидания cloud-init завершатся ошибкой; оставьте путь публичным.

Схема ниже использует одно приложение для всего хоста для административной поверхности и Bypass-приложения для трёх публичных путей; таблица выше — итоговый результат.

Правило: **защищайте только административную поверхность**. Поверхности
узлов, подписок и здоровья остаются публичными; у каждой свой учётный
механизм (токен узла, токен подписки или никакой).

#### 4.2 Создать одно приложение Access для всего хоста

Не создавайте отдельные приложения Access для `/admin` и `/api/admin`: два
приложения выдают два токена приложения, и API-запросы SPA могут снова
потребовать аутентификации. Создайте одно приложение на весь хост, чтобы оба
пути делили одну сессию Access.

Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:

- Domain: `cp.example.com`
- Path: **пусто** (защищается весь хост; URL приложения —
  `https://cp.example.com`)
- Session Duration: например 24 часа
- Identity providers: One-time PIN (по умолчанию) или ваш SSO
- Policy: Action `Allow`, Include `Emails` → ваш адрес

Политику Service Auth из шага 4.4 добавьте в это приложение.

#### 4.3 Создать Bypass-приложения для публичных путей

Для каждого пути, который должен остаться публичным, создайте ещё одно
Self-hosted and private приложение с тем же Domain, указанным ниже Path и
политикой Action `Bypass`, Include `Everyone`.

| Path | URL приложения |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

Более конкретные пути имеют приоритет над приложением для всего хоста;
`Bypass` означает, что вход не требуется. Не добавляйте политику `Allow` в
Bypass-приложения и не создавайте Bypass для `/admin` или `/api/admin`. Если
Bypass для `/api/health` отсутствует, проверка при развёртывании и cloud-init
завершатся ошибкой.

#### 4.4 Создать service token для скриптов

Zero Trust → Access controls → Service credentials → Service tokens → Create:

1. Задайте имя (например `vela-ops`) и скопируйте **Client ID** и **Client
   Secret** (секрет показывается один раз).
2. Вернитесь в **приложение для всего хоста** (не в Bypass-приложение) и
   добавьте политику: Action `Service Auth`, Include `Service Token` →
   созданный токен.
3. Скрипты отправляют и заголовки Access, и Bearer Worker:

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

Браузер не добавляет эти заголовки вручную; это делает cookie Access.
Service token — долгоживущий секрет: храните его в менеджере паролей или
файле 0600, но не в репозитории, истории shell или логах. При утечке
перевыпустите его в Access.

#### 4.5 Проверить границу Access

```bash
# Должно быть 200, а не редирект на вход Access
curl -i https://cp.example.com/api/health

# Должен вернуться контент подписки (или пустой 200), а не Access
curl -i https://cp.example.com/sub/<token>

# Должен вернуться 401 JSON от Worker, а не страница входа Access
curl -i -X POST https://cp.example.com/api/node/enroll

# Admin API: только ADMIN_KEY останавливается Access; с обоими — 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

Замечания:

- Access действует только на периметре Cloudflare; локальный
  `npm run dev` на порту 8787 не защищён.
- Если существуют `workers.dev`, preview URL или другой route, Access можно
  обойти. Шаблон их отключает; не включайте.
- Access не заменяет `ADMIN_KEY`; это два независимых барьера.
- Используйте `Bypass` только для трёх публичных путей (`/sub/*`,
  `/api/node/*`, `/api/health`); никогда не добавляйте Bypass для `/admin`
  или `/api/admin`—это откроет административную поверхность.
  Приложения только для административных путей оставляют границу явной.
- Хост узла не проходит через Cloudflare, поэтому Access его не защищает.
  Безопасность узла — минимальный брандмауэр 80/443, SSH без пароля и
  своевременные обновления.

### 5. Добавление узла

#### 5.1 Создать запись узла и токен

Панель: **Nodes → Add node**. Id — от 1 до 32 строчных букв или цифр
(например `node1`); label — произвольный текст. После создания измените
**Domain** узла на `node1.example.com` и сохраните: этот домен попадает в
`serverNames` REALITY и во все ссылки подписки.

На странице узла нажмите **Re-generate token** (это же действие создаёт
первый токен) → подтвердите → скопируйте токен из диалога. Панель хранит
только хеш и показывает открытый текст один раз. После закрытия диалога
токен не восстановить; создайте новый (старый сразу перестанет работать).

Эквивалент через API:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

Сначала создайте DNS: A-запись `node1.example.com` на IP узла,
**только DNS** (серое облако). REALITY и nginx требуют прямого 443;
запись, проходящая через Cloudflare, ломает туннель.

#### 5.2 Получить образ и запустить контейнер

Хосту нужны только Docker с плагином compose и сам образ; всё остальное
работает внутри.

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# одноразовый enroll: токен приходит через stdin, а не в списке аргументов
printf '%s\n' '<paste node token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

Наружу публикуются два порта, больше ничего открывать не нужно. `vela-etc`
хранит идентичность и дерево сертификатов; `vela-state` — файл состояния,
живую конфигурацию и geodata. Потеря `vela-etc` означает повторный enroll,
потеря `vela-state` — одну синхронизацию. Логи:

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

Обновление: смените tag в compose-файле и выполните `docker compose up -d`,
либо поручите это обновлятору вроде watchtower. Образ содержит ядро, nginx и
сам сервер, поэтому обновление заменяет все три; файл, отредактированный
вручную внутри контейнера, исчезнет при следующем пересоздании — так и
задумано. geodata по-прежнему обновляется из панели
(**Maintenance → Refresh Geodata**).

#### 5.3 Вариант B: cloud-init

cloud-config пишет панель: это одноразовый документ для образа Alpine 3.22+ /
OpenRC с cloud-init, и править в нём нечего. Он поднимает лимиты BBR и fd,
ставит Docker и nftables (только 80/443), отключает и удаляет sshd, пишет
compose-файл, один раз выполняет enroll и запускает сервис. После первого
запуска SSH на узле нет; управление идёт из панели. Сломанный узел считается
неизменяемым: уничтожить и пересоздать.

Шаги:

1. Создайте узел, Domain и DNS по 5.1.
2. Выпустите токен (5.1). В окне рядом с токеном лежит готовый cloud-config —
   id узла, адрес панели, образ и entrypoint уже подставлены, а токен виден
   только здесь и только один раз. Скопируйте его.
3. У провайдера VPS создайте инстанс Alpine 3.22+ и передайте файл как
   **user-data**. В брандмауэре провайдера откройте входящие TCP 80/443 (22 не
   нужен; шаблон отключает sshd).
4. Дождитесь первого запуска. Успех — панель показывает `Health: healthy`, а
   `Applied` догоняет `Desired`. При сбое читайте
   `/var/log/cloud-init-output.log` через консоль провайдера.
5. Не чините неудачный первый запуск на месте: уничтожьте инстанс и создайте
   заново с новым id и токеном. cloud-init выполняется один раз.

Безопасность: токен лежит в user-data и остаётся в метаданных провайдера.
Шаблон удаляет `/root/vela.env` и bootstrap-файлы на хосте, но не может
удалить запись у провайдера. Используйте только доверенного провайдера;
отзыв — удаление записи узла в панели (токен сразу перестаёт работать).
Никогда не коммитьте отрендеренный user-data.

Шаблон предназначен для Alpine/OpenRC. На любом другом дистрибутиве
установите Docker сами и следуйте 5.2; не ставьте OpenRC-скрипты на
systemd-хост.

#### 5.4 Первая конфигурация ядра инструмента пересылки трафика

Страница узла → **Configuration**:

1. **Base config** → подтвердить. В редакторе появится скелет:
   `inbounds: []`, один outbound `BLOCK` (blackhole), пустой routing.
2. **Presets → REALITY inbound → Apply**. Значения по умолчанию берутся из
   Domain узла и сокета заглушки:
   - прослушивание 443;
   - `dest=/dev/shm/lessv-decoy.sock`;
   - `serverNames=[node1.example.com]`;
   - случайный 8-значный hex `shortId`;
   - управление потоком vision;
   - `privateKey` пустой; панель генерирует и внедряет его при рендере, поэтому
     приватный ключ не появляется во фронтенде.
3. Проверьте объединённый JSON и нажмите **Save config**. Preset сам не
   сохраняется. В каталоге также есть outbound WARP и правила блокировки по
   `geoip:`/`geosite:`; они тоже только сливаются в редактор и требуют явного
   сохранения.

Через ~60 секунд `GET /api/admin/nodes/node1/sync` (или страница узла) должен
показать `applied_hash == desired_hash` и `health=ok`. Неверная конфигурация
оставляет предыдущую рабочую и записывает ошибку в `last_error`, которую
показывает панель.

Для дополнительных выходов добавьте outbound (`freedom` — прямой; preset WARP
создаёт masque (CONNECT-IP поверх HTTP/3; нужен Xray 26.10.21 или новее); остальные считаются вышестоящими выходами), затем назначьте их
пользователям. `BLOCK` — маршрут по умолчанию для несовпавшего трафика, его
нельзя назначать пользователю. Сохранение конфигурации регистрирует каждый
inbound/outbound в реестре; переименование tag сохраняет доступ пользователей,
ключи REALITY и варианты ссылок.

Не редактируйте `/var/lib/vela/config.json` на узле вручную. Панель —
единственный источник истины; следующее получение перезапишет файл.

#### 5.5 Выпуск и назначение сертификата

Имя узла должно быть покрыто `serverNames`, а сертификат — назначен узлу,
иначе nginx не сможет его отдать.

1. Панель **Certificates → Add domain**: выберите zone (обычно определяется
   автоматически), введите `node1.example.com`; при необходимости включите
   include wildcard. Create.
2. **Test issue**: полный ACME/DNS-01, но обновляется только указатель current
   в staging, production не трогается. Проверка DNS и CAA без расхода
   production-лимита.
3. После успеха **Issue** и введите точный домен в подтверждении. Let's
   Encrypt в production даёт 5 сертификатов в неделю на домен; не повторяйте
   в цикле.
4. Вкладка **Certificates** узла: отметьте `node1.example.com`, выберите
   **Production** (по умолчанию) и **Save assignment**.
5. Дождитесь синхронизации: панель покажет `cert_synced_at` и `nginx_ok=1`.
   Узел пишет сертификат в `/etc/vela/certs/<domain path>/current/`,
   генерирует конфиг заглушки nginx, выполняет `nginx -t` и reload. Ядро
   инструмента пересылки трафика не перезапускается.

Проверка:

```bash
curl -I http://node1.example.com     # 301 на https
curl -I https://node1.example.com    # 200, валидный сертификат (без -k)
```

Со staging тестовый клиент должен доверять корню Let's Encrypt staging;
staging-сертификаты не продлеваются и удаляются через 7 дней. Production
продлевается ежедневным cron в 03:17 UTC, узел следует автоматически без
повторного назначения.

#### 5.6 Создание пользователя, подписка, проверка клиента

1. **Users → Add user**: имя, статус, необязательный срок; в **Access by
   node** выберите узел и разрешённые inbound/outbound; **Create user**.
   `BLOCK` в списке выходов не появляется.
2. Дождитесь `applied_hash == desired_hash` (следующий heartbeat и apply).
3. В списке пользователей **Share** → **Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   Это bearer-capability: любой, у кого есть URL, получает подписку. При
   утечке нажмите **Rotate** на той же карточке; старый URL сразу перестанет
   работать.
4. Импорт:
   - v2rayN / NekoBox / Shadowrocket / Hiddify: импортируйте URL и получите
     base64-список VLESS;
   - Clash Verge / FlClash / mihomo: user-agent с `clash`/`mihomo`/`stash`
     получает профиль mihomo; `?target=clash` форсирует его;
   - `?target=uri` форсирует список VLESS.

   **Names → Subscription title** задаёт отображаемое имя профиля
   (например `Vela · {username}`; поля `{username}`, `{status}`). Оно уходит
   заголовком `profile-title: base64:…`, который показывают v2rayN и Clash
   Verge; пустое значение не отправляет заголовок вовсе и оставляет ответ
   прежним.
5. Проверка со стороны клиента:

   ```bash
   curl https://api.ipify.org        # должен вернуть исходящий IP узла
   curl https://node1.example.com/   # должен быть 200 с валидным сертификатом
   ```

   Внутри и снаружи туннеля виден один и тот же сертификат `tlsserver`:
   REALITY передаёт не-REALITY трафик заглушке nginx. В браузере должна быть
   зелёная карточка "Your Connection is secure" с исходящим IP посетителя.

Вкладка **Links** на странице узла перечисляет доступные ссылки по endpoint'ам;
дополнительные варианты того же inbound (CDN-фронт, другой порт, другой SNI)
меняют только параметры URI и никогда не попадают в runtime-конфигурацию. Узел
без Domain не создаёт ссылок.

Страница **Names** задаёт имена всех сгенерированных ссылок одной строкой
формата (по умолчанию `{node} · {subject} → {outbound}`; поля `{node}`,
`{node_id}`, `{inbound}`, `{inbound_tag}`, `{link}`, `{link_id}`, `{outbound}`,
`{outbound_tag}`, `{subject}`, `{protocol}`). Отдельной комбинации можно задать
своё имя на той же странице, и оно важнее формата. Переименование меняет только
ссылки, которые импортирует клиент; узел не перерендеривается.

### 6. Эксплуатация и устранение неисправностей

| Симптом | Что проверить | Что делать |
|---|---|---|
| Узел не появляется | DNS only; опубликованные 80/443; исходящий 80/443 и реестр; токен скопирован полностью; часы хоста | Исправить сеть или создать новый токен; `docker compose -f /etc/vela/compose.yaml logs -n 50` |
| Узел есть, но `health` неверный | `last_error`, `applied_hash` против `desired_hash` | Лог узла (узел проверяет конфигурацию перед применением) |
| Конфигурация сохранена, но не применяется | Валидность JSON; пустой `privateKey`; `serverNames` покрывает домен | Исправить и сохранить; узел держит предыдущую рабочую конфигурацию |
| `nginx_ok=0` | `nginx_error` | TLS-библиотека заглушки внутри образа; проверьте, какой tag запущен, и пересоберите образ |
| Выпуск сертификата не удался | phase/error в `issue_runs`; зона токена DNS; CAA; лимит LE | Сначала Test issue; не повторять production в цикле |
| Узел не получает сертификат | Отметка назначения; правильное окружение; застрявший `cert_etag` | Пересохранить assignment; сравнить ETag манифеста |
| Пустая подписка | Пользователь disabled/истёк; нет доступа inbound/outbound; у узла нет address | Исправить доступ или статус; пустое тело — это 200, не 404 |
| Clash подключается, а сайт не открывается | Клиент поддерживает REALITY + `support-x25519mlkem768`; fingerprint chrome | Использовать сгенерированный профиль mihomo; не править URI вручную |
| Preset WARP возвращает 502 | Доступность API регистрации WARP | Повторить; панель не пишет половину конфигурации |

Обслуживание узла:

- **Refresh Geodata**: скачивает full `geoip.dat`/`geosite.dat` из
  публикации rules-dat, проверяет и перезапускает ядро инструмента пересылки
  трафика. Первый раз устанавливает безусловно, затем каждые 7 дней, пока в
  конфигурации есть `geoip:`/`geosite:`.
- Статус действия виден в заголовке узла и в `actions` ответа
  `GET /api/admin/nodes/<id>/sync`.
- **Ядро не обновляется из панели.** Ядро входит в образ; обновление — это
  замена образа (5.2).

Удаление узла: **Delete** удаляет токен, конфигурацию, доступы пользователей,
реестр endpoint, ключи REALITY и назначение сертификатов. Домены сертификатов
и история выпуска относятся к домену и не затрагиваются. Машина продолжает
работать с последней конфигурацией; уничтожьте её отдельно. Новый токен сразу
делает старый недействительным; существующий узел должен обновить
`node.toml`, чтобы снова подключиться.

Резервные копии: как минимум `KEY_SECRET`, `.env.production` и D1 (export или
point-in-time restore в панели Cloudflare). В D1 лежат и состояние, и
артефакты сертификатов. Без `KEY_SECRET` приватные ключи
REALITY/сертификатов/ACME не расшифровать. Сертификаты можно выпустить
заново; приватные ключи — нет.

### 7. Границы безопасности и известные ограничения

- `ADMIN_KEY` эквивалентен root; Cloudflare Access — дополнительный барьер, а
  не замена.
- `KEY_SECRET` нельзя менять. Смена делает нечитаемыми все ключи узлов,
  сертификатов и аккаунтов ACME.
- Токены узлов хранятся как хеши и показываются один раз; файл токена внутри
  тома `vela-etc` (`/etc/vela/node.toml`) должен оставаться 0600.
- URL подписки — capability-credential; утечка отдаёт подписку пользователя.
  Сразу выполняйте Rotate.
- cloud-init кладёт токен в user-data и метаданные провайдера; не используйте
  недоверенного провайдера.
- `expire` влияет только на право на подписку (истёкший пользователь получает
  пустую подписку); `status=disabled` удаляет пользователя из конфигурации
  ядра инструмента пересылки трафика.
- Подписка Clash содержит только `proxies`, одну группу `SELECT` и правило
  `MATCH`. Маршрутизацию по назначению добавляйте в клиенте.
- Если из приватного ключа REALITY нельзя вывести публичный (например, в
  конфигурации остался placeholder), у ссылки нет `pbk`, и handshake не
  завершится.
- Удаление узла не стирает применённую конфигурацию на машине; выводите хост
  из эксплуатации отдельно.
- Конфиг заглушки nginx и `index.html` создаются/управляются сервером.
  Удаление маркера из `index.html` делает страницу пользовательской, но
  обновление образа освежает неизменённые страницы.
- Заглушка — TLS 1.3 + `X25519MLKEM768:X25519` без не-PQ отката, и
  настраивается это только в образе.
- `X-Vela-Server` — заголовок идентичности сервера (старое имя
  `X-Lessv-Node` тоже принимается), а `/dev/shm/lessv-decoy.sock` — это `dest`
  REALITY: оба значения заморожены протоколом и не являются названиями
  продукта.
- `BLOCK` должен быть в верхнем регистре; `block` в нижнем считается
  маршрутизируемым выходом.
- Регистрация WARP использует app API Cloudflare; при сбое возвращается 502 и
  конфигурация не пишется наполовину. Каждый предпросмотр preset регистрирует
  новое устройство, а панель не хранит учётные данные устройств.
- GeoIP использует full-издание rules-dat; lite не подходит для произвольных
  региональных правил `geoip:`.
- Staging-сертификаты не продлеваются и удаляются через 7 дней; долгоживущему
  тестовому узлу нужен повторный Test issue.
- Это руководство описывает протокол 3 и образ `vela-server`; актуальные tag
  образа смотрите в репозитории сервера.

### 8. Дополнительно

- Протокол узел ↔ панель: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Сертификаты, nginx и разбор сбоев: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Архитектура, разработка, тесты, релизы: [`docs/dev/`](docs/dev/README.md)

---

<a id="ko"></a>
## 조선어

### 1. Vela란 무엇인가

Vela는 흐름전달봉사를 자체적으로 운영하기 위한 관리평면입니다. 관리평면은 Cloudflare
Workers에서 실행되고, 관리용 SPA는 `/admin` 아래에서 봉사되며, 각 마디에서는
[LessV-Node](https://github.com/realumino/vela-server)에서 관리하는 `vela-server`
홀씨그림이 돕니다. 마디는 원하는 설정과 증명서를 관리평면에서 당겨옵니다.
관리평면은 마디에 먼저 련결하지 않습니다.

```
열람기 ── /admin ─────────────► Worker (Hono + 정적 SPA)
                                   │  /api/admin/*  ← ADMIN_KEY
                                   │  /api/node/*   ← 마디 토큰
                                   │  /sub/{token}  ← 구독 토큰
                                   ▼
                                  D1 (상태와 증명서) · Workflow (ACME)

사용자 ── /sub/{token} ──► 구독 ──► 련결주소 (D1에서 생성)

마디 ── 흐름전달도구핵심 (REALITY :443) ──► vela-server (홀씨그림)
        ▲ nginx 위장누리집 (Unix socket) │
        └── 증명서파일 ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

마디의 배치형식은 하나만 지원합니다. 흐름전달도구핵심의 REALITY가 443에서
듣고, `dest`는 본지의 Unix socket
`/dev/shm/lessv-decoy.sock`을 가리킵니다. nginx는 그 socket에서만 위장누리집을
봉사하고 80 포트는 HTTPS로 넘깁니다. 증명서는 nginx의것이고
흐름전달도구핵심에는 증명서가 없습니다. 443 포트는 언제나
흐름전달도구핵심의것입니다. nginx가 443에서 듣게 하지 마십시오.

### 2. 준비

| 항목 | 요구 |
|---|---|
| Cloudflare | 이미 련결된 zone; Workers, D1, Workflows 사용 가능 |
| 본지 | Node.js 22 LTS+ 및 npm |
| 관리평면 주소 | 례: `cp.example.com`, Cloudflare (Custom Domain)를 거쳐야 함 |
| 마디 주소 | 례: `node1.example.com`, **DNS only**(회색구름), 마디 IP를 가리킴 |
| 마디 주계산기 | Docker와 compose 부속을 갖춘 임의의 Linux, root, 80/443 비어있음 |
| 바깥련결 | 마디가 80/443에 접속할수 있어야 함: 홀씨그림 창고, 관리평면 HTTPS |
| 예비복사 | `KEY_SECRET`, `.env.production`, D1 예비복사, 마디 토큰 |

주계산기는 홀씨그림 하나를 쓰고 하나만 당겨옵니다. 흐름전달도구핵심, nginx,
량자이후 TLS 라이브러리는 모두 그 홀씨그림안에 있으므로 주계산기의 배포판과
OpenSSL 판본은 상관없습니다. 위장누리집은 `X25519MLKEM768:X25519`만 내놓으며
**고전적열쇠교환으로 되돌아가지 않습니다**. 그를 못하는 홀씨그림은 조용히
낮은 수준으로 내려가지 않고 적용단계에서 실패합니다.

권장순서: 먼저 Worker를 전개하고, 필요하면 Cloudflare Access를 켜며, 마지막에
마디를 추가합니다.

### 3. Cloudflare Worker 전개

#### 3.1 코드를 받고 의존꾸러미 설치

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### 3.2 현지 wrangler 설정 만들기

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc`의 `routes`를 자기 관리평면 주소로 고칩니다:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

본보기에는 D1, Workflow, 매일 cron, SPA 자원이 이미 묶여있습니다.
`workers_dev: false`와 `preview_urls: false`를 그대로 두십시오. 관리평면은
공개 주소가 하나만 있어야 하며, 그렇지 않으면 Cloudflare Access를 우회할수
있습니다. `wrangler.jsonc`에는 실제 주소와 첫 전개 뒤에 기록되는 D1 id가
들어있으므로 gitignore에 있습니다.

#### 3.3 세 비밀열쇠 만들기

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

값을 `.env.production`에 씁니다(절대로 commit하지 마십시오):

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY`는 모든 `/api/admin/*` 요청과 SPA 등록에 쓰이는 Bearer
  열쇠입니다. root와 같은 힘을 가지므로 새여나가면 관리평면을 잃습니다.
- `KEY_SECRET`은 자료기지에 있는 REALITY 비밀열쇠, 증명서 비밀열쇠,
  ACME 계정 비밀열쇠를 봉하는 AES-256-GCM 열쇠입니다. **돌릴수 없습니다**.
  돌리면 이미 저장된 모든 열쇠를 읽을수 없습니다. 한번만 만들고 오프라인
  예비복사를 두십시오.
- 현지 개발에는 `.dev.vars`, 생산에는 `.env.production`을 씁니다. 같은 값을
  두번 쓰지 마십시오.

#### 3.4 DNS API 토큰 만들기

Cloudflare 관리화면 → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit`, `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → 증명서 이름이 들어갈 zone

값을 `.env.production`의 `CF_DNS_API_TOKEN`에 넣습니다. Worker가
`_acme-challenge` TXT 레코드를 만들고 지우며 zone 목록을 읽을 때 쓰는
토큰입니다. `wrangler login`의 인증정보와는 다른것입니다.

#### 3.5 전개

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy`는 SPA를 만들고 → `wrangler deploy`(첫 전개때 D1을 자동으로
만들고 id를 기록하며 Custom Domain을 붙임) → 원격 D1 migration 적용 →
`https://<관리평면주소>/api/health`가 200을 돌려주도록 요구합니다. 첫 전개는
`--secrets-file`로만 비밀열쇠를 넣을수 있습니다. 아직 존재하지 않는 Worker에
`wrangler secret put`을 쓸수 없기때문입니다.

#### 3.6 검사

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

`https://cp.example.com/admin`을 열고 `ADMIN_KEY`를 붙여넣으십시오. 화면이
열리는것은 SPA가 봉사된다는것만 뜻합니다. 마디목록이 보여야 D1과 관리 API가
정상입니다.

#### 3.7 판올림, 되돌리기, 비밀열쇠 변경

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- 코드 되돌리기: `npx wrangler rollback`. D1은 되돌리지 않습니다. migration은
  앞판과 호환되여야 합니다.
- 나중에 비밀열쇠 변경: `npx wrangler secret put <NAME>`.
- `KEY_SECRET`은 돌리지 않습니다. `ADMIN_KEY`는 돌릴수 있으며, 돌린 뒤에는
  모든 열람기와 Script를 고쳐야 합니다.
- 현지 건설검사: `npm run deploy -- --dry-run` (구름을 건드리지 않음).

### 4. Cloudflare Access (권장)

Cloudflare Access는 Cloudflare 경계에 신분확인층을 더합니다. 이것은
`ADMIN_KEY`를 **대신하지 않습니다**. Worker는 여전히 Bearer 열쇠를 요구하며,
Access는 확인되지 않은 요청이 Worker에 이르지 못하게 할뿐입니다. 먼저
Worker를 전개한 다음 Access를 켜십시오. 전개 Script와 cloud-init이 모두
`/api/health`를 필요로 합니다.

#### 4.1 무엇을 보호하고 무엇을 보호하지 말아야 하는가

| 경로 | Access 뒤에 두는가 | 리유 |
|---|---|---|
| `/admin*` | **예** | 관리 SPA와 정적자원; 사람만 등록함 |
| `/api/admin*` | **예** | 관리 API; 열람기는 Access 세션, Script는 봉사토큰을 씀 |
| `/api/node/*` | **아니오** | 마디 서버는 Bearer 토큰만 보내며 Access를 모름; 보호하면 모든 마디가 끊김 |
| `/sub/*` | **아니오** | 구독 클라이언트(v2rayN, Clash, Shadowrocket 등)는 Access를 거치지 못함; 보호하면 모든 구독이 끊김 |
| `/api/health` | **아니오** | 전개 Script와 cloud-init이 도달성검사에 씀; 응답은 상수임 |
| 마디 주소 `:443` | **해당없음** | 마디 A 레코드는 DNS only이며 흐름이 Cloudflare를 거치지 않음. 마디 방화벽은 80/443만 염 |

`/api/health`를 Access가 막으면 `npm run deploy`의 마지막 검사와 cloud-init의 기다림고리가 모두 실패합니다. 공개로 두십시오.

아래 방법은 전체주소 응용프로그람 하나로 관리면을 보호하고 세 공개경로에 Bypass를 두는것입니다. 우의 표는 그 최종결과입니다.

원칙: **관리면만 보호하십시오**. 마디면, 구독면, 건강검사면은 공개로
둡니다. 각각 자기 증표(마디 토큰, 구독 토큰, 또는 없음)를 가집니다.

#### 4.2 전체 주소를 덮는 Access 응용프로그람 하나 만들기

`/admin`과 `/api/admin`에 Access 응용프로그람을 따로 만들지 마십시오. 두
응용프로그람은 서로 다른 응용프로그람 토큰을 내주며, SPA의 API 요청이 다시
인증을 요구받을수 있습니다. 전체 주소를 덮는 응용프로그람 하나를 만들어 두
경로가 같은 Access 세션을 쓰게 하십시오.

Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:

- Domain: `cp.example.com`
- Path: **비움** (전체 주소를 보호; 응용프로그람 주소는
  `https://cp.example.com`)
- Session Duration: 례: 24시간
- Identity providers: One-time PIN(기본) 또는 자기 SSO
- Policy: Action `Allow`, Include `Emails` → 자기 전자우편주소

4.4단계에서 만드는 Service Auth 정책을 이 응용프로그람에 넣습니다.

#### 4.3 공개경로를 위한 Bypass 응용프로그람 만들기

공개로 남아야 하는 경로마다 같은 Domain, 아래 Path, Action `Bypass`,
Include `Everyone` 정책을 가진 Self-hosted and private 응용프로그람을 하나 더
만드십시오.

| Path | 응용프로그람 주소 |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

더 구체적인 경로가 전체주소 응용프로그람보다 우선합니다. `Bypass`는 그
경로가 등록을 요구하지 않는다는 뜻입니다. Bypass 응용프로그람에 `Allow`
정책을 넣지 말고, `/admin`이나 `/api/admin`에 Bypass를 만들지 마십시오.
`/api/health`의 Bypass가 빠지면 전개검사와 cloud-init이 모두 실패합니다.

#### 4.4 Script용 봉사토큰 만들기

Zero Trust → Access controls → Service credentials → Service tokens → Create:

1. 이름을 붙이고(례: `vela-ops`) **Client ID**와 **Client Secret**를
   복사합니다(secret은 한번만 보임).
2. **전체주소 응용프로그람**(Bypass가 아님)으로 돌아가 정책을 더합니다:
   Action `Service Auth`, Include `Service Token` → 방금 만든 토큰.
3. Script는 Access 머리글과 Worker Bearer를 함께 보냅니다:

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

열람기는 이 머리글을 손으로 넣지 않습니다. Access cookie가 넣어줍니다.
봉사토큰은 오래 사는 증표입니다. 비밀번호관리기나 0600 파일에 두고
자료고, shell 력사, 기록에는 두지 마십시오. 새여나가면 Access에서 즉시
돌리십시오.

#### 4.5 Access 경계 검사

```bash
# 200이여야 하며 Access 등록으로 넘어가면 안됨
curl -i https://cp.example.com/api/health

# 구독 내용(또는 빈 200)이여야 하며 Access가 나오면 안됨
curl -i https://cp.example.com/sub/<token>

# Worker의 401 JSON이여야 하며 Access 등록화면이 나오면 안됨
curl -i -X POST https://cp.example.com/api/node/enroll

# 관리 API: ADMIN_KEY만 보내면 Access가 막음; 두 증표를 함께 보내면 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

주의:

- Access는 Cloudflare 경계에서만 작용합니다. `npm run dev`의 현지 8787은
  보호되지 않습니다.
- `workers.dev`, preview URL 또는 다른 route가 있으면 Access를 우회할수
  있습니다. 본보기는 그것들을 꺼두었습니다. 켜지 마십시오.
- Access는 `ADMIN_KEY`를 대신하지 않습니다. 두개는 서로 독립된 문입니다.
- `Bypass`는 세 공개경로(`/sub/*`, `/api/node/*`, `/api/health`)에만
  쓰십시오. `/admin`이나 `/api/admin`에 Bypass를 만들면 관리면이 그대로
  드러납니다.
  관리경로에만 응용프로그람을 만들면 경계가 분명해집니다.
- 마디 주계산기는 Cloudflare를 거치지 않으므로 Access가 보호할수 없습니다.
  마디안전은 80/443만 려는 방화벽, 비밀번호없는 SSH, 때맞춘 보안수정으로
  이룹니다.

### 5. 마디 추가

#### 5.1 마디 레코드와 토큰 만들기

관리화면: **Nodes → Add node**. id는 1–32자의 작은 영문자와 숫자(례: `node1`),
label은 임의의 글자입니다. 만든 다음 마디의 **Domain**을
`node1.example.com`으로 고치고 저장하십시오. 이 주소는 REALITY의
`serverNames`와 모든 공유련결에 들어갑니다.

마디화면 우측우의 **Re-generate token**(첫 토큰도 이것으로 만듬) → 확인 →
창에 나온 토큰을 복사하십시오. 관리평면은 해시만 저장하고 본문은 한번만
보여줍니다. 창을 닫으면 다시 볼수 없으며 새로 만들어야 합니다(옛 토큰은 즉시
무효).

API로 같은 일을 하기:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

먼저 DNS를 만드십시오. `node1.example.com`의 A 레코드가 마디 IP를 가리키고
**DNS only**(회색구름)이여야 합니다. REALITY와 nginx는 모두 443 직접련결을
필요로 합니다. Cloudflare를 거치게 하면 통로가 망가집니다.

#### 5.2 홀씨그림을 당겨오고 홀씨를 시작하기

주계산기에는 compose 부속이 있는 Docker와 홀씨그림만 있으면 됩니다. 나머지는
홀씨안에서 돕니다.

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# 한번 enroll: 토큰은 stdin으로 오고 인수목록에 남지 않습니다
printf '%s\n' '<paste node token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

바깥으로는 두 포트만 내놓으며 다른것은 열 필요가 없습니다. `vela-etc`는 신분과
증명서 나무를, `vela-state`는 상태파일과 실행설정, geodata를 담습니다.
`vela-etc`를 잃으면 다시 enroll해야 하고, `vela-state`를 잃으면 한번의
동기화만 치르면 됩니다. 기록:

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

판올림: compose 파일의 tag를 바꾸고 `docker compose up -d`를 실행하거나,
watchtower 같은 자동갱신기에 맡기십시오. 홀씨그림은 흐름전달도구핵심, nginx,
서버를 함께 담으므로 판올림은 세가지를 함께 바꿉니다. 홀씨안에서 손으로 고친
파일은 다음 재작성때 사라지며, 그것이 의도된것입니다. geodata는 여전히
관리화면(**Maintenance → Refresh Geodata**)에서 갱신합니다.

#### 5.3 방식 B: cloud-init

cloud-config는 관리평면이 만듭니다. cloud-init이 도는 Alpine 3.22+ / OpenRC
화상에 쓰는 한번실행 문서이며 고칠곳이 없습니다. BBR과 fd 한계를 올리고,
Docker와 nftables(80/443만)를 설치하고, sshd를 끄고 지우며, compose 파일을
쓰고, 한번 enroll한 다음 봉사를 시작합니다. 첫 시작 뒤 마디에는 SSH가
없습니다. 관리화면에서 다스립니다. 고장난 마디는 고치지 않고 없애고 다시
만듭니다.

절차:

1. 5.1대로 마디, Domain, DNS를 만드십시오.
2. 토큰을 만드십시오(5.1). 창에는 토큰 옆에 이미 완성된 cloud-config가
   있습니다 — 마디 id, 관리평면 주소, 홀씨그림, entrypoint가 채워져 있고
   토큰은 여기서 한번만 보입니다. 그것을 복사하십시오.
3. VPS 봉사자에서 Alpine 3.22+ 실례를 만들고 그 파일을 **user-data**로
   넘기십시오. 봉사자 방화벽에서 들어오는 TCP 80/443을 려십시오(22는 필요
   없음; 본보기가 sshd를 끔).
4. 첫 시작을 기다리십시오. 성공은 관리화면의 `Health: healthy`와 `Applied`가
   `Desired`를 따라잡는것입니다. 실패하면 봉사자 콘솔에서
   `/var/log/cloud-init-output.log`를 읽으십시오.
5. 실패한 첫 시작을 그자리에서 고치지 마십시오. 실례를 없애고 새 마디 id와
   토큰으로 다시 만드십시오. cloud-init은 한번만 돕니다.

안전주의: 토큰은 user-data에 있고 봉사자의 메터자료에 남습니다. 본보기는
주계산기의 `/root/vela.env`와 bootstrap 파일을 지우지만 봉사자쪽 기록은
지울수 없습니다. 믿을수 있는 봉사자에서만 쓰십시오. 페기는 관리화면에서 마디
레코드를 지우는것입니다(토큰은 즉시 무효). 생성된 user-data를 자료고에
commit하지 마십시오.

본보기는 Alpine/OpenRC 전용입니다. 다른 배포판에서는 Docker를 직접 설치하고
5.2를 따르십시오. OpenRC Script를 systemd 주계산기에 넣지 마십시오.

#### 5.4 첫 흐름전달도구핵심 설정 쓰기

마디화면 → **Configuration**:

1. **Base config** → 확인. 편집기에는 뼈대가 들어옵니다: `inbounds: []`,
   하나의 `BLOCK` blackhole outbound, 빈 routing.
2. **Presets → REALITY inbound → Apply**. 기본값은 마디 Domain과 위장누리집
   socket에서 옵니다:
   - 443에서 듣기;
   - `dest=/dev/shm/lessv-decoy.sock`;
   - `serverNames=[node1.example.com]`;
   - 무작위 8자리 16진수 `shortId`;
   - vision 흐름제어;
   - `privateKey`는 비여있음. 관리평면이 생성할때 만들어 넣으므로 비밀열쇠가
     앞화면에 나타나지 않습니다.
3. 합쳐진 JSON을 검토하고 **Save config**를 누르십시오. Preset은 저절로
   저장되지 않습니다. 목록에는 WARP outbound와 `geoip:`/`geosite:` 차단규칙도
   있습니다. 그것들도 편집기에만 합쳐지며 직접 저장하여야 합니다.

약 60초 안에 `GET /api/admin/nodes/node1/sync`(또는 마디화면)가
`applied_hash == desired_hash`, `health=ok`를 보여야 합니다. 잘못된 설정은
이전의 쓸수 있는 설정을 그대로 두고 `last_error`에 오유를 쓰며 관리화면이
그것을 보여줍니다.

출구를 더 두려면 outbound를 더하십시오(`freedom`은 직접, WARP preset은
masque(CONNECT-IP over HTTP/3, Xray 26.10.21 이상 필요)를 만듬, 나머지는 상류출구). 다음 사용자에게 배정하십시오. `BLOCK`은
맞지 않는 흐름의 기본길이며 사용자에게 절대로 배정할수 없습니다. 설정을
저장하면 모든 inbound/outbound가 endpoint 등록부에 들어갑니다. tag를 고쳐도
사용자권한, REALITY 열쇠, 련결변형이 보존됩니다.

마디의 `/var/lib/vela/config.json`을 손으로 고치지 마십시오. 관리평면이
유일한 진실의 근원이며 다음 당겨오기가 파일을 덮어씁니다.

#### 5.5 증명서 발급과 배정

마디 주소는 `serverNames`에 들어있어야 하고, 증명서가 마디에 배정되여야
nginx가 그것을 봉사할수 있습니다.

1. 관리화면 **Certificates → Add domain**: zone을 고르고(보통 자동),
   `node1.example.com`을 넣으십시오. 필요하면 include wildcard를 켜십시오.
   Create.
2. **Test issue**: ACME/DNS-01을 전부 실행하지만 staging의 current만 바꾸고
   생산은 건드리지 않습니다. DNS와 CAA 도달성을 생산한도없이 검사합니다.
3. 성공하면 **Issue**를 누르고 확인창에 정확한 도메인을 치십시오. Let's
   Encrypt 생산은 도메인당 주당 5장입니다. 실패를 고리로 되풀이하지 마십시오.
4. 마디화면 **Certificates** 탭: `node1.example.com`을 표시하고 환경을
   **Production**(기본)으로 고른 다음 **Save assignment**를 누르십시오.
5. 당겨오기를 기다리십시오. 관리화면에 `cert_synced_at`, `nginx_ok=1`이
   보입니다. 마디는 증명서를 `/etc/vela/certs/<domain path>/current/`에 쓰고
   nginx 위장설정을 만들며 `nginx -t`와 reload를 실행합니다. 흐름전달도구핵심은
   다시 시작하지 않습니다.

검사:

```bash
curl -I http://node1.example.com     # https로 301
curl -I https://node1.example.com    # 200, 유효한 증명서 (-k 없이)
```

staging을 쓰면 검사 클라이언트가 Let's Encrypt staging 뿌리를 믿어야 합니다.
staging 증명서는 갱신되지 않고 7일 뒤 지워집니다. 생산 증명서는 매일 03:17
UTC cron이 자동으로 갱신하며 마디는 다시 배정하지 않아도 따라갑니다.

#### 5.6 사용자 만들기, 구독 발급, 클라이언트 검사

1. **Users → Add user**: 사용자이름, 상태, 만료날자(선택); **Access by
   node**에서 마디를 고르고 허용할 inbound/outbound를 표시한 다음 **Create
   user**. `BLOCK`은 출구목록에 나오지 않습니다.
2. `applied_hash == desired_hash`가 되기를 기다리십시오(다음 생존신호와
   적용).
3. 사용자목록 **Share** → **Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   이 URL은 bearer capability입니다. 가진 사람은 구독을 받을수 있습니다.
   새여나가면 같은 카드에서 **Rotate**를 누르십시오. 옛 URL은 즉시
   무효가 됩니다.
4. 클라이언트에 넣기:
   - v2rayN / NekoBox / Shadowrocket / Hiddify: URL을 넣으면 base64 VLESS
     목록을 받습니다;
   - Clash Verge / FlClash / mihomo: user-agent에
     `clash`/`mihomo`/`stash`가 있으면 mihomo 설정을 받습니다.
     `?target=clash`로 강제할수 있습니다;
   - `?target=uri`는 VLESS 목록을 강제합니다.

   **Names → Subscription title**은 프로필에 표시 이름을 붙입니다(예:
   `Vela · {username}`, 필드 `{username}`, `{status}`). 이름은
   `profile-title: base64:…` 헤더로 나가며 v2rayN, Clash Verge 같은
   클라이언트가 보여줍니다. 비워 두면 헤더를 보내지 않아 응답이 이전과
   똑같습니다.
5. 클라이언트쪽 검사:

   ```bash
   curl https://api.ipify.org        # 마디 출구 IP가 나와야 함
   curl https://node1.example.com/   # 200과 유효한 증명서여야 함
   ```

   통로안과밖에서 같은 `tlsserver` 증명서를 봅니다. REALITY가 REALITY가 아닌
   흐름을 nginx 위장누리집에 넘기기때문입니다. 열람기에는 방문자의 출구 IP와
   함께 초록색 "Your Connection is secure" 카드가 보여야 합니다.

마디화면 **Links** 탭은 endpoint별로 쓸수 있는 련결을 보여줍니다. 같은
inbound의 추가 변형(CDN 앞단, 다른 포트, 다른 SNI)은 URI 매개변수만 바꾸며
실행설정에는 들어가지 않습니다. Domain이 없는 마디는 련결을 만들지 않습니다.

**Names** 화면은 하나의 형식 문자열(기본 `{node} · {subject} → {outbound}`;
필드 `{node}`, `{node_id}`, `{inbound}`, `{inbound_tag}`, `{link}`,
`{link_id}`, `{outbound}`, `{outbound_tag}`, `{subject}`, `{protocol}`)로 모든
련결의 이름을 정합니다. 특정 조합은 같은 화면에서 따로 이름을 지정할수 있고,
그 이름이 형식보다 우선합니다. 이름 변경은 클라이언트가 가져가는 련결만
바꾸며 마디를 다시 렌더하지 않습니다.

### 6. 운영과 고장수리

| 증상 | 먼저 볼것 | 고치기 |
|---|---|---|
| 마디가 끝내 나타나지 않음 | DNS가 DNS only인가; 내놓은 80/443; 나가는 80/443과 홀씨그림 창고; 토큰을 온전히 복사했는가; 주계산기 시계 | 망을 고치거나 새 토큰을 만드십시오; `docker compose -f /etc/vela/compose.yaml logs -n 50` |
| 마디는 있으나 `health`가 틀림 | `last_error`, `applied_hash`와 `desired_hash` | 마디 기록(마디가 적용 전에 설정을 검사합니다) |
| 설정을 저장해도 적용되지 않음 | JSON 정확성; REALITY `privateKey`가 비였는가; `serverNames`가 도메인을 덮는가 | 고치고 Save; 마디는 이전의 쓸수 있는 설정을 지킴 |
| `nginx_ok=0` | `nginx_error` | 위장누리집의 TLS 라이브러리는 홀씨그림안에 있습니다; 어느 tag가 도는지 보고 홀씨그림을 다시 만드십시오 |
| 증명서 발급 실패 | `issue_runs`의 phase/error; DNS 토큰의 zone 범위; CAA; LE 한도 | 먼저 Test issue; 생산 실패를 고리로 되풀이하지 마십시오 |
| 마디가 증명서를 받지 못함 | 배정표시; 환경이 맞는가; `cert_etag`가 걸렸는가 | 배정을 다시 저장하고 manifest ETag를 비교하십시오 |
| 구독이 비여있음 | 사용자가 disabled/만료; inbound/outbound 권한없음; 마디 address 없음 | 권한이나 상태를 고치십시오; 빈 body는 200이며 404가 아님 |
| Clash는 련결되나 누리집이 안열림 | 클라이언트가 REALITY + `support-x25519mlkem768`를 지지하는가; chrome 지문 | 생성된 mihomo 설정을 쓰십시오; URI를 손으로 고치지 마십시오 |
| WARP preset이 502 | Cloudflare WARP 등록 API 도달성 | 다시 시도하십시오; 관리평면은 절반설정을 쓰지 않음 |

마디 보수:

- **Refresh Geodata**: 상류 rules-dat 발표본에서 full `geoip.dat`/
  `geosite.dat`를 받고 검사한 다음 흐름전달도구핵심을 다시 시작합니다. 처음에는
  조건없이 설치하고, 그 다음 설정에 `geoip:`/`geosite:`가 있는한 7일마다 갱신합니다.
- 동작의 상태는 마디 머리부분과 `GET /api/admin/nodes/<id>/sync`의
  `actions`에 보입니다.
- **흐름전달도구핵심은 관리화면에서 판올림하지 않습니다.** 홀씨그림안에 있으므로
  판올림은 곧 홀씨그림 교체입니다(5.2).

마디 삭제: **Delete**는 그 마디의 토큰, 설정, 사용자권한, endpoint 등록부,
REALITY 열쇠, 증명서 배정을 지웁니다. 증명서 도메인과 발급력사는 도메인
자원이므로 영향을 받지 않습니다. 주계산기는 마지막 설정을 계속 실행하므로
따로 없애야 합니다. 토큰을 새로 만들면 옛 토큰은 즉시 무효가 되며, 이미 있는
마디는 `node.toml`을 고쳐야 다시 련결됩니다.

예비복사: 적어도 `KEY_SECRET`, `.env.production`, D1(관리화면의 export 또는
point-in-time restore)을 복사하십시오. D1에는 상태와 증명서 산물이 함께
있습니다. `KEY_SECRET`이 없으면 자료기지의 REALITY/증명서/ACME 비밀열쇠를 풀수
없습니다. 증명서는 다시 발급할수 있지만 비밀열쇠는 그럴수 없습니다.

### 7. 안전경계와 알려진 한계

- `ADMIN_KEY`는 root와 같은 힘을 가집니다. Cloudflare Access는 추가 문이며
  대신하는것이 아닙니다.
- `KEY_SECRET`은 돌릴수 없습니다. 돌리면 저장된 모든 마디열쇠, 증명서열쇠,
  ACME 계정을 읽을수 없습니다.
- 마디 토큰은 해시로만 저장되고 한번만 보입니다. `vela-etc` 론안의 토큰
  파일(`/etc/vela/node.toml`)은 0600을 지켜야 합니다.
- 구독 URL은 capability 증표입니다. 새면 그 사용자의 구독을 넘겨주는것과
  같습니다. 즉시 Rotate하십시오.
- cloud-init은 토큰을 user-data와 봉사자 메터자료에 둡니다. 믿을수 없는
  봉사자에서는 쓰지 마십시오.
- `expire`는 구독자격에만 영향을 줍니다(만료사용자는 빈 구독). `status=disabled`
  는 사용자를 흐름전달도구핵심 설정에서 지웁니다.
- Clash 구독은 `proxies`, 하나의 `SELECT` 모임, `MATCH` 규칙만 만듭니다. 목적지별
  분기는 클라이언트에서 더하십시오.
- REALITY 비밀열쇠에서 공개열쇠를 얻을수 없으면(례: 설정에 자리표시자가 남음)
  련결에 `pbk`가 없고 REALITY 악수가 끝나지 않습니다.
- 마디를 지워도 주계산기의 적용된 설정은 지워지지 않습니다. 주계산기는 따로
  퇴역시키십시오.
- nginx 위장설정과 `index.html`은 서버가 만들고 관리합니다. `index.html`의
  표식을 지우면 사용자정의가 되지만, 홀씨그림 판올림은 고치지 않은 화면을
  새로 고칩니다.
- 위장누리집은 TLS 1.3 + `X25519MLKEM768:X25519`이며 비PQ 되돌림이 없습니다.
  이것을 설정하는곳은 홀씨그림안뿐입니다.
- `X-Vela-Server`는 서버 신분 머리말(옛 이름 `X-Lessv-Node`도 받습니다)이고
  `/dev/shm/lessv-decoy.sock`은 REALITY의 `dest`입니다. 둘 다 제품이름이 아니라
  굳어진 프로토콜값입니다.
- `BLOCK`은 큰글자여야 합니다. 작은글자 `block`은 길이 있는 출구로
  취급됩니다.
- WARP 등록은 Cloudflare app API를 씁니다. 실패하면 502를 돌려주며 절반설정을
  쓰지 않습니다. preset을 미리볼때마다 새 장치가 등록되며, 관리평면은 장치
  증표를 저장하지 않습니다.
- GeoIP는 rules-dat full판을 씁니다. lite판은 임의 지역의 `geoip:` 규칙에
  부족합니다.
- staging 증명서는 갱신되지 않고 7일 뒤 지워집니다. 오래 사는 시험마디는
  Test issue를 다시해야 합니다.
- 이 설명서는 프로토콜 3과 `vela-server` 홀씨그림을 설명합니다. 현재 tag는
  서버 자료고에서 보십시오.

### 8. 더 읽을것

- 마디 ↔ 관리평면 프로토콜: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- 증명서, nginx, 고장수리: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- 구조, 개발, 시험, 발표: [`docs/dev/`](docs/dev/README.md)

---

<a id="tk"></a>
## Türkmençe

### 1. Vela näme?

Vela — Cloudflare Workers-de işleýän, özüňiz dolandyrýan trafik geçiriji
dolandyryş tekizligi. Dolandyryş tekizligi Cloudflare Workers-de işleýär;
dolandyryş SPA-si `/admin` astynda berilýär; her düwünde
[LessV-Node](https://github.com/realumino/vela-server)-da saklanýan
`vela-server` konteýner obrazy işleýär. Düwünler islenýän konfigurasiýasyny we
şahadatnamalaryny panelden çekýärler. Panel düwüne hiç wagt özi birikmeýär.

```
Brauzer ── /admin ─────────────► Worker (Hono + statik SPA)
                                   │  /api/admin/*  ← ADMIN_KEY
                                   │  /api/node/*   ← düwün tokeni
                                   │  /sub/{token}  ← abuna tokeni
                                   ▼
                                  D1 (maglumat we şahadatnamalar) · Workflow (ACME)

Ulanyjy ── /sub/{token} ──► abuna ──► baglanyşyklar (D1-den döredilýär)

Düwün ── trafik geçiriji ýadro (REALITY :443) ──► vela-server (obraz)
        ▲ nginx ýasama saýt (Unix socket) │
        └── şahadatnama faýllary ◄── GET /api/node/certs ◄── ACME (DNS-01)
```

Diňe bir düwün topologiýasy goldanýar: trafik geçiriji ýadro REALITY bilen
443-nji portda diňleýär, `dest` ýerli Unix socket
`/dev/shm/lessv-decoy.sock`-a görkezýär; nginx diňe şol socketde ýasama
saýty berýär we 80-nji porty HTTPS-e ugrukdyrýar. Şahadatnamalar nginx-e
degişli; ýadroda şahadatnama ýok. 443-nji port hemişe ýadroň; nginx-i 443-de
diňletmäň.

### 2. Talaplar

| Zat | Talap |
|---|---|
| Cloudflare | Hasaba birikdirilen zona; Workers, D1, Workflows elýeterli |
| Ýerli maşyn | Node.js 22 LTS+ we npm |
| Panel domeni | Mysal üçin `cp.example.com`, Cloudflare Custom Domain arkaly |
| Düwün domeni | Mysal üçin `node1.example.com`, **diňe DNS** (çar şemal), düwün IP-sine |
| Düwün serweri | Docker we compose goşundysy bolan islendik Linux, root, 80/443 boş |
| Çykyş | Düwün 80/443-e ýetýär: obraz ammary, panel HTTPS |
| Ätiýaçlyk | `KEY_SECRET`, `.env.production`, D1 ätiýaçlygy, düwün tokenleri |

Serwer bir konteýner we bir obraz ulanýar. Ýadro, nginx we kwantdan soňky TLS
kitaphanasy şol obrazyň içindedir, şonuň üçin serweriň distributiwi we OpenSSL
wersiýasy möhüm däl: ýasama saýt diňe `X25519MLKEM768:X25519`-i hödürleýär we
**klassik açar çalşygyna yza gaýtmaýar**; muny edip bilmeýän obraz ümsüm
peselmeýär-de, apply tapgyrynda şowsuz bolýar.

Maslahat berilýän tertip: ilki Worker-i ýerleşdiriň, soň isleseňiz
Cloudflare Access-i açyň, iň soňunda düwün goşuň.

### 3. Cloudflare Worker-i ýerleşdirmek

#### 3.1 Kody almak we baglylyklary gurmak

```bash
git clone https://gitee.com/realumino/lessv.git
cd lessv
npm install
npm --prefix frontend install
```

#### 3.2 Ýerli wrangler konfigurasiýasyny döretmek

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` faýlynda `routes` bölümini öz panel domeniňize üýtgediň:

```jsonc
"routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
```

Şablon D1, Workflow, gündelik cron we SPA faýllaryny eýýäm baglaýar.
`workers_dev: false` we `preview_urls: false` bolmaly: paneliň diňe bir
açyk domeni bolmaly, ýogsa Cloudflare Access-i aýlanyp geçip bolýar.
`wrangler.jsonc` hakyky domeni we ilkinji ýerleşdirmeden soň ýazylýan D1
ID-sini saklaýar, şonuň üçin gitignore-da.

#### 3.3 Üç gizlin açar döretmek

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
```

Olary `.env.production` faýlyna ýazyň (hiç wagt commit etmäň):

```dotenv
ADMIN_KEY=<base64url-of-32-random-bytes>
KEY_SECRET=<base64-of-32-random-bytes>
CF_DNS_API_TOKEN=<cloudflare-dns-token>
```

```bash
chmod 600 .env.production
```

- `ADMIN_KEY` — ähli `/api/admin/*` haýyşlary we SPA girişi üçin Bearer
  açar. Ol root bilen deňdir: syrsa, paneli ýitirýärsiňiz.
- `KEY_SECRET` — saklanýan REALITY açaralaryny, şahadatnama açaralaryny we
  ACME hasap açaralaryny möhürleýän AES-256-GCM açary. **Ony çalşyp
  bolmaýar**: çalşyrsaňyz, ähli saklanýan açaralar okalmaz bolýar. Bir gezek
  dörediň we oflaýn ätiýaçlyk nusgasyny saklaň.
- Ýerli iş üçin `.dev.vars`, önümçilik üçin `.env.production` ulanyň; bir
  bahany iki gezek ulanmaň.

#### 3.4 DNS API tokenini döretmek

Cloudflare paneli → My Profile → API Tokens → Create Token → Custom token:

- Permissions: `Zone → DNS → Edit`, `Zone → Zone → Read`
- Zone Resources: Include → Specific zone → şahadatnama domenleri boljak zona

Bahany `.env.production` faýlyndaky `CF_DNS_API_TOKEN`-a goýuň. Bu tokeni
Worker `_acme-challenge` TXT ýazgylaryny döretmek/öçürmek we zona sanawyny
okamak üçin ulanýar; ol `wrangler login` maglumaty däl.

#### 3.5 Ýerleşdirmek

```bash
npm run deploy -- --secrets-file .env.production
```

`npm run deploy` tertibi: SPA gurýar → `wrangler deploy` (ilkinji gezek D1-i
döredýär, ID-sini ýazýar we Custom Domain-i baglaýar) → uzak D1
migrasiýalaryny ulanýar → `https://<panel-domeni>/api/health` 200 bolmaly.
Ilkinji ýerleşdirmede gizlinleri diňe `--secrets-file` arkaly bermek
bolýar, sebäbi `wrangler secret put` entek döredilmedik Worker-e ýüzlenip
bilmeýär.

#### 3.6 Barlamak

```bash
curl -fsS https://cp.example.com/api/health
# {"status":"ok"}

npx wrangler deployments list
npx wrangler workflows list
```

`https://cp.example.com/admin` saýtyny açyň we `ADMIN_KEY`-i goýuň. Saýtyň
açylmagy diňe SPA-nyň işleýändigini aňladýar; düwünleriň sanawy D1 we
dolandyryş API-siniň işleýändigini aňladýar.

#### 3.7 Täzelemek, yzyna gaýtarmak we gizlinleri üýtgetmek

```bash
git pull
npm install
npm --prefix frontend install
npm run deploy -- --secrets-file .env.production
```

- Kody yzyna gaýtarmak: `npx wrangler rollback`. Ol D1-i yzyna gaýtarmaýar;
  migrasiýalar öňki wersiýa bilen gabat gelmeli.
- Soňraky gizlin üýtgetmesi: `npx wrangler secret put <NAME>`.
- `KEY_SECRET` çalşylmaýar. `ADMIN_KEY`-i çalşyp bolýar; soň ähli brauzerler
  we skriptler täzelenmeli.
- Ýerli gurnama barlagy: `npm run deploy -- --dry-run` (bulutsuz).

### 4. Cloudflare Access (maslahat berilýär)

Cloudflare Access Cloudflare gyrasynda goşmaça şahsyýet gatlagyny goşýar.
Ol `ADMIN_KEY`-i **çalyşmaýar**: Worker henizem Bearer açar talap edýär;
Access diňe tassyklanmadyk haýyşlary Worker-e ýetirmez ýaly edýär. Ilki
Worker-i ýerleşdiriň, soň Access-i açyň, sebäbi ýerleşdirme skripti we
cloud-init ikisi hem `/api/health`-e mätäç.

#### 4.1 Nämüni goramaly, nämüni goramaly däl

| Ýol | Access-yň arkasynda? | Näme üçin |
|---|---|---|
| `/admin*` | **Hawa** | Dolandyryş SPA we statik faýllar; diňe adamlar girýär |
| `/api/admin*` | **Hawa** | Dolandyryş API; brauzer Access sessiýasyny, skriptler hyzmat tokenini ulanýar |
| `/api/node/*` | **Ýok** | Düwün serweri diňe Bearer token iberýär we Access-i bilmeýär; gorasaňyz, ähli düwünler aýrylýar |
| `/sub/*` | **Ýok** | Abuna klientleri (v2rayN, Clash, Shadowrocket we başgalar) Access-den geçip bilmeýär; gorasaňyz, ähli abunalar bozulýar |
| `/api/health` | **Ýok** | Ýerleşdirme skripti we cloud-init onuň bilen elýeterliligi barlaýar; jogap hemişe birmeňzeş |
| Düwün domeni `:443` | **Degişli däl** | Düwüniň A ýazgysy diňe DNS; trafik Cloudflare-den geçmeýär. Düwüniň gorag diwary diňe 80/443-i açýar |

Eger Access `/api/health`-i ýaparsa, `npm run deploy`-yň soňky barlagy we
cloud-init-iň garaşmak sikli ikisi hem şowsuz bolýar; ony açyk saklaň.

Aşakdaky usul ähli hosty gurşap alýan bir programmany dolandyryş ýüzi üçin
we üç açyk ýol üçin Bypass programmalaryny ulanýar; ýokardaky tablisada
netijäni görkezýär.

Düzgün: **diňe dolandyryş ýüzüni goramaly**. Düwün, abuna we saglyk
ýüzleri açyk galýar; hersiniň öz kepili bar (düwün tokeni, abuna tokeni
ýa-da hiç zat).

#### 4.2 Ähli hosty gurşap alýan bir Access programmasyny döretmek

`/admin` we `/api/admin` üçin aýratyn Access programmalaryny döretmäň: iki
programma iki sany programma tokeni berýär we SPA-nyň API haýyşlary täzeden
tassyklama talap edip biler. Ähli hosty gurşap alýan bir programma dörediň,
şonda ikisi bir Access sessiýasyny ulanýar.

Zero Trust → Access controls → Applications → Create new application →
**Self-hosted and private** → Add public hostname:

- Domain: `cp.example.com`
- Path: **boş** (ähli hosty goraýar; programma URL-si
  `https://cp.example.com`)
- Session Duration: mysal üçin 24 sagat
- Identity providers: One-time PIN (deslapky) ýa-da öz SSO-yňyz
- Policy: Action `Allow`, Include `Emails` → öz salgyňyz

4.4-nji ädimde dörediljek Service Auth syýasatyny şu programma goşuň.

#### 4.3 Açyk ýollar üçin Bypass programmalaryny döretmek

Açyk galmaly her ýol üçin şol bir Domain, aşakdaky Path we Action `Bypass`,
Include `Everyone` syýasaty bilen ýene bir Self-hosted and private
programma dörediň.

| Path | Programma URL-si |
|---|---|
| `sub/*` | `https://cp.example.com/sub/*` |
| `api/node/*` | `https://cp.example.com/api/node/*` |
| `api/health` | `https://cp.example.com/api/health` |

Has takyk ýollar ähli hosty gurşap alýan programmadan öň gelýär; `Bypass`
bu ýoluň giriş talap etmeýändigini aňladýar. Bypass programmalaryna `Allow`
syýasatyny goşmaň we `/admin` ýa `/api/admin` üçin Bypass döretmäň. Eger
`/api/health` üçin Bypass ýok bolsa, ýerleşdirme barlagy we cloud-init ikisi
hem şowsuz bolýar.

#### 4.4 Skriptler üçin hyzmat tokenini döretmek

Zero Trust → Access controls → Service credentials → Service tokens → Create:

1. At beriň (mysal üçin `vela-ops`) we **Client ID** bilen **Client
   Secret**-i göçüriň (secret diňe bir gezek görkezilýär).
2. **Ähli hosty gurşap alýan programma** gaýdyp geliň (Bypass programa
   däl) we syýasat goşuň: Action `Service Auth`, Include `Service Token` →
   ýaňy döredilen token.
3. Skriptler Access ýazgylaryny we Worker Bearer-yny bilelikde iberýärler:

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

Brauzer bu ýazgylary elde goşmaýar; Access cookie özi goşýar. Hyzmat tokeni
uzak ýaşaýan kepil: ony parol dolandyrijynda ýa-da 0600 faýlda saklaň,
ammarda, shell taryhynda ýa žurnallarda saklamaň. Syrsa, Access-de derrew
çalşyň.

#### 4.5 Access çägini barlamak

```bash
# 200 bolmaly, Access girişine geçmeli däl
curl -i https://cp.example.com/api/health

# Abuna mazmuny (ýa boş 200) bolmaly, Access bolmaly däl
curl -i https://cp.example.com/sub/<token>

# Worker-iň 401 JSON-y bolmaly, Access giriş sahypasy däl
curl -i -X POST https://cp.example.com/api/node/enroll

# Dolandyryş API: diňe ADMIN_KEY Access tarapyndan saklanýar; ikisi bilelikde 200
curl -i -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes
```

Bellikler:

- Access diňe Cloudflare gyrasynda işleýär; `npm run dev`-iň ýerli 8787
  porty goragly däl.
- `workers.dev`, preview URL ýa-da başga route bar bolsa, Access-i aýlanyp
  geçip bolýar. Şablon olary öçüripdir; açmaň.
- Access `ADMIN_KEY`-i çalyşmaýar; olar iki sany garaşsyz derweze.
- `Bypass`-y diňe üç açyk ýol üçin ulanyň (`/sub/*`, `/api/node/*`,
  `/api/health`); `/admin` ýa `/api/admin` üçin hiç wagt Bypass goşmaň,
  ýogsa dolandyryş ýüzi açylýar.
- Düwün serweri Cloudflare-den geçmeýär, şonuň üçin Access ony
  gorap bilmeýär. Düwüniň howpsuzlygy 80/443 gorag diwary, parolsyz SSH we
  öz wagtynda ýapylýan howpsuzlyk täzelenmeleridir.

### 5. Düwün goşmak

#### 5.1 Düwün ýazgysyny we tokenini döretmek

Panel: **Nodes → Add node**. ID diňe kiçi harplar we sanlardan bolmaly,
1–32 belgi (mysal üçin `node1`); Label islendik tekst. Döredensoň düwüniň
**Domain**-ini `node1.example.com` edip üýtgediň we saklaň—bu domen REALITY
`serverNames`-ine we ähli paýlaşyk baglanyşyklaryna girýär.

Düwün sahypasynda **Re-generate token** (ilkinji token üçin hem şol) →
tassykla → açylan penjireden tokeni göçür. Panel diňe hashi saklaýar we
açyk teksti bir gezek görkezýär. Penjire ýapylsa, token ýitýär; täzesini
dörediň (köne token derrew işlemeýär).

API bilen deňi:

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
CP=https://cp.example.com

curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"id":"node1","label":"First node","address":"node1.example.com"}' \
  $CP/api/admin/nodes

curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  $CP/api/admin/nodes/node1/token
```

Ilki DNS dörediň: `node1.example.com` üçin A ýazgysy düwüniň IP-sine,
**diňe DNS** (çar şemal). REALITY we nginx ikisi hem göni 443 talap edýär;
Cloudflare-den geçýän ýazgy tuneli bozýar.

#### 5.2 Obrazy çekmek we konteýneri başlatmak

Serwere diňe compose goşundysy bilen Docker we obrazyň özi gerek; galan zat
konteýneriň içinde işleýär.

```bash
ssh root@203.0.113.10

IMAGE=ghcr.io/example/vela-server:latest
BINARY=/usr/local/bin/vela-server

docker pull "$IMAGE"
cat > /etc/vela/compose.yaml <<'COMPOSE'
services:
  vela-server:
    image: "${IMAGE}"
    container_name: vela-server
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443/tcp"
    stop_grace_period: 90s
    security_opt:
      - no-new-privileges:true
    ulimits:
      nofile:
        soft: 1048576
        hard: 1048576
    volumes:
      - vela-etc:/etc/vela
      - vela-state:/var/lib/vela

volumes:
  vela-etc:
  vela-state:
COMPOSE

# bir gezeklik enroll: token stdin-den gelýär, argument sanawyna düşmeýär
printf '%s\n' '<paste node token>' | docker run --rm -i \
  --entrypoint "$BINARY" -v vela-etc:/etc/vela "$IMAGE" \
  enroll --cp https://cp.example.com --node node1 \
  --nginx-conf-path /etc/nginx/http.d/vela-decoy.conf

docker compose -f /etc/vela/compose.yaml up -d
```

Daşyna diňe iki port çykarylýar, başga zat açylmaly däl. `vela-etc` şahsyýeti
we şahadatnama agajyny saklaýar; `vela-state` ýagdaý faýlyny, işleýän
konfigurasiýany we geodata-ny. `vela-etc` ýitse täzeden enroll etmeli; 
`vela-state` ýitse bir sinhronlaşma ýeter. Žurnallar:

```bash
docker compose -f /etc/vela/compose.yaml ps
docker compose -f /etc/vela/compose.yaml logs -n 50
```

Täzelemek: compose faýlyndaky tagy üýtgedip `docker compose up -d` işlediň
ýa-da watchtower ýaly awtomatik täzeläji muny etsin. Obraz ýadrony, nginx-i we
serweri bilelikde saklaýar, şonuň üçin täzeleme üçüsini hem çalyşýar;
konteýneriň içinde elde üýtgedilen faýl indiki täzeden döretmekde ýitýär we bu
bilgeşleýin. geodata henizem panelden (**Maintenance → Refresh Geodata**)
täzelenýär.

#### 5.3 B usuly: cloud-init

cloud-config-y panel ýazýar: cloud-init işleýän Alpine 3.22+ / OpenRC obrazy
üçin bir gezeklik resminama we ony üýtgetmek gerek däl. Ol BBR we fd çäklerini
ýokarlandyrýar, Docker we nftables (diňe 80/443) gurýar, sshd-ni öçürýär we
aýyrýar, compose faýlyny ýazýar, bir gezek enroll edýär we serwisi başlaýar.
Ilkinji açylyşdan soň düwünde SSH ýok; dolandyryş panelden bolýar. Bozulan
düwüni üýtgedip bejermäň: ýok ediň we täzeden dörediň.

Ädimler:

1. 5.1-e görä düwüni, Domain-i we DNS-i dörediň.
2. Tokeni dörediň (5.1). Penjirede tokeniň gapdalynda taýýar cloud-config bar —
   düwün id-si, panel salgysy, obraz we entrypoint eýýäm doldurylan, token bolsa
   diňe şu ýerde bir gezek görünýär. Ony göçüriň.
3. VPS üpjün edijisinde Alpine 3.22+ instansyny dörediň we faýly
   **user-data** hökmünde beriň. Gorag diwarynda giriş TCP 80/443 açyň (22
   gerek däl; şablon sshd-ni öçürýär).
4. Ilkinji açylyşa garaşyň. Üstünlik: panelde `Health: healthy` we
   `Applied`-yň `Desired`-a ýetmegi. Şowsuz bolsa, üpjün edijiniň
   konsolyndan `/var/log/cloud-init-output.log`-y okaň.
5. Şowsuz ilkinji açylyşy şol ýerde bejermäň: instansy ýok ediň we täze
   düwün ID-si we tokeni bilen täzeden dörediň. cloud-init bir gezek işleýär.

Howpsuzlyk belligi: token user-data-da bolýar we üpjün edijiniň
metamaglumatlary ony saklaýar. Şablon serwerdäki `/root/vela.env` we
bootstrap faýllaryny pozýar, ýöne üpjün edijiniň ýazgysyny pozup bilmeýär.
Diňe ynamdar üpjün edijide ulanyň; ýatyrmak panelde düwün ýazgysyny
öçürmekdir (token derrew işlemeýär). Işlenen user-data-ny ammara commit
etmäň.

Şablon Alpine/OpenRC üçin niýetlenen. Beýleki distributiwde Docker-i özüňiz
guryň we 5.2-ä eýeriň; OpenRC skriptlerini systemd serwerine goýmaň.

#### 5.4 Ilkinji konfigurasiýany ýazmak

Düwün sahypasy → **Configuration**:

1. **Base config** → tassykla. Redaktorda skelet peýda bolýar:
   `inbounds: []`, bir `BLOCK` blackhole outbound, boş routing.
2. **Presets → REALITY inbound → Apply**. Deslapky bahalar düwüniň
   Domain-inden we ýasama socketden alynýar:
   - 443-de diňlemek;
   - `dest=/dev/shm/lessv-decoy.sock`;
   - `serverNames=[node1.example.com]`;
   - tötänleýin 8 belgili hex `shortId`;
   - vision akym dolandyryşy;
   - `privateKey` boş; panel ony döredip goşýar, şonuň üçin hususy açar
     öň tarapda görünmeýär.
3. Birleşdirilen JSON-y barlaň we **Save config**-a basyň. Preset özi
   saklanmaýar. Sanawda WARP outbound we `geoip:`/`geosite:` blokirleme
   düzgünleri hem bar; olar hem diňe redaktora birleşdirilýär we elde
   saklamagy talap edýär.

Takmynan 60 sekuntdan `GET /api/admin/nodes/node1/sync` (ýa düwün
sahypasy) `applied_hash == desired_hash` we `health=ok` görkezmeli. Nädogry
konfigurasiýa öňki işleýän konfigurasiýany saklaýar we ýalňyşlygy
`last_error`-a ýazýar; panel ony görkezýär.

Goşmaça çykyşlar üçin konfigurasiýa outbound goşuň (`freedom` göni; WARP
preseti masque (CONNECT-IP, HTTP/3; Xray 26.10.21 ýa-da täze bolmaly) döredýär; beýlekiler ýokary akym çykyşy hasaplanýar), soň
ulanyjylara belläň. `BLOCK` gabat gelmeýän trafigiň deslapky ýoludyr we
hiç wagt ulanyja berilmeýär. Konfigurasiýany saklamak her inbound/outbound-y
endpoint registrine ýazýar; tag üýtgese-de ulanyjy hukuklary, REALITY
açarlary we baglanyşyk görnüşleri saklanýar.

Düwündäki `/var/lib/vela/config.json` faýlyny elde üýtgetmäň. Panel ýeke-täk
hakykat çeşmesi; indiki çekiliş faýly üstünden ýazar.

#### 5.5 Şahadatnama çykarmak we bellemek

Düwün domeni `serverNames`-de bolmaly we şahadatnama düwüne bellenmeli,
şonda nginx ony berip bilýär.

1. Panel **Certificates → Add domain**: zonany saýlaň (adaty ýagdaýda
   awtomatik), `node1.example.com` ýazyň; gerek bolsa include wildcard-y
   açyň. Create.
2. **Test issue**: ACME/DNS-01 akymyny doly işledýär, ýöne diňe staging
   current görkezijisini üýtgedýär, önümçilige degmeýär. DNS we CAA
   elýeterliligini önümçilik çägi sarp etmezden barlamak üçin.
3. Üstünlikden soň **Issue** we tassyklama penjiresinde takyk domeni
   ýazyň. Let's Encrypt önümçilikde hepdede bir domen üçin 5 şahadatnama
   berýär; şowsuzylykda aýlawly gaýtalamanyň.
4. Düwün sahypasynyň **Certificates** bölümi: `node1.example.com`-y belläň,
   **Production** (deslapky) saýlaň we **Save assignment**-a basyň.
5. Çekilişe garaşyň: panel `cert_synced_at` we `nginx_ok=1` görkezýär. Düwün
   şahadatnamany `/etc/vela/certs/<domain path>/current/`-a ýazýar, nginx
   ýasama konfigurasiýasyny döredýär, `nginx -t` we reload edýär. Ýadro
   täzeden başlamaýar.

Barlag:

```bash
curl -I http://node1.example.com     # https-e 301
curl -I https://node1.example.com    # 200, dogry şahadatnama (-k gerek däl)
```

Staging bilen synag klienti Let's Encrypt staging köküne ynam etmeli;
staging şahadatnamalary täzelenmeýär we 7 günden soň pozulýar. Önümçilik
şahadatnamalary her gün 03:17 UTC cron bilen awtomatik täzelenýär we düwün
täze bellemäsiz yzarlaýar.

#### 5.6 Ulanyjy döretmek, abuna çykarmak, klienti barlamak

1. **Users → Add user**: ulanyjy ady, ýagdaýy, islege görä möhleti; **Access
   by node** bölüminde düwüni saýlaň we rugsat berlen inbound/outbound-lary
   belläň; **Create user**. `BLOCK` çykyş sanawynda görünmeýär.
2. `applied_hash == desired_hash` bolýança garaşyň (indiki heartbeat we
   apply).
3. Ulanyjylar sanawynda **Share** → **Subscription → Generate**:

   ```
   https://cp.example.com/sub/<token>
   ```

   Bu URL bearer kepil: kimiňde bar bolsa, abuna alýar. Syrsa, şol kartda
   **Rotate**-a basyň; köne URL derrew işlemeýär.
4. Kliente giriziň:
   - v2rayN / NekoBox / Shadowrocket / Hiddify: URL-i giriziň we base64
     VLESS sanawyny alyň;
   - Clash Verge / FlClash / mihomo: user-agent-de
     `clash`/`mihomo`/`stash` bar bolsa, mihomo profili berilýär;
     `?target=clash` ony mejbur edýär;
   - `?target=uri` VLESS sanawyny mejbur edýär.

   **Names → Subscription title** profile görkezijä at berýär (meselem
   `Vela · {username}`; meýdanlar `{username}`, `{status}`). Ol
   `profile-title: base64:…` sözbaşysy bilen gidýär we v2rayN, Clash Verge
   ýaly klientler ony görkezýär; boş goýsaň hiç hili sözbaşy iberilmeýär we
   jogap öňki ýaly bolýar.
5. Klient tarapdan synag:

   ```bash
   curl https://api.ipify.org        # düwüniň çykyş IP-sini bermeli
   curl https://node1.example.com/   # 200 we dogry şahadatnama bolmaly
   ```

   Düwüniň sahypasyndaky **Names** sahypasy ähli (inbound görnüşi, çykyş)
   jübütlerini bir format bilen atlandyrýar (deslapky
   `{node} · {subject} → {outbound}`; meýdanlar `{node}`, `{inbound}`,
   `{link}`, `{outbound}`, `{protocol}` we başgalar). Islendik jübüt üçin aýratyn
   at hem goýup bolýar we ol formatdan ileri tutulýar. At üýtgetmek diňe
   klientiň alýan baglanyşyklaryna täsir edýär; düwün täzeden render edilmeýär.

   Tuneliň içinde we daşynda birmeňzeş `tlsserver` şahadatnamasy görünýär:
   REALITY REALITY däl trafigi nginx ýasama saýtyna geçirýär. Brauzerde
   ýaşyl "Your Connection is secure" kartasy we gelýäniň çykyş IP-si
   görünmeli.

### 6. Işletmek we ýalňyşlyklary düzetmek

| Alamaty | Ilki barlaň | Düzediş |
|---|---|---|
| Düwün hiç görünmeýär | DNS diňe DNS-mi; çykarylan 80/443; çykyş 80/443 we obraz ammary; token doly göçürildimi; serwer sagadymy | Tora düzediş ediň ýa täze token dörediň; `docker compose -f /etc/vela/compose.yaml logs -n 50` |
| Düwün bar, `health` nädogry | `last_error`, `applied_hash` bilen `desired_hash` | Düwüniň žurnalyny okaň; düwün apply-dan öň konfigurasiýany barlaýar |
| Konfigurasiýa saklandy, ýöne işlemeýär | JSON dogrumy; REALITY `privateKey` boşmy; `serverNames` domeni öz içine alýarmy | Düzediň we Save; düwün öňki işleýän konfigurasiýany saklaýar |
| `nginx_ok=0` | `nginx_error` | Ýasama saýtyň TLS kitaphanasy obrazyň içinde; haýsy tagyň işleýändigini barlap, obrazy täzeden gurmaly |
| Şahadatnama çykarylmaýar | `issue_runs` phase/error; DNS tokeniniň zona çägi; CAA; LE çägi | Ilki Test issue; önümçilik şowsuzylygyny aýlawda gaýtalamanyň |
| Düwün şahadatnama almaýar | Belleniş barlanýarmy; gurşaw dogrumy; `cert_etag` düşüp galdymy | Assignment-y täzeden saklaň; manifest ETag bilen deňeşdiriň |
| Abuna boş | Ulanyjy disabled/möhleti geçen; inbound/outbound hukugy ýok; düwünde address ýok | Hukugy ýa ýagdaýy düzediň; boş jogap 200, 404 däl |
| Clash birikýär, brauzer saýty açmaýar | Klient REALITY + `support-x25519mlkem768` goldaýarmy; chrome barmak yzy | Döredilen mihomo profilini ulanyň; URI-i elde üýtgetmäň |
| WARP preseti 502 | Cloudflare WARP registrasiýa API-si elýeterlimi | Täzeden synanyşyň; panel ýarym konfigurasiýa ýazmaýar |

Düwüniň tehniki hyzmaty:

- **Refresh Geodata**: `geoip.dat`/`geosite.dat`-yň full wersiýasyny
  ýokary akym rules-dat çykarylyşyndan ýükläp, barlaýar we ýadrony täzeden
  başlaýar. Ilkinji gezek şertsiz gurýar, soň konfigurasiýada
  `geoip:`/`geosite:` bar bolsa her 7 günde täzeläýär.
- Hereketiň ýagdaýy düwüniň ýokarsynda we
  `GET /api/admin/nodes/<id>/sync` jogabynyň `actions` bölüminde görünýär.
- **Ýadro panelden täzelenmeýär.** Ol obrazyň içinde; täzeleme diýmek obrazy
  çalyşmak diýmekdir (5.2).

Düwüni öçürmek: **Delete** düwüniň tokenini, konfigurasiýasyny, ulanyjy
hukuklaryny, endpoint registrini, REALITY açarlaryny we şahadatnama
bellenişini öçürýär. Şahadatnama domenleri we çykarylyş taryhy domen derejesinde
bolup, täsir etmeýär. Maşyn soňky konfigurasiýasyny işledip durýar; ony
aýratyn ýok ediň. Tokeni täzeden döretmek köne tokeni derrew ýatyryýar; bar
bolan düwün `node.toml`-y täzeläp bilýär.

Ätiýaçlyk: iň bolmanda `KEY_SECRET`, `.env.production` we D1 (Cloudflare
panelinde export ýa point-in-time restore). D1-de hem ýagdaý, hem
şahadatnama önümleri saklanýar. `KEY_SECRET` bolmasa,
REALITY/şahadatnama/ACME hususy açarlaryny açyp bolmaýar. Şahadatnamalary
täzeden çykaryp bolýar; hususy açarlary bolmaýar.

### 7. Howpsuzlyk çäkleri we belli çäklendirmeler

- `ADMIN_KEY` root bilen deňdir; Cloudflare Access goşmaça derweze, onuň
  ýerini tutmaýar.
- `KEY_SECRET` çalşylmaýar. Çalşyrsaňyz, saklanýan ähli düwün açarlary,
  şahadatnama açarlary we ACME hasaby okalmaz bolýar.
- Düwün tokenleri diňe hash görnüşinde saklanýar we bir gezek görkezilýär;
  `vela-etc` jiltindäki token faýly (`/etc/vela/node.toml`) 0600 bolmaly.
- Abuna URL-si kepil: syrsa, şol ulanyjynyň abunasyny başga birine
  berýärsiňiz. Derrew Rotate ediň.
- cloud-init tokeni user-data-a we üpjün edijiniň metamaglumatlaryna
  goýýar; ynamdar bolmadyk üpjün edijide ulanmaň.
- `expire` diňe abuna hukugyna täsir edýär (möhleti geçen ulanyjy boş
  abuna alýar); `status=disabled` ulanyjyny ýadro konfigurasiýasyndan
  aýyrýar.
- Clash abunasynda diňe `proxies`, bir `SELECT` topary we `MATCH` düzgüni
  bar. Ýerleşýiş ýoly boýunça bölüşdirmäni klientde goşuň.
- REALITY hususy açaryndan açyk açar alyp bolmasa (mysal üçin konfigurasiýada
  ýer tutaryjy galan bolsa), baglanyşykda `pbk` ýok we REALITY el gysmasy
  gutarmýar.
- Düwüni öçürmek maşyndaky işledilen konfigurasiýany pozmaýar; serweri
  aýratyn işden çykaryň.
- nginx ýasama konfigurasiýasy we `index.html` serwer tarapyndan döredilýär
  we dolandyrylýar. `index.html`-däki belgini aýyrsaňyz, sahypa öz
  sahypaňyz bolýar, ýöne obraz täzelemesi üýtgedilmedik sahypalary täzeläýär.
- Ýasama saýt TLS 1.3 + `X25519MLKEM768:X25519`, PQ däl yza gaýtma ýok we
  bu diňe obrazyň içinde sazlanýar.
- `X-Vela-Server` serweriň şahsyýet sözbaşysy (köne ady `X-Lessv-Node` hem
  kabul edilýär), `/dev/shm/lessv-decoy.sock` bolsa REALITY-niň `dest`-i: ikisi
  hem önümiň ady däl, doňdurylan protokol bahalarydyr.
- `BLOCK` uly harplar bilen ýazylmaly; kiçi `block` ýol berilýän çykyş
  hasaplanýar.
- WARP registrasiýasy Cloudflare app API-sini ulanýar; şowsuzylykda 502
  gaýtarýar we ýarym konfigurasiýa ýazmaýar. Her preset synagda täze enjam
  hasaba alýar; panel enjam kepillerini saklamaýar.
- GeoIP rules-dat full wersiýasyny ulanýar; lite wersiýa islendik sebitiň
  `geoip:` düzgüni üçin ýeterlik däl.
- Staging şahadatnamalary täzelenmeýär we 7 günden soň pozulýar; uzak
  möhletli synag düwüni üçin Test issue-ny täzeden işlediň.
- Bu gollanma protokol 3-i we `vela-server` obrazyny beýan edýär; häzirki
  taglary serwer ammaryndan görüň.

### 8. Goşmaça okamak

- Düwün ↔ panel protokoly: [`docs/PROTOCOL.md`](docs/PROTOCOL.md)
- Şahadatnamalar, nginx we ýalňyşlyklary düzetmek:
  [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Arhitektura, işläp düzmek, synaglar, çykarylyşlar:
  [`docs/dev/`](docs/dev/README.md)

### 9. Biraz ýumors

- Türkmençede “düwün” hem “node”, hem “knot” manylaryny berýär; DNS
  ýalňyş bolsa, ikinji many dogry bolýar.
- Düwün `healthy` diýýär, ýöne DNS ýazgysy ýok. Bu tehniki ýagdaý däl,
  optimizm.
- Düwün işlemeýär diýip, ilki kabeli barlaň; kabel sag bolsa, özüňizi barlaň.
- `last_error` boş bolsa gowy; doly bolsa, düwün size hat ýazýar.
- Gorag diwary 80/443-i açýar, 22-ni ýapýar; düwün özüni howpsuz duýýar,
  siz hem 22-ni barlaň.

---

## License

Vela is licensed under the GNU Affero General Public License, version 3 or
later. The full text is in [`LICENSE`](LICENSE).

## Credits

Vela rests on open-source work for most of its machinery. The debt is large,
and the projects behind it are left unnamed in this document.
