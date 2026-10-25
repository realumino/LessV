# LessV

一个跑在 Cloudflare Workers 上的 Xray 面板：REALITY、nginx 自偷、Let's Encrypt 自动签发、订阅。节点端是 Python agent（systemd 常驻，与面板心跳同步）。

由 Lesserv-Cloud、Lesserv-Agent、ssl-cert-worker 三个仓库合并而来；合并的边界和理由见 `PLAN.md`。

## 拓扑

只做拓扑 A：Xray REALITY 监听 443，`dest=127.0.0.1:8443`，证书只属于 nginx 假站点。

```
浏览器 ── /admin ──────────► Worker (Hono SPA)
                               │  /api/admin/*  ← ADMIN_KEY (Bearer)
                               │  /api/node/*   ← 节点 token
                               │  /sub/{token}  ← 订阅
                               ▼
                              D1 (migrations/)
用户 ── /sub/{token} ──► 订阅 ◄── 用户/节点/REALITY/证书
节点 ── Xray(REALITY 443) ──► agent (Python, systemd)
         ▲ nginx 假站点 (8443) │
         └── 证书 ◄── ACME (P1b, DNS-01) ◄── Worker
```

## 仓库结构

```
src/            Worker（Hono 路由 + 服务层）
frontend/       管理面板 SPA（React + Vite，挂 /admin）
migrations/     D1 schema（0001–0004 是 P0 全量）
agent/          lessv_agent（Python）+ systemd + install.sh + pytest
tests/          workerd 集成测试 + pure 单元测试
scripts/        wrangler 配置引导 + deploy.mjs
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
| Agent | `python -m pytest -q agent/tests` |
| 部署脚本 | `npm run deploy -- --dry-run`（无云） |

测试不读 `.dev.vars`、不依赖任何本地 secret：secret 绑定在 `vitest.config.ts` 里声明（固定测试值）。

## 部署

前提：一个 Cloudflare 账号、一个已托管在该账号的域名。

1. `cp wrangler.example.jsonc wrangler.jsonc`，把 route 改成自己的主机名（占位符会被 deploy 脚本拒绝）。
2. 生成两个 secret：
   ```bash
   node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))"
   node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"
   ```
   写入 `.env.production`（gitignored；模板 `.env.production.example`）。`KEY_SECRET` 加密落库的 REALITY 私钥，**不可轮换**——换掉它，历史节点密钥全部不可读。
3. `npm run deploy -- --secrets-file .env.production`
4. 脚本依次执行：SPA 构建 → `wrangler deploy`（首次自动建 D1 并写回 id）→ `d1 migrations apply DB --remote` → `https://<host>/api/health` 必须回答 200。

回滚：`npx wrangler rollback`。

## 首节点（从零到一条能上网的订阅）

前提：VPS（Debian 12+，root SSH，443 空闲，可出站 443）已装好 Xray
（`bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install`）；面板已部署（上节）。

1. **发布 agent**：`npm run release:agent` → `dist/lessv-agent-<ver>.tar.gz` +
   `.sha256`。要求 `agent/` 无未提交改动（tarball 从 `HEAD:agent` 打包）。
