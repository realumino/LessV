# LessV — P1a 执行计划

> 依据 `PLAN.md` §8 P1a。执行工件（不是产品文档），P1c 结束时删除。
> 状态：**就绪**：Cloudflare/Linode token、zone/hostname、SSH key 已检查（见 §0.1）；可以执行 P1a.0/P1a.1。真实客户端可后置。
> 执行边界：在你确认 §2 的输入前，不创建 Cloudflare/Linode 资源；本文件只是计划。
> 基线：P0 本机验收完成；云端未部署；三个源仓库 `git status` 干净。

---

## 0. 目标与边界

**目标（P1a 完成标准）**

1. 面板部署在自定义域（合并 P0.8 的云端验收）。
2. 两台真实 Linux VPS（Linode）：`lessv-server` 装 Xray + agent，enroll，应用一份**临时** REALITY 配置（`dest` 用公网站点）；`lessv-client` 跑 Xray 客户端探针。
3. 面板创建用户、生成订阅；订阅在真实客户端导入后能上网。
4. agent / Xray / 面板重启后收敛；禁用/过期用户订阅为空。
5. 全部测试绿；agent E2E 不再 skip。

**明确不做**

REALITY preset、nginx 自偷、ACME/证书、R2/Workflows、`protocol: 2`、`X-Lesserv-Node` 改名、证书端点、stats 存储、B 拓扑。临时公网 `dest` 是 P1a 夹具，P1b 用自偷 + LE 证书替换。

---

## 0.1 就绪检查结果（2026-10-25，本次）

| 项 | 结果 |
|---|---|
| Cloudflare token | `active`；可读 account/zone/D1/Workers scripts/Workers routes |
| Cloudflare zone | `example.com` status `active`；NS `ns1.example.net` / `ns2.example.net` |
| Cloudflare 现有资源 | Workers scripts 0；Workers routes 0；custom domains 0；D1 无 `lessv`（只有 `certworker`/`lesserv-cloud`） |
| Cloudflare DNS scope | **已补 Zone `DNS:Edit`**；`GET /dns_records` 200（权限生效有几秒延迟） |
| `cp.example.com` | DNS records 0；公网 A/AAAA/CNAME 无记录，当前未被占用。apex 只有邮件相关 MX/TXT，无 A/AAAA 冲突 |
| `wrangler whoami` | 能识别账号 `example-account`；提示缺 User `User Details:Read`（仅影响显示 email，不影响 deploy） |
| Linode token | scopes 正好是 `account:read_only images:read_only linodes:read_write` |
| Linode 账号 | 已有 1 台运行中实例（`unrelated-jp01`, `jp-tyo-3`）；未发现阻止新建 2 台的硬限制 |
| Linode 可用性 | `jp-tyo-3` / `sg-sin-2` 的 `g6-nanode-1` 均 available；`linode/debian12` available |
| SSH key | `~/.ssh/lessv_p1a_ed25519` 已生成（ED25519，指纹 `SHA256:lmEjicp15tJEAAO7RIrQPO+NxjdU+ycuw8diMobI27s`） |
| 本地文件权限 | `~/.lessv/cloudflare.env`、`~/.lessv/linode.env` 已用 `icacls` 限制为当前用户只读；私钥同样限制 |
| 尚未做 | `.env.production` 未生成；`wrangler.jsonc` 仍是 `panel.lessv.local`；P1a.3 会改成 `cp.example.com` |

结论：**两个 API key、Zone `DNS:Edit` 和 SSH key 已就绪，可以开始 P1a.0/P1a.1**。剩余可选项只有 `User Details:Read`（只影响 `wrangler whoami` 显示 email，不影响部署）。

## 0.2 执行参数（已定）

| 参数 | 值 |
|---|---|
| Cloudflare zone | `example.com` |
| 面板主机名（cp-host） | `cp.example.com` |
| Linode server | `lessv-server` / `jp-tyo-3` / `g6-nanode-1` / `linode/debian12` |
| Linode client | `lessv-client` / `sg-sin-2` / `g6-nanode-1` / `linode/debian12` |
| 节点 id / label | `tokyo01` / `Tokyo` |
| 测试用户 | `alice` |
| REALITY 临时 dest / SNI | `www.microsoft.com:443` / `www.microsoft.com` |
| 面板路由 | `cp.example.com`（custom_domain） |

执行时把文中的 `<cp-host>` 替换为 `cp.example.com`，`<server 公网 IP>` 从 `~/.lessv/acceptance/linode.json` 的 `.server.ipv4` 读取。

---

## 1. 调研结论（已验证 / 推断 / 未决）

**调研环境**：本轮全部在 Windows + Git Bash + Node + Python 上完成，**没有本地 Linux/VPS**。仓库、systemd unit、`install.sh` 是静态阅读；Xray CLI 行为用官方 Windows 64 二进制实测；Xray 官方 unit 的 `User=nobody`/`/usr/local/etc/xray/config.json` 来自官方安装脚本文档/镜像，**未在 Linux 上执行**，P1a 会在 Linode 上复核。`wrangler dev` + 本地 D1 + admin 认证是 Windows workerd 实测。P1a 的 Linux 命令全部通过 SSH 在 Linode 上跑；本地 Windows 只负责打包、调 Cloudflare/Linode API、scp/ssh。

### 1.1 已验证（会改变执行方式）

| # | 事实 | 验证方式 | 影响 |
|---|---|---|---|
| V1 | P0 本机绿：Worker 241 / 32 files，前端 27，agent 33 passed + 4 skipped | 本机重跑 `npm test`、`npm --prefix frontend test`、`pytest` | P1a 基线成立 |
| V2 | `wrangler.jsonc` 的 route 仍是占位 `panel.lessv.local`，`.env.production` 不存在 | 读文件 / `ls` | P1a 必须做首次云部署 |
| V3 | `agent/install.sh` 把包复制到 `/usr/local/lib/lessv-agent/`，但 `lessv-agent.service` 没有 `PYTHONPATH` | 读 `agent/install.sh` + `agent/systemd/lessv-agent.service` | **直接装完必失败**：`python3 -m lessv_agent run` 找不到包。P1a 必须修 unit |
| V4 | `agent/install.sh` 权限是 `100644`（不可执行）；不检查 xray；不创建 `/etc/lessv/certs`、`/var/www/lessv-decoy` | `git ls-files -s` + 读脚本 | P1a 必须改安装器 |
| V5 | 官方 Xray unit（文档/镜像）是 `User=nobody`、`ExecStart=... -config /usr/local/etc/xray/config.json`；agent 写 `/var/lib/lessv/config.json`（`mkstemp` 默认 0600 root） | 读 agent `apply.py` + Xray-install 文档（**未在 Linux 实测**） | **高概率硬阻塞（文档推断）**：Xray 读错文件且 nobody 读不了 0600 root 文件。P1a 必须装 systemd drop-in（`User=root` + 指向 agent 路径），并在 Linode 上 `systemctl cat xray` 复核；drop-in 对“root”和“nobody”两种 unit 都安全 |
| V6 | Xray 26.10.21：`xray test -c` 是未知命令（exit 2）；`xray run -test -c` 与旧式 `xray -test -config` 都可用 | 本机下载 Xray Windows 64 实测 | agent 现有“先试 `test -c`、靠输出含 unknown 再 fallback”能工作但脆弱；P1a 改为现代命令优先 |
| V7 | Xray 的 inbound `settings.flow` 是 `clients[].flow` 的默认值；allocator 不写 per-client flow 不会导致 Vision 失败 | Xray 官方 VLESS 文档 | 附录 A 的配置与现有渲染/链接参数可兼容；VPS 上再用真实客户端确认 |
| V8 | `expire` 只影响订阅资格（`isEntitled`），**不影响** Xray 渲染；只有 `status=disabled` 才会从 `settings.clients` 移除 | 读 `user_service.ts` + `config_service.ts` | P1a 验收只能要求“过期后订阅为空”，不能声称“过期即断连”；后者超出 P1a |
| V9 | agent E2E 已过期：找 `LessV-Cloud/src/worker.py`、`uv run pywrangler`、`--var REALITY_KEY_SECRET`、D1 `lesserv` | 读 `agent/tests/test_e2e_pull.py` + 运行结果 4 skipped | P1a 必须重写，否则“测试全绿”是假绿 |
| V10 | `wrangler dev --var ADMIN_KEY:... --var KEY_SECRET:...` 能绑定 secret；配合本地 D1 migrations 后 admin API 200 | 本机实测（临时端口 + `--persist-to`） | E2E 可以用真 workerd，不需要 uv/旧仓库 |

