# LessV — P0 执行计划

> 依据 `PLAN.md` §8 P0。本文件是执行工件（不是产品文档），P1c 结束时删除。
> 状态：**可执行**（§2 的三项已确认；部署主机名是 deploy 时传入的参数，不是计划决策）。
> 基线：三个源仓库 `git status` 干净；标注"已验证"的条目均为本机实测。

---

## 0. 验收原则：本机优先

P0 的代码工作**全部在本机验收**：`wrangler dev` 跑的是真 workerd + 本地 D1 + 真 assets，覆盖 P0 的每一条功能验收（认证矩阵、D1 schema、SPA 登录、节点 CRUD、订阅端点不受影响、路由守卫）。

云端只多覆盖四件事：自定义域 + TLS、远端 D1、真实 secret 注入、部署后可达性。因此云部署是 P0 的**最后一步**，可与 P1a 合并执行，不阻塞 P1a 开工。

---

## 1. 与 PLAN.md 的差异（实测，必须先知道）

| # | PLAN 的说法 | 实测事实 | 影响 |
|---|---|---|---|
| 1 | §2.4「复制后跑 `npm test`，基线应为绿」 | 不复制 `.dev.vars` 时 **12 个测试 500 失败**：`REALITY_KEY_SECRET is not configured`。`.dev.vars` 是 gitignore 的文件，`git archive` 不会带 | 必须给 vitest 加测试专用 binding，否则"基线绿"依赖一个未提交文件 |
| 2 | §2.2 不复制 `worker-configuration.d.ts`，"重新生成" | 不生成时 `npm run typecheck` 直接失败：`Cannot find name 'D1Database'`（8 处） | 复制后第一步是 `npm run types`，并让该文件入库 |
| 3 | `npm test` | `vitest.config.ts` 读 `./wrangler.jsonc`，该文件由 `pretest` 钩子从 example 生成。直接 `npx vitest run` 会 ParseError | 一律用 `npm test`，不绕过 npm 脚本 |
| 4 | §8 P0.3「删除 Access 相关内容」 | Access 在代码里**零实现**（纯边缘基础设施），只有 6 处注释 + 1 条前端文案 + 文档 | 该任务只是文档/注释/文案清理，不是代码改造 |
| 5 | §3 命名表 | 节点身份头是 `X-Lesserv-Node`，不在表中；agent 测试用 `get_header("X-lesserv-node")` 断言，大小写不敏感的全仓库 sed 会把它改红（已复现） | 该头单独决策（§2） |
| 6 | §6.1 管理员 API 列表 | 实际是 `GET /nodes/:id/reality`、`POST /nodes/:id/reality/rotate`、`GET /nodes/:id/config/runtime`；没有 `/reality-keys`、`/runtime` | P0.6 顺手订正 PLAN，避免 P1b 照错文档实现 |
| 7 | 协议/仓库跨 repo | 两侧 `PROTOCOL_VERSION=1`，`tests/pure/protocol_freeze.test.ts` 钉死 1 | P0 不动协议版本 |
| 8 | Agent E2E | `tests/test_e2e_pull.py` 已过期（找 `src/worker.py`、`uv run pywrangler`、`--var REALITY_KEY_SECRET`、D1 名 `lesserv`），在 LessV 里哨兵缺失 → 4 个 E2E 永远 skip | P0 只要求 pytest 绿；重写是 P1a |
| 9 | 本地 dev 的 secret 绑定 | **`.dev.vars` 里的名字必须在 `wrangler.jsonc` 的 `secrets.required` 中声明才会被绑定**（已验证：只声明 `REALITY_KEY_SECRET` 时，`.dev.vars` 里正确的 `ADMIN_KEY` 仍得到 401；把两个名字都声明后立刻 200） | P0.3 必须同时改 `secrets.required`，否则 P0.7 的手工验收会假失败 |

**已实测的基线数字：**

| 命令 | 结果 | 耗时 |
|---|---|---|
| `npm install` | ok | ~40s |
| `npm run types` → `npm run typecheck` | 绿（顺序不能反） | ~15s |
| `npm test` | **236 passed / 31 files** | ~11s |
| `npm run build`（dry-run） | 绿，973 KiB | ~8s |
| `npm --prefix frontend test` | **23 passed / 4 files** | <1s |
| `npm --prefix frontend run build` | 绿，318 KiB JS | <1s |
| `python -m pytest`（agent） | **33 passed, 4 skipped** | ~2s |