2. **建节点 + mint token**（面板或 API）：
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d '{"id":"tokyo01","label":"Tokyo","address":"<server公网IP>"}' \
     https://<cp-host>/api/admin/nodes
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" \
     https://<cp-host>/api/admin/nodes/tokyo01/token   # 只显示一次
   ```
3. **传 tarball 并安装**（token 走 stdin，不要作为参数）：
   ```bash
   scp dist/lessv-agent-<ver>.tar.gz root@<server-ip>:/tmp/
   ssh root@<server-ip> 'mkdir -p /tmp/lessv-agent && tar -xzf /tmp/lessv-agent-<ver>.tar.gz -C /tmp/lessv-agent --strip-components=1'
   ssh -t root@<server-ip> 'cd /tmp/lessv-agent && ./install.sh --cp https://<cp-host> --node tokyo01'
   ```
   install.sh 会：检查 python3/systemd/Xray 与 xray.service；建
   `/etc/lessv`、`/etc/lessv/certs`、`/var/lib/lessv`、`/var/www/lessv-decoy`；
   装包到 `/usr/local/lib/lessv-agent`；写 systemd drop-in
   `/etc/systemd/system/xray.service.d/99-lessv.conf`（`User=root` +
   `ExecStart=... run -config /var/lib/lessv/config.json`，因为 agent 以
   0600 root 写配置，官方 unit 的非 root 用户读不了）；enroll；enable。
4. **保存一份 REALITY 配置**（P1a 夹具用公网 dest；P1b 换自偷 + LE）：
   在面板节点页粘贴（`privateKey` 留空，面板渲染时生成并注入；`shortIds`
   自填 8 位 hex）：
   ```json
   {"log":{"loglevel":"warning"},"inbounds":[{"tag":"reality","listen":"0.0.0.0","port":443,"protocol":"vless","settings":{"clients":[],"decryption":"none","flow":"xtls-rprx-vision"},"streamSettings":{"network":"tcp","security":"reality","realitySettings":{"dest":"www.microsoft.com:443","serverNames":["www.microsoft.com"],"privateKey":"","shortIds":["<8-hex>"],"settings":{"fingerprint":"chrome","spiderX":"/"}}}}],"outbounds":[{"tag":"BLOCK","protocol":"blackhole"},{"tag":"direct","protocol":"freedom"}],"routing":{"rules":[]}}
   ```
5. **建用户**：用户页新建（如 `alice`），给节点 `tokyo01` 勾选 inbound
   `reality`、outbound `direct`。等 fleet 的 applied = desired（心跳 30s
   + apply，首次 60–90s）。
6. **发订阅**：用户页 mint 订阅 token，取 `https://<cp-host>/sub/<token>`
   （或扫码）导入 v2rayN / NekoBox / Shadowrocket / Hiddify，更新订阅后连接；
   打开 `https://api.ipify.org` 确认出口 IP 是节点地址。

排障：`journalctl -u lessv-agent -n 50`、`journalctl -u xray -n 30`、
`xray run -test -c /var/lib/lessv/config.json`、面板 fleet 的
`health`/`last_error`。不要手工改 `/var/lib/lessv/config.json`；让面板/agent
收敛。注意：`expire` 只影响订阅资格（过期用户订阅为空，但配置仍保留）；
`status=disabled` 才会从 Xray 配置移除。另外 `PUT /api/admin/users` 无法把
`expire` 改回 `null`（null 表示“不变”），需要时用一个远期 epoch 替代。

## 当前状态

- **P0 完成**：改名、`KEY_SECRET` 统一、`/api/admin/*` 的 `ADMIN_KEY` 认证、SPA 登录、部署脚本。
- **P1a 完成（2026-10-25）**：面板部署在 `cp.example.com`（自定义域 + 证书，health 200，auth 401/401/200，secrets 只有 ADMIN_KEY/KEY_SECRET，remote migrations 应用）；真实 VPS（Linode `lessv-server`，Debian 12）装 Xray 26.10.21 + agent 0.1.0，enroll 健康心跳；临时 REALITY 配置（公网 dest `www.microsoft.com:443`）应用收敛（applied = desired，health ok，Xray 监听 443）；用户/订阅打通；第二台 VPS 的真实 Xray 客户端探针出口 IP = 节点公网 IP；agent/Xray/面板重启、禁用/过期恢复全部收敛验收；agent 安装器加固（PYTHONPATH、Xray 检查、目录布局、systemd drop-in）；agent E2E 重写为本仓库 workerd plane，0 E2E skip。
- **测试矩阵**：Worker 242 passed / 32 files；前端 27 passed；agent 54 passed / 1 skipped（仅一个 POSIX 文件模式测试在 Windows skip，Linux 上运行）。
- **待办**：P1b REALITY preset（自偷 + LE 证书，替换临时公网 dest）；P1c 收尾。