### 1.2 推断（需在真实环境复核）

| # | 推断 | 复核点 |
|---|---|---|
| I1 | VPS 是全新 Debian 12 / Ubuntu 22.04+，root SSH，IPv4，443 空闲，可出站 443 | `cat /etc/os-release`、`ss -ltnp`、`curl -I https://www.microsoft.com` |
| I2 | Cloudflare token 需要 Account `Workers Scripts:Edit`、`D1:Edit`，Zone `Workers Routes:Edit`、`Zone:Read`；自定义域可能还需要 Zone `DNS:Edit` | `wrangler whoami` + 首次 deploy 的错误信息 |
| I3 | 真实客户端支持 REALITY + Vision（v2rayN / NekoBox / Shadowrocket / Hiddify） | 用户实际导入；自动化 Xray 客户端探针兜底 |
| I4 | 官方 Xray 安装脚本创建 `xray.service`，路径 `/usr/local/bin/xray` | `systemctl cat xray`、`command -v xray` |

### 1.3 未决（必须由操作者确认）

- Cloudflare 账号、zone（域名）、面板主机名（如 `cp.example.com`）。
- Linode 账号是否可创建 2 台 Nanode、区域偏好（默认 `jp-tyo-3` + `sg-sin-2`）。
- 真实客户端型号（可后置）。
- 是否已有 Cloudflare Worker/D1 名为 `lessv`（避免覆盖）。

---

## 2. 需要你提供的输入（API Key / 凭证 / 决策）

### 2.1 总表

| # | 输入 | 用途 | P1a 必需 | 提供方式 |
|---|---|---|---|---|
| E1 | Cloudflare 账号 + 已托管 zone | 面板自定义域、D1 | 是 | 告知 zone 名；token 见 E2 |
| E2 | **Cloudflare API Token**（scoped） | `wrangler deploy`、D1、custom domain | 是（或改用 `wrangler login`） | 文件 `~/.lessv/cloudflare.env`，**不要贴聊天** |
| E3 | 面板主机名 | `cp.<zone>` | 是 | 决定后写入本地 `wrangler.jsonc` |
| E4 | **Linode API Token**（scoped） | 创建两台 VPS（server + client） | 是 | 文件 `~/.lessv/linode.env`，**不要贴聊天** |
| E5 | Linode 账号可创建实例 / 区域偏好 | 选 region/type | 是 | 告知，或让我用 token 查询 |
| E6 | 真实客户端 | 最终人工验收 | 是（可后置） | 你导入订阅；我提供 URL/QR |
| E7 | `ADMIN_KEY` / `KEY_SECRET` | Worker secrets | **否**（我生成） | 本地 `.env.production` 0600；不要贴聊天 |
| E8 | 节点 token | agent enroll | **否**（面板生成） | 面板 mint；临时文件/stdin；用完删除 |
| E9 | 订阅 token | 客户端导入 | **否**（面板生成） | 面板显示/QR；capability secret |
| E10 | `CF_DNS_API_TOKEN` | P1b ACME | **否，P1a 不要** | P1b 再单独创建 zone-scoped DNS token |
| E11 | 已有 VPS 的 SSH（可选） | 不想用 Linode 时 | 否 | `~/.ssh/config` 别名；**不要提供私钥内容** |

### 2.2 Cloudflare API Token（唯一必须由你提供的外部 API key）

**创建**：Cloudflare Dashboard → My Profile → API Tokens → Create Token → Custom token。

| 范围 | 权限 | 必需性 |
|---|---|---|
| Account | Workers Scripts → Edit | 必需 |
| Account | D1 → Edit | 必需（建库 + 远端 migrations） |
| Zone | Workers Routes → Edit | 必需（custom domain / route） |
| Zone | Zone → Read | 必需（解析 zone） |
| Zone | DNS → Edit | 建议（custom domain 自动建 DNS 记录；若首次 deploy 报 DNS 权限错误再加） |

- 严格最小集：前四项（Workers Scripts Edit、D1 Edit、Workers Routes Edit、Zone Read）。`DNS:Edit` 只在首次 deploy 创建 custom domain DNS 记录报错时补。
- Account resources：只勾目标账号；Zone resources：只勾目标 zone。
- 多账号时再加 `CLOUDFLARE_ACCOUNT_ID`，避免 wrangler 选错账号。
- 若 `wrangler whoami` 报权限错误，补 User `User Details:Read` + `Memberships:Read`；若 deploy 报 account read，补 Account `Account Settings:Read`；若 custom domain 报 DNS，补 Zone `DNS:Edit`。这些是排错项，不是默认最小集。
- **不要用 Global API Key**；不要给 All zones / All accounts。
- 建议给 token 设一个到期日（如 7 天）；P1b 需要时再新建。

**提供方式（推荐，文件不在仓库内）**：

```bash
mkdir -p ~/.lessv
cat > ~/.lessv/cloudflare.env <<'EOF'
CLOUDFLARE_API_TOKEN=粘贴你的token
CLOUDFLARE_ACCOUNT_ID=可选
EOF
chmod 600 ~/.lessv/cloudflare.env
```

Windows 上 `chmod` 可能不生效，可加：

```powershell
icacls "$HOME\.lessv\cloudflare.env" /inheritance:r /grant:r "$env:USERNAME:R"
```

**验证**：

```bash
set -a; . ~/.lessv/cloudflare.env; set +a
npx wrangler whoami
```

**替代方案**：你在本机跑 `npx wrangler login`，浏览器授权；之后不需要 token 文件。缺点：OAuth 权限较宽、会过期；P1a 一次性可以接受。二选一，不要同时配置。

**绝对不要**：

- 把 token 写进 `.env.production`（`--secrets-file` 会把它当 Worker secret 上传）。
- 把 token 贴进聊天、issue、commit、命令 argv（`ps` 可见）。
- 把 `~/.lessv/cloudflare.env` 放进仓库。

### 2.3 Linode API Token（第二把外部 API key）

P1a 用 **两台 Linode**：`lessv-server`（Xray + agent）和 `lessv-client`（Xray 客户端探针）。两台都选 Nanode 1GB（`g6-nanode-1`，约 $0.0075/hr/台），server 建议 `jp-tyo-3`，client 建议 `sg-sin-2`；两者都在墙外，不需要考虑 GFW。client 在探针通过后删除；server 保留给你做真实客户端测试。

**创建**：cloud.linode.com → My Profile → API Tokens → Create Personal Access Token → 选 scopes。

| Scope | 用途 | 必需性 |
|---|---|---|
| `linodes:read_write` | 创建/查询/删除/重启两台 Linode | 必需 |
| `account:read_only` | 创建实例时读取账号/可用性 | 必需（官方 create 流程会读） |
| `images:read_only` | 选择 `linode/debian12` 镜像 | 必需（或可省略，若镜像 id 已固定；保留更稳） |
| 其他所有 scope | — | **No Access** |

- 不需要 `account:read_write`（不创建 token）、不需要 `firewall:read_write`（不建 Cloud Firewall）、不需要 SSH key scope（`authorized_keys` 是 create 请求里的字段）。
- 设 1–7 天到期；P1a 清理完就 revoke。
- 存放：

```bash
mkdir -p ~/.lessv
cat > ~/.lessv/linode.env <<'EOF'
LINODE_TOKEN=粘贴你的token
EOF
chmod 600 ~/.lessv/linode.env
```

**验证**：

```bash
set -a; . ~/.lessv/linode.env; set +a
curl -sS -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/account | head -c 300
curl -sS -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/linode/instances | head -c 300
```

**SSH key**：我生成一把专用无口令 key（`~/.ssh/lessv_p1a_ed25519`，0600），通过 Linode `authorized_keys` 注入 root；不需要你提供私钥。两台实例创建后写 `~/.ssh/config` 的 `lessv-server`/`lessv-client` 块（带 `# lessv-p1a` 标记，清理时删除），或每次用 `ssh -i`。

**如果你已有 VPS**：跳过 Linode，给我 `~/.ssh/config` 别名（root 或免密 sudo），我按同样流程跑；但双 VPS 自动探针需要第二台，或退回本机 Xray 客户端探针。

### 2.3.1 为什么是两台 VPS