**已用原型验证的新代码：** 加入 `ADMIN_KEY` 中间件 + 测试注入后 `npm test` = **241 passed**；本地 `wrangler dev` 上 §3 P0.7 的 13 条 smoke 全部按预期返回（见该节的实测值表）。

---

## 2. 已确认的决策

| # | 决策 |
|---|---|
| D1 | 新项目，不复用旧 `lesserv-cloud` D1；新建 `lessv` |
| D2 | `X-Lesserv-Node` 头 P0 不改，与 `protocol: 2` 在 P1b 一起改（P0 不做线协议变更） |
| D3 | P0 用 **6 个 `P0:` 前缀的原子 commit**（P0 是多步骤改造；单 commit 不可回顾） |
| D4 | 测试 secret 写入 `vitest.config.ts` 的 miniflare `bindings`（测试专用固定值）；`.dev.vars` 只服务 `npm run dev` |

**部署参数（不是决策，deploy 时才需要）：**

| 参数 | 来源 | 规则 |
|---|---|---|
| 主机名 | 操作者的 `wrangler.jsonc`（gitignored） | 仓库里只有 `wrangler.example.jsonc` 的占位符；deploy 脚本检测到占位符即报错退出 |
| D1 `database_id` | `wrangler deploy` 首次部署自动写回 | 不手工填，不复制旧 id |
| `ADMIN_KEY` / `KEY_SECRET` | `.env.production`（gitignored） | 由操作者生成；脚本通过 `--secrets-file` 传入，不落库不入 git |

---

## 3. 执行阶段

### P0.1 骨架 + 只读复制（不改任何逻辑）

**用 `git archive` 而不是 `cp -r`：** 源仓库工作区干净，`git archive HEAD` 只输出已跟踪文件，天然排除 `node_modules`、`frontend/dist`、`.wrangler`、`wrangler.jsonc`、`.dev.vars`、`.env.production`。

```bash
cd C:/Users/dev/Documents/GitHub/LessV          # 已有 .git（无 commit）与 PLAN.md

git -C ../Lesserv-Cloud archive --format=tar HEAD \
  src tests migrations scripts frontend package.json package-lock.json \
  tsconfig.json vitest.config.ts wrangler.example.jsonc .gitignore .dev.vars.example \
  | tar -x -C .

mkdir -p agent
git -C ../Lesserv-Agent archive --format=tar HEAD \
  lesserv_agent tests install.sh systemd .gitignore \
  | tar -x -C agent
```

**不复制（显式）：** `Lesserv-Cloud/{AGENTS.md,ARCHITECTURE.md,PLAN.md,WORKBOOK.md,README.md,docs/,worker-configuration.d.ts,wrangler.jsonc,.dev.vars,.env.production}`；`Lesserv-Agent/{AGENTS.md,ARCHITECTURE.md,PLAN.md,README.md}`；`ssl-cert-worker/*`（P1b 才用）。

避免 `git archive frontend` 的隐患：它只包含已跟踪文件，故无 `node_modules/dist`。

**闸门 G1（基线必须绿）：**

```bash
npm install
npm run types                     # 生成 worker-configuration.d.ts（入库）
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))" > .dev.vars
npm run typecheck                 # 绿
npm test                          # 236 passed
npm run build                     # dry-run 绿
npm --prefix frontend install && npm --prefix frontend test && npm --prefix frontend run build
python -m pytest -q agent/tests   # 33 passed, 4 skipped
git -C ../Lesserv-Cloud status --porcelain; git -C ../Lesserv-Agent status --porcelain   # 空
```

失败处理：**只改 LessV 的副本**，不放宽断言；数字与上表不符就停下定位，不进入 P0.2。

**Commit 1：** `P0: copy Lesserv-Cloud and Lesserv-Agent into LessV`

---

### P0.2 改名 `lesserv` → `lessv`

**规则（避免反复改名）：**

