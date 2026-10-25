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

## 当前状态

- **P0 完成（本机）**：改名、`KEY_SECRET` 统一、`/api/admin/*` 的 `ADMIN_KEY` 认证、SPA 登录、部署脚本、测试矩阵全绿（Worker 241 passed，前端 27 passed，agent 33 passed / 4 skipped）。
- **待办**：云部署（可与 P1a 合并）；P1a 节点 onboarding；P1b REALITY preset + ACME。