- server：真实 Xray REALITY + agent + 订阅。
- client：真实 Xray 客户端，从墙外连 server，验证 REALITY/flow/UUID/路由；避免“链接参数对但协议不通”以及本机网络/墙的干扰。
- 真实客户端（你的 v2rayN/NekoBox/Shadowrocket）是最终人工验收；订阅链接会保留，你随时导入。

### 2.4 域名 / 主机名

- zone 必须在你的 Cloudflare 账号下且状态 Active。
- 面板主机名必须在目标 zone 内、当前没有冲突的 A/AAAA/CNAME 记录；`wrangler deploy` 会创建 custom domain。
- 建议同时预留 P1b 的节点域名（如 `tokyo01.<zone>`）和证书域名（如 `<zone>` 或 `*.<zone>`），P1a 不用，但避免 P1b 改名。

### 2.5 我生成、不需要你提供的

| 值 | 生成方式 | 存放 | 备注 |
|---|---|---|---|
| `ADMIN_KEY` | 32 random bytes base64url | `.env.production`（gitignored，0600） | 你从文件读取后粘贴到 SPA 登录；可轮换 |
| `KEY_SECRET` | 32 random bytes base64 | `.env.production` | 封装 REALITY 私钥；**不可轮换**，务必备份 |
| 节点 token | 面板 `POST /nodes/:id/token` | 临时文件 → stdin → 删除 | 只显示一次；不要进 shell history |
| 订阅 token | 面板 `POST /users/:u/sub-token` | 面板/QR/临时文件 | capability URL；泄露就 rotate |
| Linode root 密码 | 每台实例随机生成 | `~/.lessv/acceptance/linode.json` 0600 | SSH key 失效时用 LISH 控制台；用完可丢弃 |
| P1a SSH key | `ssh-keygen -t ed25519 -N ""` | `~/.ssh/lessv_p1a_ed25519`（0600） | 仅用于两台临时 VPS；清理时删除 |
| Linode 实例清单 | `scripts/linode_provision.mjs` | `~/.lessv/acceptance/linode.json` 0600 | id/label/IP/region/root_pass；不要提交 |

`KEY_SECRET` 丢失 = 所有已封装的 REALITY 私钥不可读；备份到密码管理器，不要只放在仓库目录。

### 2.6 P1b 才需要的（现在不要创建）

- `CF_DNS_API_TOKEN`：Zone `DNS:Edit` + `Zone:Zone:Read`，只给目标 zone；P1b 作为 Worker secret 上传，用于 DNS-01。
- 不要复用 E2 的 deploy token：它权限更大，且 P1b 的 DNS token 应最小化。

### 2.7 真实客户端与双 VPS 探针

- 自动化：`lessv-client` VPS 上跑真实 Xray 客户端，连 `lessv-server`，用 SOCKS + `curl` 验证出口 IP 和 HTTPS；这是 P1a 工程验收。
- 真实客户端：你最后导入订阅链接（v2rayN/NekoBox/Shadowrocket/Hiddify 至少一个）并确认上网；这是 P1a 的人工验收项，可以在我交付链接后进行。
- 订阅链接会保留在面板/`~/.lessv/acceptance/sub.json`；server 在你确认前不删除。

### 2.8 凭证处理规则（执行期间）

1. 任何 secret 不进 git、不进聊天、不进 argv；用文件/stdin/env。
2. 命令前不开 `set -x`；不 `cat` token 文件；验证只查长度/权限/存在性。
3. 临时 token 文件放 `~/.lessv/acceptance/`（0600），用完删除。
4. `.env.production`、`.dev.vars`、`wrangler.jsonc`、`frontend/dist`、`dist/` 都在 `.gitignore`；提交前 `git status` 复核。
5. 订阅 URL 是 capability secret；截图/日志打码；泄露后 `POST /sub-token` 轮换。
6. `LINODE_TOKEN` 放 `~/.lessv/linode.env`（0600），不写 `.env.production`；只给 `linodes:read_write`、`account:read_only`、`images:read_only`；P1a 清理后 revoke。
7. Linode root 密码/实例清单放 `~/.lessv/acceptance/linode.json`（0600）；client 探针通过后删除 client，server 在你确认后删除。

---

## 3. 执行阶段

### P1a.0 外部输入与预检（阻塞闸门）

**任务**

1. 收齐 §2 的 E1–E5；E6 可后置。把选择写进本文件末尾的“执行记录”（主机名、Linode 区域、客户端型号；不写 secret）。
2. 验证 Cloudflare：`npx wrangler whoami` 显示目标账号；`npx wrangler d1 list` 没有同名冲突（或确认可复用）。
3. 验证 DNS：`dig +short <cp-host>` 为空或指向可替换记录；zone Active。
4. 验证 Linode token：`GET /v4/account` 200、`GET /v4/linode/instances` 200；查询 `jp-tyo-3`/`sg-sin-2` 的 `g6-nanode-1` 可用性；确认账号可创建 2 台。
5. 生成 P1a SSH key（若不存在）：

```bash
mkdir -p ~/.lessv/acceptance
chmod 700 ~/.lessv ~/.lessv/acceptance
test -f ~/.ssh/lessv_p1a_ed25519 || ssh-keygen -t ed25519 -f ~/.ssh/lessv_p1a_ed25519 -N "" -C lessv-p1a
chmod 600 ~/.ssh/lessv_p1a_ed25519
```

6. 若你已有 VPS（E11）：验证 `ssh -o BatchMode=yes <alias> true`、root/免密 sudo、443 空闲、出站 443、时间同步；跳过 Linode 创建。

**闸门 G0**

- [ ] `wrangler whoami` 正确
- [ ] `dig` 无冲突
- [ ] Linode token 可读 account/instances；目标区域有 `g6-nanode-1`
- [ ] P1a SSH key 已生成（0600）
- [ ] 真实客户端已确定（可后置）
- [ ] 已有 VPS 时：SSH/443/出站/时间通过

任何一项不满足就停在这里；不要用代码绕过基础设施缺失。

---

### P1a.1 Agent 安装 / Xray 集成修复（本机代码，无云）

**改动文件**

| 文件 | 改动 |
|---|---|
| `agent/systemd/lessv-agent.service` | 加 `Environment=PYTHONPATH=/usr/local/lib/lessv-agent`；`ExecStart=/usr/bin/env python3 -m lessv_agent run` |
| `agent/install.sh` | 可执行位；检查 xray/systemd/python3；建目录；装 Xray drop-in；幂等重装；enroll 后 `enable` + `restart` |
| `agent/lessv_agent/xray.py` | `test_config` 改为 `xray run -test -c` 优先，旧式 `xray -test -config` fallback |
| `agent/tests/test_xray.py`（新） | 覆盖现代命令成功、fallback 成功、两者失败 |
| `agent/tests/test_install_assets.py`（新） | 静态钉住 unit 的 PYTHONPATH/ExecStart、install.sh 的目录/drop-in、`sh -n` |
| `scripts/release_agent.mjs`（新） | 从 `HEAD:agent` 打 tarball + sha256；校验内容 |
| `scripts/linode_provision.mjs`（新） | 创建/查询/删除两台 Linode；写 inventory + SSH config 块 |
| `scripts/subscription_to_xray.mjs`（新） | 从订阅 URI 生成 Xray 客户端 JSON（不打印凭据） |
| `scripts/p1a_smoke.mjs`（新） | 只读验收脚本：health/认证/sync/links/sub/REALITY 参数 |
| `package.json` | 加 `"release:agent": "node scripts/release_agent.mjs"` |
| `.gitignore` | 加 `dist/` |

**unit 目标内容**

```ini
[Service]
Type=simple
Environment=PYTHONPATH=/usr/local/lib/lessv-agent
ExecStart=/usr/bin/env python3 -m lessv_agent run
Restart=on-failure
RestartSec=5
User=root
Group=root
ReadWritePaths=/etc/lessv /var/lib/lessv
NoNewPrivileges=true
```

**install.sh 目标行为**