| 类别 | 处理 |
|---|---|
| 包名、Worker 名、D1 名、systemd unit、目录/文件、`/etc/lessv` `/var/lib/lessv`、环境变量前缀 `LESSV_`、secret 名、UI 文案、`User-Agent` | **改** |
| `X-Lesserv-Node`、`PROTOCOL_VERSION=1`、迁移 SQL 内容、测试 fixture 字符串 | **不改** |
| 注释里的源仓库出处（"ported from Lesserv-Cloud"、"the Python plane"） | **不改**（P1c 收尾再清） |

**Worker / 前端（6 处）：**

| 文件 | 改动 |
|---|---|
| `package.json` | `"name": "lesserv-cloud"` → `"lessv"` |
| `frontend/package.json` | `"name": "lesserv-frontend"` → `"lessv-frontend"` |
| `frontend/index.html` | `<title>Lesserv admin</title>` → `<title>LessV admin</title>` |
| `frontend/src/App.tsx` | header 品牌文本 `Lesserv` → `LessV` |
| `wrangler.example.jsonc` | 见 P0.6（一次性重写，这里只改名） |
| `src/env.ts` | 见 P0.3（secret 改名） |

改完跑 `npm install`，让两个 `package-lock.json` 的 `name` 字段与实际一致。

**Agent（已实测通过的精确序列）：**

```bash
mv agent/lesserv_agent agent/lessv_agent
mv agent/systemd/lesserv-agent.service agent/systemd/lessv-agent.service
grep -rIl "lesserv\|Lesserv\|LESSERV" agent | xargs sed -i \
  -e 's/lesserv_agent/lessv_agent/g' \
  -e 's/lesserv-agent/lessv-agent/g' \
  -e 's/LESSERV/LESSV/g' \
  -e 's#/etc/lesserv#/etc/lessv#g' \
  -e 's#/var/lib/lesserv#/var/lib/lessv#g' \
  -e 's/lesserv/lessv/g' \
  -e 's/Lesserv/LessV/g'
sed -i 's#LessV-Agent#LessV#' agent/systemd/lessv-agent.service
python -m pytest -q agent/tests          # 期望 33 passed, 4 skipped
grep -rIn "lesserv\|Lesserv\|LESSERV" agent    # 期望：无输出
```

顺序不可换：先长模式后短模式；`X-Lesserv-Node` 因大小写不被命中（这是特性，不是巧合）。

**闸门 G2：**

```bash
npm test && npm run typecheck && npm --prefix frontend test && npm --prefix frontend run build
rg -n -i "lesserv" --glob '!*.md' --glob '!package-lock.json' .
```

白名单：`src/routers/node.ts` 与 3 个测试文件中的 `X-Lesserv-Node`；注释中的源仓库名。

**Commit 2：** `P0: rename to lessv / lessv_agent`

---

### P0.3 统一 `KEY_SECRET` + 测试/本地 dev 的秘密绑定

**改动：**

1. `src/env.ts`：常量 `REALITY_KEY_SECRET` → `KEY_SECRET`，错误文案同步。
2. `tests/pure/crypto.test.ts`：env 字面量键名 + 断言正则（两处）。
3. `wrangler.example.jsonc`：`secrets.required: ["ADMIN_KEY", "KEY_SECRET"]`。**这一步同时是本地 dev 生效的前提**（§1 第 9 条），不只是部署校验。
4. `vitest.config.ts`：miniflare `bindings` 增加测试常量（已验证：不读 `.dev.vars` 也 236 全绿）：
   ```ts
   bindings: {
     TEST_MIGRATIONS: migrations,
     KEY_SECRET: "<32-byte-base64 测试常量>",
     ADMIN_KEY: "test-admin-key",
   },
   ```
5. `.dev.vars.example` 重写为两项（`ADMIN_KEY`、`KEY_SECRET`），保留"生产值必须不同 / `KEY_SECRET` 不可轮换"的说明。
6. 新增 `.env.production.example`（`ADMIN_KEY=`、`KEY_SECRET=`；`CF_DNS_API_TOKEN` 注释掉，P1b 启用）。
7. `.gitignore` 已覆盖 `.dev.vars*` 与 `.env*`，不改。

**闸门 G3（hermetic 证明）：**