```sh
need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 not found" >&2; exit 1; }; }
[ "$(id -u)" -eq 0 ] || { echo "error: run as root" >&2; exit 1; }
need python3; need systemctl
XRAY_BIN="$(command -v xray || true)"
if [ -z "$XRAY_BIN" ] && [ -x /usr/local/bin/xray ]; then XRAY_BIN=/usr/local/bin/xray; fi
[ -n "$XRAY_BIN" ] || { echo "error: xray not found; install Xray first" >&2; exit 1; }
systemctl cat xray >/dev/null 2>&1 || { echo "error: xray.service not found; install Xray first" >&2; exit 1; }

install -d -m 0755 /etc/lessv /etc/lessv/certs /var/lib/lessv /var/www/lessv-decoy /usr/local/lib/lessv-agent
[ -f /var/www/lessv-decoy/index.html ] || printf '<!doctype html><title>LessV</title>\n' > /var/www/lessv-decoy/index.html

rm -rf /usr/local/lib/lessv-agent/lessv_agent
cp -R "$SRC_DIR/lessv_agent" /usr/local/lib/lessv-agent/
chmod -R a=rX /usr/local/lib/lessv-agent
install -m 0644 "$SRC_DIR/systemd/lessv-agent.service" /etc/systemd/system/lessv-agent.service

install -d -m 0755 /etc/systemd/system/xray.service.d
cat > /etc/systemd/system/xray.service.d/99-lessv.conf <<EOF
[Service]
User=root
Group=root
ExecStart=
ExecStart=$XRAY_BIN run -config /var/lib/lessv/config.json
EOF
systemctl daemon-reload

PYTHONPATH=/usr/local/lib/lessv-agent \
  python3 -m lessv_agent enroll --cp "$CP_URL" --node "$NODE_ID"

systemctl enable lessv-agent.service
systemctl restart lessv-agent.service
```

补充：

- drop-in 已存在且内容不同：先备份 `99-lessv.conf.bak.$(date +%s)`，再覆盖；打印警告。
- 不在 install.sh 里 `systemctl restart xray`：第一次没有 config，restart 只会失败；agent 写完 config 后会 restart。
- `chmod +x agent/install.sh` 并用 `git update-index --chmod=+x` 固化。
- `release_agent.mjs` 用 `git archive --format=tar.gz --prefix=lessv-agent-<ver>/ HEAD:agent install.sh lessv_agent systemd`；要求 `git status --porcelain agent` 为空（先 commit 再打包）。输出 `dist/lessv-agent-<ver>.tar.gz` + `.sha256`。

**闸门 G1**

```bash
sh -n agent/install.sh
node --check scripts/linode_provision.mjs
node --check scripts/subscription_to_xray.mjs
node --check scripts/p1a_smoke.mjs
python -m pytest -q agent/tests
npm run release:agent
tar -tzf dist/lessv-agent-0.1.0.tar.gz
```

期望：pytest 全绿（新增测试后数量 ≥ 33+）；tarball 含 `install.sh`、`lessv_agent/*.py`、`systemd/lessv-agent.service`，不含 tests/`__pycache__`。

**Commit 1**：`P1a: harden agent install and Xray integration`

---

### P1a.2 重写 agent E2E 为 LessV 本地 plane

**目标**：`agent/tests/test_e2e_pull.py` 在 LessV 内自动启动真 workerd + 本地 D1，不再 skip；同时覆盖 REALITY 链接参数和禁用/过期订阅。

**具体改法**

1. `_repo_root()`：从测试文件向上找到含 `src/worker.ts` + `wrangler.example.jsonc` 的目录；找不到才 skip（不是找 sibling `LessV-Cloud`）。
2. 找 `npx`：`shutil.which("npx")` / Windows `npx.cmd`；Windows 用 `["cmd","/c","npx", ...]`。
3. `_start_plane`：
   - `node scripts/stub_frontend_dist.mjs`
   - `node scripts/ensure_wrangler_config.mjs`
   - `npx wrangler d1 migrations apply DB --local --persist-to <tmp>/plane-state`
   - `Popen(npx wrangler dev --port <free> --persist-to <tmp>/plane-state --var ADMIN_KEY:<random> --var KEY_SECRET:<random>)`
   - POSIX `start_new_session=True`；Windows 用 `taskkill /T /F`；清理时再按端口兜底杀一次。
   - 环境加 `WRANGLER_SEND_METRICS=false`。
4. `_http`：所有 admin 调用加 `Authorization: Bearer <admin_key>`。
5. `_authored_config`：改成附录 A 的 REALITY 形状（`settings.flow`、`streamSettings.realitySettings`、BLOCK + direct）。
6. 新增 `test_reality_links_and_subscription`：
   - `GET /api/admin/nodes/<id>/config/runtime`：`privateKey` 非空、`shortIds` 保留；
   - `GET /api/admin/users/<u>/links`：URI 含 `security=reality`、`sni=www.microsoft.com`、`pbk`、`sid`、`spx=%2F`、`flow=xtls-rprx-vision`、`type=tcp`、host=节点地址、port=443；
   - `GET /sub/<token>`：base64 解码后与 links 的 URI 逐字节一致。
7. 新增 `test_disable_and_expire`：
   - 禁用 → 下一轮 apply 后 live config 不含 `user@direct`；`sync in_sync`；`/sub` 空；
   - 重新启用 → live 恢复；`/sub` 非空；
   - `expire` 设为过去 → `/sub` 空（**不要**断言 config 移除；V8 已知行为）；恢复。
8. 保留现有 lifecycle 测试；只改 seed/config/auth/清理，不放宽断言。

**闸门 G2**

```bash
python -m pytest -q agent/tests
```

期望：0 skipped（除非本机缺 `npx`）；E2E 用时约 30–90s；失败时打印 plane 日志尾部。

**Commit 2**：`P1a: rewrite agent E2E against the LessV plane`

---

### P1a.3 部署面板（合并 P0.8）

**任务**

1. 编辑本地 `wrangler.jsonc`（gitignored）：

```jsonc
"routes": [{ "pattern": "<cp-host>", "custom_domain": true }]
```

确认 `workers_dev:false`、`preview_urls:false`、D1 `lessv`、`secrets.required` 为 `ADMIN_KEY`/`KEY_SECRET`。

2. 生成 `.env.production`（若不存在；已有则只校验两个键存在，不覆盖）：

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))" > .env.production
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))" >> .env.production
chmod 600 .env.production
```

3. 部署：

```bash
set -a; . ~/.lessv/cloudflare.env; set +a
npm run deploy -- --secrets-file .env.production
```

脚本顺序：SPA build → `wrangler deploy`（首次自动建 D1 并写回 id）→ 远端 migrations → `/api/health` 200。

4. 云端补充检查：

```bash
set -a; . ~/.lessv/cloudflare.env; . .env.production; set +a
curl -sS -o /dev/null -w '%{http_code}\n' https://<cp-host>/api/health            # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://<cp-host>/api/admin/nodes       # 401
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ADMIN_KEY" \
  https://<cp-host>/api/admin/nodes                                               # 200
npx wrangler secret list                                                          # 只有 ADMIN_KEY/KEY_SECRET
npx wrangler d1 migrations apply DB --remote                                      # 无待应用
```

5. 浏览器打开 `https://<cp-host>/admin/`，粘贴 `.env.production` 的 `ADMIN_KEY`；能登录、刷新保持、logout 清除。
6. 节点 `tokyo01` 推迟到 P1a.4 创建：那时才有 server 公网 IP。

**闸门 G3**

- [ ] health 200，证书有效（无 `-k`）
- [ ] 无 key 401、错 key 401、对 key 200
- [ ] `/admin/` 可登录；D1 迁移完成；secret 只有两个

**Commit 3**：`P1a: deploy the panel to <cp-host>`（只提交文档/状态，不提交 secret）

---

### P1a.4 Linode 两台 VPS + agent 安装

**任务**

0. 建本地验收目录：`mkdir -p ~/.lessv/acceptance && chmod 700 ~/.lessv ~/.lessv/acceptance`。

#### P1a.4.0 创建两台 Linode（server + client）

```bash
set -a; . ~/.lessv/linode.env; set +a
node scripts/linode_provision.mjs create \
  --token-file ~/.lessv/linode.env \
  --ssh-key ~/.ssh/lessv_p1a_ed25519.pub \
  --server-region jp-tyo-3 \
  --client-region sg-sin-2 \
  --type g6-nanode-1 \
  --image linode/debian12 \
  --out ~/.lessv/acceptance/linode.json
```

脚本行为：

- `POST /v4/linode/instances` 两次，labels `lessv-server`/`lessv-client`，tags `lessv-p1a`；`authorized_keys` 注入 P1a 公钥；`root_pass` 随机并写入 inventory。
- 轮询 `GET /v4/linode/instances/{id}` 直到 `status=running` 且有公网 IPv4；超时 5 分钟。
- 写 `~/.lessv/acceptance/linode.json`（0600），形状：`{"server": {"id", "label", "region", "type", "ipv4", "root_pass"}, "client": {...}}`。
- 写/替换 `~/.ssh/config` 的 `# lessv-p1a begin` … `# lessv-p1a end` 块：

```sshconfig
Host lessv-server
  HostName <server-ip>
  User root
  IdentityFile ~/.ssh/lessv_p1a_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new

Host lessv-client
  HostName <client-ip>
  User root
  IdentityFile ~/.ssh/lessv_p1a_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
```

- 输出只含 label/IP/id；不打印 token/root_pass。
- `--list` 列出 tags `lessv-p1a` 的实例；`--delete --label lessv-client` 删除单台。
- 不创建 Cloud Firewall（因此 token 不需要 `firewall:*`）；Linode 默认放行 22/443。
- 成本：`g6-nanode-1` 约 $0.0075/hr/台；两台跑一天 <$0.40。client 探针后删除。

如果 `jp-tyo-3`/`sg-sin-2` 的 `g6-nanode-1` 不可用，脚本应打印可用 region 并退出；换 `jp-osa`/`de-fra-2`/`us-east` 等，不要静默换 plan。

#### P1a.4.1 两台预检 + Xray

```bash
for h in lessv-server lessv-client; do
  ssh "$h" 'cat /etc/os-release | head -3; uname -m; ss -ltnp | grep ":443" || true; timedatectl | head -3'
  ssh "$h" 'curl -I -sS https://www.microsoft.com | head -3'
done
```

装依赖 + Xray（两台）：

```bash
for h in lessv-server lessv-client; do
  ssh "$h" 'apt-get update && apt-get install -y curl ca-certificates python3'
  ssh "$h" 'bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install'
  ssh "$h" 'xray version'
done
```

- client 只做探针：装完停掉/禁用默认 Xray service，避免默认配置占用端口：

```bash
ssh lessv-client 'systemctl stop xray; systemctl disable xray'
```

- server 保留 Xray service；agent 安装器会加 drop-in。443 被 nginx/apache 占用时先停冲突服务（P1b 再把 nginx 移到 8443）。
- 如果官方安装脚本网络失败：用 release zip 手工安装，保证 `xray` 在 PATH、`xray.service` 存在。

#### P1a.4.2 server 的 agent 安装

1. 本机打包 + 传输：

```bash
npm run release:agent
scp dist/lessv-agent-0.1.0.tar.gz lessv-server:/tmp/
ssh lessv-server 'sha256sum /tmp/lessv-agent-0.1.0.tar.gz'
sha256sum dist/lessv-agent-0.1.0.tar.gz
```

2. 创建节点（address = server 公网 IP）+ mint token：

```bash
set -a; . .env.production; set +a
SERVER_IP=$(node -e "console.log(require(process.env.HOME + '/.lessv/acceptance/linode.json').server.ipv4)")
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d "{\"id\":\"tokyo01\",\"label\":\"Tokyo\",\"address\":\"$SERVER_IP\"}" \
  https://<cp-host>/api/admin/nodes
curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  https://<cp-host>/api/admin/nodes/tokyo01/token \
  > ~/.lessv/acceptance/node-token.json
chmod 600 ~/.lessv/acceptance/node-token.json
```

- 若节点已存在，`POST` 返回 409；用 `PUT /nodes/tokyo01` 更新 `address`，再 mint token。
- token 只写文件；不要打印。

3. 解包 + 安装（token 走 stdin；**不要** `ssh -t`，否则 getpass 读 `/dev/tty` 而不是管道）：

```bash
ssh lessv-server 'rm -rf /tmp/lessv-agent && mkdir -p /tmp/lessv-agent && tar -xzf /tmp/lessv-agent-0.1.0.tar.gz -C /tmp/lessv-agent --strip-components=1'
node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.env.HOME + '/.lessv/acceptance/node-token.json')).token + '\n')" \
  | ssh -o RequestTTY=no lessv-server 'cd /tmp/lessv-agent && ./install.sh --cp https://<cp-host> --node tokyo01'
rm -f ~/.lessv/acceptance/node-token.json
```

如果你手工装：`ssh -t lessv-server` 后执行 `./install.sh ...`，在提示处粘贴 token。

4. server 验证（不打印 token）：

```bash
ssh lessv-server 'stat -c "%a %U:%G %n" /etc/lessv/agent.toml; grep -E "^(cp_url|node_id) =" /etc/lessv/agent.toml'
ssh lessv-server 'systemctl show xray -p User -p ExecStart; systemctl is-enabled lessv-agent; systemctl is-active lessv-agent'
ssh lessv-server 'journalctl -u lessv-agent -n 40 --no-pager'
ssh lessv-server 'ls -ld /etc/lessv /etc/lessv/certs /var/lib/lessv /var/www/lessv-decoy; cat /var/www/lessv-decoy/index.html'
```

- `systemctl show xray -p User` 必须是 `User=root`；`ExecStart` 必须含 `/var/lib/lessv/config.json`。
- 如果另一个 drop-in 覆盖了我们的设置：`systemctl cat xray` 查顺序，调整文件名/内容后再 `daemon-reload`。
- agent 已 enroll：面板 fleet 的 `last_seen` 在 60s 内更新；`sync` 的 `desired_hash` 可能仍为 null（还没配置）。

**闸门 G4**

- [ ] 节点 `tokyo01` 的 address = server 公网 IP
- [ ] Xray 已安装且 service 存在
- [ ] agent.toml 0600、cp_url/node_id 正确
- [ ] xray drop-in 生效（root + `/var/lib/lessv/config.json`）
- [ ] `lessv-agent` enabled + active；journal 无 token
- [ ] 面板 fleet 看到节点 last_seen

---

### P1a.5 临时 REALITY 配置 + 首次 apply

**任务**

1. 生成 8 位 hex shortId：

```bash
openssl rand -hex 4
```

2. 把附录 A 的 JSON 存到 `~/.lessv/acceptance/reality-temp.json`（`privateKey` 留空；shortId 填入）。通过 UI 粘贴或 API 保存：

```bash
set -a; . .env.production; set +a
curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  --data-binary @~/.lessv/acceptance/reality-temp.json \
  https://<cp-host>/api/admin/nodes/tokyo01/config
```

3. 等 agent 收敛（heartbeat 30s + apply）：

```bash
curl -sS -H "Authorization: Bearer $ADMIN_KEY" \
  https://<cp-host>/api/admin/nodes/tokyo01/sync
```

期望：`desired_hash` 非空、`applied_hash == desired_hash`、`in_sync:true`、`health:"ok"`、`last_error:null`。最多等 60–90s。

4. server 验证：

```bash
ssh lessv-server 'xray run -test -c /var/lib/lessv/config.json'
ssh lessv-server 'systemctl status xray --no-pager; ss -ltnp | grep :443'
ssh lessv-server 'python3 - <<PY
import json
c=json.load(open("/var/lib/lessv/config.json"))
r=c["inbounds"][0]["streamSettings"]["realitySettings"]
print("privateKey_len", len(r.get("privateKey","")))
print("dest", r.get("dest"))
print("serverNames", r.get("serverNames"))
print("clients", len(c["inbounds"][0]["settings"].get("clients",[])))
PY'
ssh lessv-server 'journalctl -u lessv-agent -n 50 --no-pager; journalctl -u xray -n 30 --no-pager'
```

- 失败时看 `sync.last_error` / `health`（`error:test`、`error:started` 等）和 journal；不要直接改 `/var/lib/lessv/config.json`，让面板/agent 收敛。
- 常见失败：Xray drop-in 未生效、443 被占、`dest` 域名解析失败、Xray 以 nobody 读不了 config（G4 已排除）。

**闸门 G5**

- [ ] `applied == desired`，`health=ok`
- [ ] Xray active，监听 443
- [ ] live config 的 privateKey 非空、dest/serverNames 正确
- [ ] 无 apply/report 错误

---

### P1a.6 用户、订阅、双 VPS 探针、真实客户端交付

**任务**

1. 创建用户（UI 或 API）：

```bash
set -a; . .env.production; set +a
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"username":"alice","status":"active","expire":null,"access":{"tokyo01":{"allowed_inbounds":["reality"],"allowed_outbounds":["direct"]}}}' \
  https://<cp-host>/api/admin/users
```