```bash
mv .dev.vars .dev.vars.bak
npm test            # 必须 236 passed（不再依赖本地 secret 文件）
mv .dev.vars.bak .dev.vars
```

**Commit 3：** `P0: unify KEY_SECRET and make the test suite hermetic`

---

### P0.4 管理员 API Key（后端）

**新增 `src/auth/admin_key.ts`（以下代码已跑通 241 个测试）：**

```ts
import type { MiddlewareHandler } from "hono";
import { ApiError } from "../models";

export const adminKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const presented = bearer(c.req.header("Authorization") ?? "");
  if (!presented || !(await sameKey(c.env.ADMIN_KEY, presented))) {
    throw new ApiError(401, "admin key required");
  }
  await next();
};

/** 大小写不敏感的 `Bearer ` 方案；空 token 视为未提供。 */
function bearer(header: string): string | null { /* split on first space, compare scheme */ }

/** 先取定长摘要再做 XOR 累加，时间与内容和长度都无关。 */
export async function sameKey(a: string, b: string): Promise<boolean> { /* SHA-256 + 逐字节 diff */ }
```

**挂载（`src/main.ts`）：** 在 fail-closed 守卫之后、`app.route(...)` 之前：

```ts
app.use("/api/admin/*", adminKey);
```

行为约定（写进测试）：
- 未认证访问**任意** `/api/admin/*`（含不存在的路径）→ `401 {"detail":"admin key required"}`；带正确 key 的未知路径仍是 404。这是有意的"认证先于路由"。
- `/api/health`、`/sub/*`、`/api/node/*` 完全不受影响。
- `ADMIN_KEY` 未配置 → 401（fail closed），不 500，不打印 key。

**测试改动：**

| 文件 | 改动 |
|---|---|
| `tests/helpers.ts` | 导出 `TEST_ADMIN_KEY`；`planeFetch` 对 `/api/admin/` 且**未显式带 Authorization** 的请求注入 `Bearer ${TEST_ADMIN_KEY}`（合并 headers，不覆盖） |
| `tests/workerd/admin_auth.test.ts` **新增** | 5 例：无 key 401；错 key 401；对 key 200；health/sub 不受影响；node 路由仍返回 `invalid node credentials` |
| 既有测试 | **不改**（注入在 helper 一层，`error_envelope` 的裸 `planeFetch` 也被覆盖） |

**注释清理（Access 已不存在，5 处，必须同步改）：**
`src/route_groups.ts:9`、`src/routers/admin_nodes.ts:7`、`src/routers/node.ts:5`、`src/routers/sub.ts:5`、`frontend/src/pages/NodeConfigPage.tsx:8`。

**闸门 G4：** `npm test` = **241 passed**；`npm run typecheck` 绿。

**Commit 4：** `P0: admin key auth for /api/admin`

---

### P0.5 SPA 登录 + API header + 401 处理

**新增 `frontend/src/lib/auth.ts`（纯逻辑，可单测）：**

```ts
const STORAGE_KEY = "lessv.admin-key";
export function getAdminKey(): string | null;      // localStorage, try/catch
export function setAdminKey(key: string): void;    // 写入 + 派发 auth-change 事件
export function clearAdminKey(): void;             // 删除 + 派发
export function onAuthChange(fn: () => void): () => void;  // 返回退订
```

**`frontend/src/api.ts`：**
- 读 `getAdminKey()`，在 `request()` 一处附加 `Authorization: Bearer …`。
- `401` → `clearAdminKey()` + `{status: 401, error: "Admin key rejected — sign in again."}`，App 切回登录页。
- 删除 `SESSION_EXPIRED`（Access 遗留）；非 JSON 的 2xx 保留中性文案。
- 新增 `checkAdminKey(key: string)`：用传入的 key 直接 fetch（不读写 storage），供登录页验证，避免"验证失败即清空输入"。

**新增 `frontend/src/pages/LoginPage.tsx`：** 单个密码输入 + 提交；调 `checkAdminKey`；成功 → `setAdminKey` → `onLogin`；失败 → 行内错误，保留输入。

**`frontend/src/App.tsx`：** 顶层门禁，不改路由表（保持深链可刷新）：