2. 等 apply：`sync` 再次 `in_sync:true`；live config 的 `clients` 出现 `alice@direct`（UUID 不打印）。
3. mint 订阅 token：

```bash
curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  https://<cp-host>/api/admin/users/alice/sub-token \
  > ~/.lessv/acceptance/sub.json
chmod 600 ~/.lessv/acceptance/sub.json
```

从面板 `SubscriptionCard` 取 URL（含 QR）或从 `sub.json` 的 `sub_token` 拼 `https://<cp-host>/sub/<token>`。

4. 订阅内容检查（不要把解码后的 URI 打到终端/日志；它含 UUID/pbk）：

```bash
curl -sS https://<cp-host>/sub/<token> -o ~/.lessv/acceptance/sub.b64
base64 -d ~/.lessv/acceptance/sub.b64 > ~/.lessv/acceptance/sub.txt
chmod 600 ~/.lessv/acceptance/sub.b64 ~/.lessv/acceptance/sub.txt
```

用 smoke 脚本核对，不 `cat` 文件。必须是一条 `vless://`，参数至少包含：`security=reality`、`sni=www.microsoft.com`、`pbk`、`sid=<shortId>`、`spx=%2F`、`flow=xtls-rprx-vision`、`type=tcp`、`encryption=none`、地址=`<server 公网 IP>`、端口=443。

5. 运行 P1a smoke（新增脚本，只读）：

```bash
node scripts/p1a_smoke.mjs \
  --host https://<cp-host> \
  --admin-key-file .env.production \
  --node tokyo01 \
  --user alice \
  --expect-sni www.microsoft.com
```

脚本检查：health、401/200 认证、sync、用户 active、links、sub base64 与 links 一致、REALITY 参数齐全；不打印 key/token/URI。

6. 自动化客户端探针（在 `lessv-client` 上跑真实 Xray 客户端）：

本机从订阅 URI 生成客户端配置（脚本解析 `sub.txt`，只写文件，不打印 UUID/pbk）：

```bash
node scripts/subscription_to_xray.mjs \
  --sub ~/.lessv/acceptance/sub.txt \
  --out ~/.lessv/acceptance/client.json \
  --socks-port 1080
chmod 600 ~/.lessv/acceptance/client.json
```

传到 client VPS 并运行：

```bash
scp ~/.lessv/acceptance/client.json lessv-client:/tmp/lessv-client.json
ssh lessv-client 'pkill -f "xray run -c /tmp/lessv-client.json" 2>/dev/null || true; nohup xray run -c /tmp/lessv-client.json >/tmp/lessv-client.log 2>&1 & echo $! >/tmp/lessv-client.pid'
sleep 3
ssh lessv-client 'curl --socks5-hostname 127.0.0.1:1080 -sS https://api.ipify.org; echo'
ssh lessv-client 'curl --socks5-hostname 127.0.0.1:1080 -sS -o /dev/null -w "%{http_code}\n" https://www.cloudflare.com/cdn-cgi/trace'
```

期望：`api.ipify.org` 返回 **server 的公网 IP**（从 `~/.lessv/acceptance/linode.json` 的 `.server.ipv4` 读取），第二个请求 200。失败时看 `ssh lessv-client 'cat /tmp/lessv-client.log'` 和 server 的 `journalctl -u xray`。

清理 client 探针进程/配置：

```bash
ssh lessv-client 'kill $(cat /tmp/lessv-client.pid) 2>/dev/null || true; rm -f /tmp/lessv-client.json /tmp/lessv-client.pid /tmp/lessv-client.log'
```

7. 真实客户端交付（你操作）：

- 从面板 `SubscriptionCard` 取订阅 URL（含 QR），或从 `~/.lessv/acceptance/sub.json` 的 `sub_token` 拼 `https://<cp-host>/sub/<token>`；
- 导入 v2rayN / NekoBox / Shadowrocket / Hiddify，更新订阅，连接；
- 打开 `https://api.ipify.org`，确认出口 IP 是 server；
- 你确认后，P1a 的人工验收完成；server 继续保留，client 可删。

**闸门 G6**

- [ ] smoke 全部 PASS
- [ ] 自动化探针出口 IP = server 公网 IP
- [ ] 订阅 URL 已交付（面板/QR/`sub.json`）
- [ ] 订阅参数与面板 links 一致
- [ ] 真实客户端：你导入后确认（可后置，不阻塞工程交付）

---

### P1a.7 收敛与失败恢复验收

**任务**

先准备环境变量（后续命令都依赖）：

```bash
set -a; . .env.production; set +a
```

“重跑探针”= 重跑 P1a.6 步骤 6 的 `subscription_to_xray.mjs` + `scp` + `xray run` + `curl --socks5-hostname`；期望 `api.ipify.org` 返回 server 公网 IP。

1. agent 重启：

```bash
ssh lessv-server 'systemctl restart lessv-agent'
# 等 30–60s
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://<cp-host>/api/admin/nodes/tokyo01/sync
```

期望：`last_seen` 更新、`applied == desired`、`health=ok`；重跑探针仍返回 server IP。

2. Xray 重启：

```bash
ssh lessv-server 'systemctl restart xray && sleep 3 && systemctl is-active xray'
```

期望：Xray active；重跑探针仍返回 server IP；`sync` 无新错误（配置没变，不需要重新 apply）。

3. 面板重启：再跑一次部署（无代码变更）：

```bash
set -a; . ~/.lessv/cloudflare.env; set +a
npm run deploy -- --secrets-file .env.production
```

期望：health 200；D1 数据仍在（节点/用户/配置/订阅 token）；agent 在 60s 内恢复心跳；`in_sync:true`；重跑探针仍返回 server IP。

4. 禁用用户：

```bash
set -a; . .env.production; set +a
curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"status":"disabled"}' https://<cp-host>/api/admin/users/alice
```

等 apply：`sync in_sync`；live config 不再含 `alice@direct`；`/sub/<token>` 返回空 body；重跑探针应失败（连接/握手失败或超时）。然后恢复：

```bash
curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"status":"active"}' https://<cp-host>/api/admin/users/alice
```

等 apply；`/sub` 恢复非空；重跑探针恢复。

5. 过期用户：

```bash
# expire = now - 60；ADMIN_KEY 已在上一节 source
curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
  -d '{"expire":<past-epoch>}' https://<cp-host>/api/admin/users/alice
```

期望：`/sub/<token>` 空；**注意 V8**：Xray 配置仍含该用户，探针仍可能成功（expire 只影响订阅）。恢复 `expire:null`。

6. 清理 client，保留 server：

```bash
node scripts/linode_provision.mjs delete \
  --token-file ~/.lessv/linode.env \
  --label lessv-client
```

- 确认 `linode.json` 里 `lessv-client` 已删除；`lessv-server` 保留给你做真实客户端测试。
- 从 `~/.ssh/config` 删除 `lessv-client` 块（保留 `lessv-server`，或整个 `# lessv-p1a` 块留到 server 删除时）。
- `LINODE_TOKEN` 暂时保留（后面删除 server 要用）；server 删除后再 revoke。若 token 已到期，新建一个临时 `linodes:read_write` token 删除 server 即可（不需要 account/images scope）。

7. 交付：

- 订阅 URL / QR 给你；server 保持运行；你完成真实客户端测试后告诉我是否删除 server。
- 删除 server：

```bash
node scripts/linode_provision.mjs delete \
  --token-file ~/.lessv/linode.env \
  --label lessv-server
```

然后 revoke Linode token，删除 `~/.ssh/lessv_p1a_ed25519*`、`~/.ssh/config` 的 `# lessv-p1a` 块、`~/.lessv/acceptance/` 中临时文件。

**闸门 G7**

- [ ] agent 重启收敛；探针仍通
- [ ] Xray 重启后探针仍通
- [ ] 面板重启后数据/心跳/订阅仍在；探针仍通
- [ ] 禁用后订阅空 + 配置移除；探针失败；恢复后正常
- [ ] 过期后订阅空（不要求配置移除；探针可能仍通，V8）
- [ ] `lessv-client` 已删除；`lessv-server` 保留给你做真实客户端测试

---

### P1a.8 测试矩阵、文档、提交

**测试矩阵**

```bash
npm test
npm run types && npm run typecheck
npm run build
npm --prefix frontend test
npm --prefix frontend run build
python -m pytest -q agent/tests
npm run release:agent
tar -tzf dist/lessv-agent-0.1.0.tar.gz
npm run deploy -- --dry-run
```

期望：

| 层 | 期望 |
|---|---|
| Worker | 241 passed（+ P1a 新增则更多） |
| 类型/构建 | 绿 |
| 前端 | 27 passed / build 绿 |
| Agent | 33+ passed，**0 skipped**（E2E 已重写） |
| tarball | 内容正确、install.sh 可执行 |
| 源仓库 | `git -C ../Lesserv-Cloud status --porcelain` 等为空 |

**文档**

- `README.md` 增加“首节点”一节：Xray 安装 → agent tarball → 面板建节点/临时 REALITY JSON → 用户 → 订阅 → 验证；明确临时公网 `dest` 是 P1a 夹具，P1b 替换；注明 P1a 验收用两台临时 Linode（server/client），产品部署只需 server。
- 更新 `README.md` “当前状态”：P0 云端项完成；P1a 完成；P1b 待做。
- 更新 `PLAN.md` §14 P1a 勾选；§8 P1a 状态。
- `P1A-PLAN.md` 末尾“执行记录”填主机名/节点 IP/OS/客户端型号/日期（不填 secret）。

**提交**

| Commit | 内容 |
|---|---|
| 1 | `P1a: harden agent install and Xray integration` |
| 2 | `P1a: rewrite agent E2E against the LessV plane` |
| 3 | `P1a: deploy the panel to <cp-host>` |
| 4 | `P1a: complete first-node onboarding and subscription acceptance` |

提交前：

```bash
git status --short
git check-ignore .env.production .dev.vars wrangler.jsonc frontend/dist dist
```

---

## 4. 验收清单（对应 `PLAN.md` §14 P1a）

- [ ] Linode 两台 VPS（server + client）创建成功；server 装 Xray + agent
- [ ] agent enroll；fleet 显示健康
- [ ] 临时 REALITY 配置（公网 dest）保存；60s 内 applied = desired（PLAN 写 30s，实际留 60–90s）
- [ ] `lessv-client` 上的真实 Xray 客户端探针出口 IP = server 公网 IP
- [ ] 订阅 URL 已生成并交付；真实客户端由你导入确认（人工验收，可后置）
- [ ] agent/Xray/面板重启后收敛；探针仍通
- [ ] 用户禁用/过期后订阅为空；禁用后探针失败
- [ ] 面板自定义域 + `/api/health` 200（P0 云端剩余项）
- [ ] `lessv-client` 已删除；`lessv-server` 保留/按你确认删除
- [ ] `npm test` / typecheck / build / 前端 / pytest 全绿；E2E 0 skip
- [ ] 无 secret 进 git；源仓库干净

---

## 5. 风险与对策

| 风险 | 触发信号 | 对策 |
|---|---|---|
| Xray unit 用户/路径不匹配 | Xray active 但 443 无监听 / journal `permission denied` | 99-lessv.conf drop-in；`systemctl cat xray`；`User=root`；`ExecStart=/var/lib/lessv/config.json` |
| 443 被占 | `ss` 显示 nginx/apache | P1a 停冲突服务；P1b 再移 nginx 到 8443 |
| agent 装完起不来 | `python3 -m lessv_agent` import error | unit 加 `PYTHONPATH`；`systemctl status`/journal |
| token 提示读不到管道 | install 卡住/空 token | `ssh` 不加 `-t`；或 `ssh -t` 手工粘贴 |
| Cloudflare token 权限不足 | deploy 403 / DNS 错误 | 补 Zone `Workers Routes:Edit`、`DNS:Edit`；`wrangler whoami` |
| custom domain DNS 冲突 | deploy 报 record exists | 换子域/删冲突记录；不要删别人记录 |
| Linode token scope 不足 | 403 `Unauthorized` / create 400 | 重建 token：`linodes:read_write` + `account:read_only` + `images:read_only`；不要加 `*` |
| Linode region/plan 不可用 | create 400 `Not available` | 查 `/v4/regions/{id}/availability`；换 `jp-osa`/`sg-sin-2`/`de-fra-2`；不静默换 plan |
| Linode 账号限额/余额 | create 400/403 | 查 `/v4/account`；确认可开 2 台 Nanode；必要时先删旧实例 |
| Linode SSH key 登录失败 | `Permission denied (publickey)` | 确认 `authorized_keys` 是 `.pub` 内容；用 LISH 控制台 + inventory 的 root_pass；检查 `PermitRootLogin` |
| client 忘记删除 | 持续计费 | 用 tag `lessv-p1a`/label `lessv-client` 查并删除；探针后立即删 |
| client 连不上 server:443 | 探针 timeout | Linode 默认放行；检查 server `ss`/Xray active/`ufw`；不要先改 REALITY |
| Linode API 429 | 429 Too Many Requests | 指数退避；不要并发创建多台 |
| REALITY dest 不可达 | apply 成功但客户端超时 | `curl -I https://www.microsoft.com`；换 `www.cloudflare.com`/`www.apple.com` |
| 客户端不支持 Vision | 客户端握手失败 | 换 NekoBox/v2rayN；确认链接含 `flow`；必要时临时去掉 flow（记录偏差） |
| 订阅客户端缓存 | 更新订阅不生效 | `/sub` 已 `no-store`；客户端手动更新/重启 |
| 面板重启后 agent 不收敛 | fleet last_seen 不更新 | 检查 Worker health、agent journal、token；面板 D1 未丢 |
| `KEY_SECRET` 丢失 | REALITY 私钥解封失败 | 备份 `.env.production`；不可轮换 |
| 过期用户仍可连接 | 旧链接仍工作 | 已知 V8；P1a 只验订阅；要断连需 P1b/P2 改渲染 |
| E2E 在 Windows 杀不干净 | 端口占用/测试挂起 | `start_new_session`/`taskkill /T` + 按端口兜底；临时 `--persist-to` |
| 首次 deploy health 超时 | DNS/证书传播 | 等 30–60s 重试；不要盲目重部署 |

---

## 6. 时间估算

| 阶段 | 估算 |
|---|---|
| P1a.0 输入/预检 | 0.5 h |
| P1a.1 安装器/Xray 修复 + 测试 | 1.5 h |
| P1a.2 E2E 重写 | 2 h |
| P1a.3 面板部署 | 0.5 h |
| P1a.4 Linode 两台 + Xray + agent | 1.5 h |
| P1a.5 配置/首次 apply | 0.5 h |
| P1a.6 用户/订阅/双 VPS 探针 | 1 h |
| P1a.7 收敛验收 + client 清理 | 1 h |
| P1a.8 测试/文档/提交 | 0.75 h |
| **合计** | **~9.5 h**（PLAN 估 1–2 天） |

---

## 7. 明确不做（P1a）

- REALITY preset / 自偷 / `dest=127.0.0.1:8443`
- nginx 安装/配置/证书投递/reload
- ACME、LE staging/prod、R2、Workflows、cron
- `protocol: 2`、`X-Lesserv-Node` 改名、`/api/node/certs`
- 证书 lint、证书页、节点证书分配
- stats 存储、配额、审计、Clash/mihomo、B 拓扑
- 过期即断连（V8；P1a 只验订阅）

---