```tsx
const [key, setKey] = useState(getAdminKey());
useEffect(() => onAuthChange(() => setKey(getAdminKey())), []);
if (!key) return <LoginPage onLogin={() => setKey(getAdminKey())} />;
```

Header 加 `Logout`（`clearAdminKey()`）。

**测试：** 新增 `frontend/src/lib/auth.test.ts`（get/set/clear/事件 3–4 例）；既有 23 例不动。

**闸门 G5：** `npm --prefix frontend test` = 26+ passed；`npm --prefix frontend run build` 绿。手工验收在 P0.7。

**Commit 5：** `P0: SPA login and admin key client`

---

### P0.6 wrangler 配置、部署脚本、文档骨架

**`wrangler.example.jsonc` 重写（P0 范围：**不加** R2 / Workflows / cron）：**

```jsonc
{
  "name": "lessv",
  "main": "src/worker.ts",
  "compatibility_date": "<沿用源仓库日期>",
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
  "d1_databases": [{ "binding": "DB", "database_name": "lessv", "migrations_dir": "migrations" }],
  "secrets": { "required": ["ADMIN_KEY", "KEY_SECRET"] },
  "assets": { "directory": "./frontend/dist", "not_found_handling": "single-page-application" },
  "observability": { "enabled": true }
}
```

删掉源内容：所有 "WORKBOOK.md"、"Cloudflare Access"、`REALITY_KEY_SECRET` 的注释段落。

**`scripts/deploy.mjs`（新，Node，跨平台；`package.json` 的 `deploy` 改为调用它，移除 `predeploy` 钩子）：**

1. 校验 `wrangler.jsonc` 存在且 route 不是 `cp.example.com`（占位符 → 报错并提示 `cp wrangler.example.jsonc wrangler.jsonc`）；
2. `npm --prefix frontend run build`（真构建，不是 stub）；
3. `npx wrangler deploy`（`--secrets-file` 透传；`--dry-run` 时只做构建 + dry-run，供本机验证脚本本身）；
4. `npx wrangler d1 migrations apply DB --remote`（stdio inherit，允许交互确认）；
5. 从 `wrangler.jsonc` 正则取 `pattern`，`fetch https://<pattern>/api/health`，非 200 以非零退出。
- 打印每步命令与耗时；失败即退出，不吞错误。

**文档：**
- 删除复制进来的 `AGENTS.md / ARCHITECTURE.md / WORKBOOK.md / docs/ / README.md`。
- 新建 `README.md`（骨架，P1c 再充实）：定位、A 拓扑图、仓库结构、本地开发（4 条命令）、测试矩阵、部署（6 步 + 两个 secret 的生成命令）、当前状态；不写教程。
- `PLAN.md` 订正（§15.9 要求文档先于代码）：§6.1 三个端点名改为实际值；§13 增加"节点身份头保留至 P1b"；§8 P0 勾选完成项。

**闸门 G6：** `npm run typecheck`、`npm run build`、`npm run types` 绿；`npm run deploy -- --dry-run` 退出码 0（不需要云）；README 里除 deploy 外的命令都能直接跑。

**Commit 6：** `P0: wrangler config, deploy script, docs skeleton`

---

### P0.7 本地验收（P0 的完成标准）

**准备：**

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))" >  .dev.vars
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"  >> .dev.vars