## 附录 A — 临时 REALITY 配置（P1a 夹具）

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "reality",
      "listen": "0.0.0.0",
      "port": 443,
      "protocol": "vless",
      "settings": {
        "clients": [],
        "decryption": "none",
        "flow": "xtls-rprx-vision"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "dest": "www.microsoft.com:443",
          "serverNames": ["www.microsoft.com"],
          "privateKey": "",
          "shortIds": ["<8-hex>"],
          "settings": { "fingerprint": "chrome", "spiderX": "/" }
        }
      }
    }
  ],
  "outbounds": [
    { "tag": "BLOCK", "protocol": "blackhole" },
    { "tag": "direct", "protocol": "freedom" }
  ],
  "routing": { "rules": [] }
}
```

- `<8-hex>` 用 `openssl rand -hex 4`。
- `privateKey` 留空；面板渲染时生成并注入，链接的 `pbk` 从存储的私钥派生。
- 不要把这时的“渲染后配置”再粘回 authored config（会把私钥写进明文配置）。
- P1b 用 preset 生成 `dest=127.0.0.1:8443` + 节点域名替换本文件。

---

## 附录 B — Xray systemd drop-in

路径：`/etc/systemd/system/xray.service.d/99-lessv.conf`

```ini
[Service]
User=root
Group=root
ExecStart=
ExecStart=/usr/local/bin/xray run -config /var/lib/lessv/config.json
```

- `ExecStart=` 空行是重置原 unit 的必需写法。
- 路径用 `command -v xray` 的实际值（通常是 `/usr/local/bin/xray`）。
- 为什么 `User=root`：agent 以 0600 root 写 config；官方 unit 的 `nobody` 读不了。REALITY 私钥不进 world-readable 文件。
- 若 `systemctl cat xray` 显示 `DynamicUser=yes`，drop-in 再加 `DynamicUser=no`。
- 安装后验证：`systemctl show xray -p User -p ExecStart`；`systemctl cat xray` 确认没有更晚的 drop-in 覆盖。

---

## 附录 C — 自动化客户端探针配置

```json
{
  "log": { "loglevel": "warning" },
  "inbounds": [
    {
      "tag": "socks",
      "listen": "127.0.0.1",
      "port": 1080,
      "protocol": "socks",
      "settings": { "udp": true }
    }
  ],
  "outbounds": [
    {
      "tag": "proxy",
      "protocol": "vless",
      "settings": {
        "vnext": [
          {
            "address": "<server 公网 IP>",
            "port": 443,
            "users": [
              {
                "id": "<UUID>",
                "encryption": "none",
                "flow": "xtls-rprx-vision"
              }
            ]
          }
        ]
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "serverName": "www.microsoft.com",
          "fingerprint": "chrome",
          "publicKey": "<pbk>",
          "shortId": "<sid>",
          "spiderX": "/"
        }
      }
    }
  ]
}
```

- `<UUID>`/`<pbk>`/`<sid>` 从订阅 URI 解码得到；用 `scripts/subscription_to_xray.mjs` 自动生成，不要手抄。
- 探针配置含凭据，放临时目录，验证后删除。
- 这个配置在 `lessv-client`（独立 Linode）上跑，不经过 hairpin NAT；`lessv-client` 的 Xray service 已停用，直接用 `xray run -c`。

---

## 附录 D — `scripts/p1a_smoke.mjs` 接口

```bash
node scripts/p1a_smoke.mjs \
  --host https://<cp-host> \
  --admin-key-file .env.production \
  --node tokyo01 \
  --user alice \
  --expect-sni www.microsoft.com
```

只读检查：

1. `GET /api/health` → 200
2. `GET /api/admin/nodes` 无 key/错 key → 401；对 key → 200
3. 节点存在；`GET /sync` → `desired_hash` 非空、`applied_hash == desired_hash`、`health == "ok"`、`last_error == null`
4. 用户存在、`status=active`、`sub_token` 非空
5. `GET /users/:u/links` → 至少一条 `vless://`
6. `GET /sub/:token` → base64 解码后与 links 的 URI 列表逐字节一致
7. URI 参数：`security=reality`、`sni`、`pbk`、`sid`、`spx`、`flow=xtls-rprx-vision`、`type=tcp`、`encryption=none`、host/port

输出只含 PASS/FAIL 和参数名；不打印 admin key、节点 token、订阅 token、完整 URI。

---

## 附录 E — 与 `PLAN.md` 的差异（执行时订正）

| PLAN 说法 | 实测/实现 | 处理 |
|---|---|---|
| P1a 30 秒内 applied=desired | heartbeat 30s + apply/restart，首次可能 60–90s | 验收用 60–90s；不改进协议 |
| P1a 只要求“测试全绿” | E2E 原为 4 skip | P1a 重写 E2E，要求 0 skip |
| `install.sh` 已可用 | 缺 PYTHONPATH、xray 检查、目录、drop-in | P1a 修安装器 |
| agent 写 `/var/lib/lessv/config.json` | 官方 Xray unit 读 `/usr/local/etc/xray/config.json` 且 `User=nobody` | P1a 加 drop-in；PLAN §7.4 的路径不变 |
| “过期后订阅为空” | 过期只影响订阅，不影响 Xray 配置 | P1a 按字面验收；断连留 P1b/P2 |

---

## 附录 F — Linode API 与两台 VPS

**Token scopes（最小集）**

| Scope | 用途 |
|---|---|
| `linodes:read_write` | create/list/get/delete/reboot |
| `account:read_only` | 创建实例时读账号/可用性 |
| `images:read_only` | 选 `linode/debian12` |

其他全部 No Access。不要 `account:read_write`、`firewall:*`、`*`。

**create 请求字段（脚本内部）**

```json
{
  "region": "jp-tyo-3",
  "type": "g6-nanode-1",
  "image": "linode/debian12",
  "label": "lessv-server",
  "root_pass": "<random>",
  "authorized_keys": ["ssh-ed25519 AAAA... lessv-p1a"],
  "tags": ["lessv-p1a", "lessv-server"]
}
```

- client 用 `region=sg-sin-2`、`label=lessv-client`。
- 不传 `metadata.user_data`；不建 Cloud Firewall。
- `root_pass` 只用于 LISH 兜底；SSH 用 `authorized_keys`。
- 创建后轮询 `GET /v4/linode/instances/{id}`，等 `status=running` 和公网 IPv4。

**inventory 形状**

```json
{
  "server": { "id": 123, "label": "lessv-server", "region": "jp-tyo-3", "type": "g6-nanode-1", "ipv4": "203.0.113.10", "root_pass": "..." },
  "client": { "id": 124, "label": "lessv-client", "region": "sg-sin-2", "type": "g6-nanode-1", "ipv4": "203.0.113.11", "root_pass": "..." }
}
```

**`scripts/linode_provision.mjs` 接口**

```bash
node scripts/linode_provision.mjs create \
  --token-file ~/.lessv/linode.env \
  --ssh-key ~/.ssh/lessv_p1a_ed25519.pub \
  --server-region jp-tyo-3 \
  --client-region sg-sin-2 \
  --type g6-nanode-1 \
  --image linode/debian12 \
  --out ~/.lessv/acceptance/linode.json

node scripts/linode_provision.mjs list --token-file ~/.lessv/linode.env
node scripts/linode_provision.mjs delete --token-file ~/.lessv/linode.env --label lessv-client
```

**`scripts/subscription_to_xray.mjs` 接口**

```bash
node scripts/subscription_to_xray.mjs \
  --sub ~/.lessv/acceptance/sub.txt \
  --out ~/.lessv/acceptance/client.json \
  --socks-port 1080
```

- 解析 `vless://` 的 `security=reality`、`sni`、`pbk`、`sid`、`spx`、`flow`、`type`、host/port；
- 生成附录 C 的 Xray 客户端 JSON；
- 只写文件，不打印 UUID/pbk；文件 0600。

**清理**

- client 探针后删除；server 保留给你真实客户端测试。
- 删除 server 后 revoke `LINODE_TOKEN`，删 `~/.ssh/lessv_p1a_ed25519*`、`~/.ssh/config` 的 `# lessv-p1a` 块、`~/.lessv/acceptance/` 临时文件。
- 用 tag `lessv-p1a` 查漏：`list` 或 Linode Cloud Manager 过滤 tag。
| `X-Lesserv-Node` 改名 | P1a 不动 | 与 PLAN §13.8 一致，P1b 随 protocol 2 |

---

## 执行记录（执行时填写，不写 secret）

| 项 | 值 |
|---|---|
| 日期 | 2026-10-25 |
| Cloudflare zone | `example.com`（active） |
| 面板主机名 | `cp.example.com`（custom domain，证书已签发） |
| Worker 名 / D1 | `lessv` / `lessv`（id 00000000-0000-4000-8000-000000000002） |
| Linode server/client IP / OS / 架构 | 见 P1a.4.0 |
| Linode 区域 / type | `jp-tyo-3` + `sg-sin-2` / `g6-nanode-1` |
| 节点 id / 标签 | `tokyo01` / `Tokyo` |
| Xray 版本 | 见 P1a.4.1 |
| agent 版本 | 0.1.0（tarball sha256 7972c972…） |
| 真实客户端 | 待定（可后置） |
| 验收结果 | 进行中：G0–G3 绿；部署 2026-10-25，health 200，auth 401/401/200，secrets 只有 ADMIN_KEY/KEY_SECRET，remote migrations 无待应用，/admin/ 200 |