npm --prefix frontend run build            # 真 SPA 产物，不是 stub
npx wrangler d1 migrations apply DB --local   # 0001–0004 应全部 ✅
npm run dev                                # workerd on 127.0.0.1:8787，读 .dev.vars
```

**curl 矩阵（实测值，逐条重跑并核对）：**

| # | 请求 | 期望 |
|---|---|---|
| 1 | `GET /api/health` | 200 `{"status":"ok"}` |
| 2 | `GET /api/admin/nodes`（无 key） | 401 `{"detail":"admin key required"}` |
| 3 | 同上 + `Bearer wrong` | 401 |
| 4 | 同上 + `Bearer $ADMIN_KEY` | 200 `[]`（或已有节点数组） |
| 5 | `POST /api/admin/nodes`（合法 body，带 key） | 201，返回节点 |
| 6 | `POST /api/admin/nodes/<id>/token` | 201，token 只出现一次 |
| 7 | `GET /api/admin/nodes/<id>/sync` | 200，`desired_hash` 有值（无 config 时按现状） |
| 8 | `GET /api/admin/nope`（带 key） | 404 |
| 9 | `GET /api/admin/nope`（无 key） | 401 |
| 10 | `GET /sub/nope` | 200，空 body，`text/plain` |
| 11 | `POST /api/node/heartbeat`（无 token） | 401 `invalid node credentials`（证明 node 面没被 admin 中间件污染） |
| 12 | `GET /admin/` | 200 `text/html` |
| 13 | `GET /admin/nodes/x/config` + `Sec-Fetch-Mode: navigate` | 200 `text/html`（深链可刷新） |
| 14 | `GET /` | 200（SPA index） |

**浏览器（同一 `npm run dev`）：**
1. `/admin/` → 登录页；
2. 粘贴 `.dev.vars` 的 `ADMIN_KEY` → 进入 fleet；
3. 刷新 → 仍在 fleet；
4. localStorage 改成错值 → 任意操作触发 401 → 自动回登录页；
5. Logout → 清除，刷新仍是登录页；
6. DevTools 确认每个 `/api/admin/*` 请求带 `Authorization`，且响应无 `Set-Cookie`。

**回归（证明没破坏既有面）：**
- 同一实例上跑一遍 users CRUD、REALITY rotate、link profiles、订阅 token 手工流程；
- 重启 `wrangler dev`（本地 D1 持久化在 `.wrangler/state`）→ 数据仍在，登录态仍有效。

**清理：** 停 dev server；`git status` 里不应出现 `.dev.vars`、`wrangler.jsonc`、`frontend/dist`。

**P0 到此功能完成。** 结果记入 Commit 7 的说明或 README 的"状态"段。

---

### P0.8 云部署（可与 P1a 合并，不算 P1a 的前置）

只在需要验证"自定义域 + TLS + 远端 D1 + secret 注入"时执行；执行前把主机名填进自己的 `wrangler.jsonc`（不是 example）。

```bash
node -e "console.log('ADMIN_KEY=' + require('node:crypto').randomBytes(32).toString('base64url'))" >> .env.production
node -e "console.log('KEY_SECRET=' + require('node:crypto').randomBytes(32).toString('base64'))"  >> .env.production
chmod 600 .env.production          # 确认 git status 看不到

npm run deploy -- --secrets-file .env.production     # build → deploy → migrations → health
```

**云端补充检查（只验本地覆盖不到的）：**

| 检查 | 期望 |
|---|---|
| `curl -i https://<host>/api/health` | 200，证书有效（无 `-k`） |
| `curl -i https://<host>/api/admin/nodes` | 401 |
| 带正确 key 的 `GET /api/admin/nodes` | 200 `[]` |
| `npx wrangler d1 migrations apply DB --remote` | 无待应用迁移 |
| 浏览器 `/admin` 登录 + 建节点 | 与本地一致 |
| `npx wrangler secret list` | 只有 `ADMIN_KEY`、`KEY_SECRET`（`CF_DNS_API_TOKEN` 属 P1b） |

**失败回滚：** `npx wrangler rollback`；旧面板与其 D1 全程不动。域名本机不可解析时先判定是本地网络还是记录问题，不要为此改代码。

**Commit 7：** `P0: deploy to <host> and record smoke results`（只提交文档/配置，绝不提交 secret）

---

## 4. 关键实现约束（给执行者）

1. 不改渲染核心、不改 agent reconcile、不做 inbound/outbound 实体化（PLAN §0）。
2. `adminKey` 抛 `ApiError`，交给既有 `app.onError` 渲染 `{detail}`；不新增错误格式。
3. helper 注入条件必须是"路径前缀 + 无 Authorization"，否则会覆盖 node 测试的显式 token。
4. 前端 `api.ts` 仍是唯一 fetch 出口；`LoginPage` 的验证走同一文件的 `checkAdminKey`。
5. `vitest.config.ts` 的测试 binding 固定且非敏感；生产 secret 只能来自 `wrangler secret` / `--secrets-file`。
6. `worker-configuration.d.ts` 入库，由 `npm run types` 生成；`wrangler.example.jsonc` 变更后必须重新生成并一起提交。
7. `.dev.vars` 的每个键都必须在 `secrets.required` 里出现，否则本地 dev 不会绑定（§1 第 9 条）。
8. 不放宽断言让测试变绿；helper 只做认证注入（PLAN §9）。

---

## 5. P0 结束时的测试矩阵

| 层 | 命令 | 期望 |
|---|---|---|
| Worker（workerd + pure） | `npm test` | 241 passed / 32 files |
| 类型 | `npm run types && npm run typecheck` | 绿 |
| Worker 构建 | `npm run build` | 绿 |
| 前端 | `npm --prefix frontend test` | 26+ passed |
| 前端构建 | `npm --prefix frontend run build` | 绿 |
| Agent | `python -m pytest -q agent/tests` | 33 passed, 4 skipped |
| 本地端到端 | §3 P0.7 的 14 条 curl + 6 条浏览器 | 全部符合 |
| 部署脚本 | `npm run deploy -- --dry-run` | 退出码 0 |
| 云端（可延后） | §3 P0.8 | 全部符合 |

---

## 6. 验收

**P0 代码完成（本机）：**
- [ ] `npm test` 241、typecheck、build、前端 26+、agent 33 全绿
- [ ] 无 Access 残留；无 key 的 `/api/admin/*` 一律 401；带 key 的未知路径 404
- [ ] 粘贴 `ADMIN_KEY` 能登录；刷新保持；401 回登录；logout 清除
- [ ] 本地建节点、拿 token、看 fleet；订阅/节点面行为不变
- [ ] `rg -i lesserv` 只剩白名单（header + 注释出处）
- [ ] 三个源仓库 `git status` 为空

**需要云部署（PLAN §14 P0 的剩余项，可与 P1a 合并）：**
- [ ] 面板在自定义域可访问；`/api/health` 200；证书有效
- [ ] 远端 D1 迁移完成；secret 注入生效

---

## 7. 风险与对策（P0 特有）

| 风险 | 触发信号 | 对策 |
|---|---|---|
| 复制遗漏（`.gitignore`、`.dev.vars.example`） | `npm test` 缺 `wrangler.jsonc` / 类型缺失 | 用 §3 P0.1 的 `git archive` 清单；闸门逐条跑 |
| 改名残留 | `rg -i lesserv` 命中非白名单 | sed 顺序已实测；agent 侧必须跑 pytest |
| 测试依赖本地 `.dev.vars` | 无该文件时 12 个 500 | P0.3 的 binding；用"移走文件仍全绿"证明 |
| typecheck 依赖生成文件 | `Cannot find name 'D1Database'` | 先 `npm run types`；该文件入库 |
| 本地 dev 认不到 `ADMIN_KEY` | 正确 key 仍 401 | `secrets.required` 必须同时声明两个名字（§1 第 9 条） |
| 认证中间件顺序错 | node/sub 测试 401 | 只挂 `/api/admin/*`；G4 的 5 个用例覆盖 |
| 前端 401 死循环 | 每次请求都回登录 | 登录页只用 `checkAdminKey`，不走带 storage 鉴权的 `request()` |
| 云部署环境问题（DNS/域名） | curl 000 / 无 A 记录 | 与代码无关；P0 不阻塞，记录后转 P1a/P1c 处理 |

---

## 8. P0 明确不做

R2 / Workflows / cron / 证书相关迁移与端点；REALITY preset；`protocol: 2`；`X-Lesserv-Node` 改名；Agent E2E 重写；stats 关闭逻辑；link_profiles UI 隐藏；任何 Clash/B 拓扑/审计/配额。

---

## 9. 时间估算（含验证）

| 阶段 | 估算 |
|---|---|
| P0.1 复制 + 基线绿 | 0.5 h |
| P0.2 改名 | 0.5 h |
| P0.3 KEY_SECRET + hermetic | 0.25 h |
| P0.4 后端 auth + 测试 | 1 h |
| P0.5 前端登录 | 1.5 h |
| P0.6 配置/脚本/文档 | 1 h |
| P0.7 本地验收（功能完成） | 0.75 h |
| P0.8 云部署（可选/合并） | 0.5 h |
| **合计（到本机完成）** | **~5.5 h** |
