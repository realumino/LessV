# LessV — P1c 执行指南（文档、发布、全新 VPS 验收）

> 生成：2026-10-26 +0800。依据：工作树、git 历史、线上 Worker/D1/R2/Workflow、Cloudflare DNS、Linode API 与本机全量测试的实测。
> **一句话：功能已在 P1b 真实跑通；P1c 只做四件事——把文档改到与代码一致、把 agent 变成可下载的 release、在全新 VPS + 新域名上把 P1b 验收重做一遍并留下可复现证据、发布 LessV 并归档三个源仓库。**
> 阅读顺序：本文件从头读到 §4（决策）→ 执行 §5（P1c.0–P1c.6）→ 证据填 §6。需要背景时再看 `PLAN.md` §6–§7 与 `P1B-PLAN-CONTINUE.md` §3.5，不要通读 78K 的 `P1B-PLAN.md`。

---

## 0. 范围与完成定义

对应 `PLAN.md` §8 P1c 的 6 项任务，落成 7 个可执行任务：

| 任务 | 内容 | 产出 |
|---|---|---|
| P1c.0 | 预检、基线冻结、生成验收 key、确认决策 | 基线数字、key、决策记录 |
| P1c.1 | 文档校正 + preset 缺陷修复 | README / OPERATIONS / PROTOCOL / PLAN 附录；preset tag 修复 |
| P1c.2 | agent release 通道 | 可 `curl` 的 tarball（+ sha256） |
| P1c.3 | 验收工具 | `scripts/p1c_accept.mjs`（平面侧只读 + 可选续期） |
| P1c.4 | 全新 VPS + 新域名完整验收 | §6 证据矩阵全绿 + 30 分钟计时记录 |
| P1c.5 | 清理、发布、归档 | 源仓库 archived、LessV tag、PLAN §14 勾选 |
| P1c.6 | 收尾提交与最终回归 | 干净工作树、全绿测试、执行记录 |

**完成判据**（`PLAN.md` §14 P1c）：README 从零到可用 ≤30 分钟（不含 Xray 安装）；OPERATIONS/PROTOCOL 与实际一致；agent release 可下载安装；全新 VPS + 新域名完整验收；源仓库归档，LessV 打 tag。

**明确不在 P1c 内**：

- 不重新部署一套新平面（新 Worker/D1/R2/域名）。P1c 验收的是“节点接入 + 证书 + 自偷”这条链，平面部署已在 P0/P1a/P1b 多次演练（当前 4 条部署记录）；若要换平面，那是 P2。
- 不做 B 拓扑、Clash、stats、revoke UI、nginx 配置托管（`PLAN.md` §12）。
- 不重写 agent/渲染/ACME。
- 不删 `tokyo01` 历史节点行以外的任何 D1 证据；不碰 `certworker` 遗留 Workflow。

---

## 1. 已核实的起点（2026-10-26 实测）

### 1.1 Git

- 分支 `main`，HEAD `8b0e433`（`P1b: record final status`），工作树干净（只剩 ignored 文件；本文件 `P1C-PLAN.md` 是唯一未跟踪文件，P1c.6 提交）。
- **没有 remote，没有 tag**：`git remote -v` 为空、`git tag -l` 为空。P1c 要新建仓库。
- 源仓库远端：`Lesserv-Cloud`、`Lesserv-Agent`、`certworker`，均 **public**（未认证 GitHub API 返回 200），工作树 clean。
- ignored 且必须继续 ignored：`.dev.vars`、`.env.production`、`wrangler.jsonc`（真实 `database_id` 在这里）、`dist/`、`frontend/dist/`。

### 1.2 本地测试与构建（实测）

| 命令 | 结果 |
|---|---|
| `npm test` | **55 files / 387 passed**，20.5s |
| `npm run typecheck` | 通过 |
| `npm --prefix frontend test` | **7 files / 37 passed** |
| `python -m pytest -q agent/tests` | **63 passed / 0 failed / 13 skipped**（POSIX 文件模式/符号链接用例在 Windows skip） |
| `npm run deploy -- --dry-run` | 6 asset files；1587.93 KiB / gzip 280.84 KiB；DB/CERTS/ISSUANCE 三个 binding 正常 |
| 临时移走 `.dev.vars` 跑 `health` + `admin_auth` + `cert_delivery` | 3 files / 11 passed → README 的 hermetic 声明成立（`.dev.vars` 存在时 miniflare 会多打印一行 “Using secrets defined in .dev.vars”，但 `vitest.config.ts` 的固定绑定生效） |

### 1.3 线上平面

| 资源 | 实测 |
|---|---|
| 面板 | `https://cp.example.com`；`/api/health` 200；`/api/admin/nodes` 带 key 200 |
| Worker | `lessv`；`wrangler deployments list` 共 4 条记录，最新 `2026-10-25T14:25:56Z` |
| 部署 = HEAD？ | `git log -1 -- src frontend/src migrations` = `c55fb7a`（22:26:21 +0800 = 14:26:21Z），部署早 25 秒但已含该修改；行为证据：`GET /api/admin/nodes/tokyo01/config/runtime` 的 clients 带 `"flow":"xtls-rprx-vision"` |
| D1 | `lessv` / `00000000-0000-4000-8000-000000000002`；`migrations list --remote` → **No migrations to apply**（0001–0006） |
| R2 | 桶 `lessv-certs`（binding `CERTS`） |
| Workflow | `lessv-cert-issuance` / `CertificateWorkflow`；cron `17 3 * * *`。另有 `certworker` / `certificate-issuance` 遗留，**不要动** |
| Secrets | `ADMIN_KEY`、`CF_DNS_API_TOKEN`、`KEY_SECRET`（只有名字可核实） |

### 1.4 D1 关键数据（云端实查）

| 表 | 数据 |
|---|---|
| `nodes` | 仅 `tokyo01`：address `tokyo01.example.com`，health ok，`nginx_ok=1`，`cert_etag="bfc34029…"`，**`cert_synced_at=NULL`**，`agent_version=0.2.0`（VPS 已删，P1c 不复活它） |
| `cert_domains` | `tokyo01.example.com` = `00000000-0000-4000-8000-000000000001`，active，`tlsserver`，`renew_before_days=null`；`fail.example.com` = `00000001…`，deleted |
| `certificates` | production current `d2b6ac82-…`，serial `052988eb…`，not_after `2026-12-09T13:31:51Z`；production 旧 `32af3cd9-…`（`is_current=0`，已 purge）；staging current `1c8f5ea9-…`，not_after `2026-12-09T13:09:12Z` |
| `node_cert_domains` | `tokyo01 → 00000000…` |
| `user_node_access` | `alice → tokyo01`，`allowed_inbounds=["reality"]`，`allowed_outbounds=["direct"]`（节点已死，行保留） |

注意：`tokyo01.example.com` 仍是 active 的证书域，**每日 cron 到 2026-11-09 后会开始为一个不存在的节点续签**。P1c 结束默认软删除它（§5 P1c.5）。

### 1.5 域名与主机

- Cloudflare 账号只有 **一个 zone**：`example.com` = `00000000000000000000000000000001`，active。
- 无 CAA 记录（`0 issue "none"` 不存在，不会误伤 Let's Encrypt）。
- 现有记录：`unrelated-jp01` A/AAAA（无关项目）、`blog` CNAME（proxied）、`cp.example.com` **AAAA `100::` proxied**（Workers 自定义域占位）、邮件相关 MX/TXT。`tokyo01` 的 A 记录已在 P1b.10 删除。
- Linode 只有 `unrelated-jp01`（id `100000006`，jp-tyo-3）——**不是本项目的，不要动**。`~/.lessv/linode.env` 仍有效（2027-04-25 到期）。
- `~/.ssh/config` 有一个陈旧的 `# lessv-p1a begin … end` 块，指向已删除的 `203.0.113.10` 和不存在的 `~/.ssh/lessv_p1b_ed25519`。P1c.4 的 `linode_provision create` 会重写该块；不要手写第二份。

### 1.6 本机工具

`ssh`、`ssh-keygen`、`openssl`、`curl`、`node 26`、`npx wrangler 4.152` 均可用；无 `gh` CLI；无 WSL（所以 13 个 POSIX-only agent 测试只能在 Linux 上跑，见 P1c.4 步骤 2）。

---

## 2. 文档与代码的已核实偏差（P1c.1 的输入）

按“以代码为事实”逐条核实过。行号是当前 HEAD 的。

| # | 位置 | 现状 | 事实 | 处理 |
|---|---|---|---|---|
| D1 | `README.md:87` | 前提只要求“已装好 Xray” | `agent/install.sh` 硬性 `need nginx` + `systemctl cat nginx`，缺 nginx 时第 3 步直接失败 | 前提加 nginx（含 `apt-get install -y nginx`），或把安装命令并入第 1 步；**这会决定 30 分钟计时从哪开始** |
| D2 | `README.md:168` | agent “62 passed / 12 skipped” | 实测 63 / 13 | 改数字 |
| D3 | `README.md:90` | step 1 是“本地 `npm run release:agent` + scp” | P1c 要有下载通道 | 改成 `curl` release → `sha256sum -c` → 解包；本地构建保留给维护者 |
| D4 | `docs/PROTOCOL.md:67` | heartbeat 请求 `{protocol, status}` | 实际 `HeartbeatIn` = `{protocol, applied_hash?, applied_at?, xray_running?, xray_pid?, agent_uptime?, last_error?}`；`status` 字段根本不存在 | 重写（§7 附录 A） |
| D5 | `docs/PROTOCOL.md:137` | report 基础体 `{protocol, applied_hash, health, last_error}` | 实际 `ReportIn` = `{protocol, hash(必填), ok(必填), stage(6 值枚举), xray_exit_code?, error?, nginx_*?, cert_etag?, cert_synced_at?}`；按文档发会 422 | 重写（§7 附录 A） |
| D6 | `docs/PROTOCOL.md:77` | 409 体 `{message, desired_hash}` | 实际是 `{"detail":{"message":…,"desired_hash":…}}`（`ApiError` 统一包 `detail`，测试 `node_protocol.test.ts:429` 就按 `.detail.desired_hash` 断言） | 改嵌套 |
| D7 | `docs/PROTOCOL.md:69` | `actions` 永远为空 | 平面确实只发 `[]`，但 agent 会处理 `"restart_xray"`（`loop.py:165`） | 写清楚“当前不发，但 agent 兼容” |
| D8 | `docs/PROTOCOL.md` 全文 | 未写 422 形状 | `parseJsonBody` 失败 → `422 {"detail":[{"msg":…}]}`；只有协议版本不符是 `400 {"detail":"unsupported protocol N"}` | 增加错误形状小节 |
| D9 | `docs/OPERATIONS.md:47` | run 阶段 `create-account → create-order → publish-txt → accept → wait-propagation → finalize → store` | 实际 `src/cert/issue/workflow.ts` 的 phase：`load → ensure-account → new-order-<n> → publish-txt-<n> → wait-propagation-<n> → accept-challenges-<n> → await-authz-<n> → key+csr → finalize+store → purge-previous → cleanup-txt → finish-run`，另有 `order-expired-<n>`（重开）与 `cleanup-failed-artifacts` | 改列表 |
| D10 | `docs/OPERATIONS.md:63` | “Writes go to a temp directory, then current swaps…” | 实际直接写 `<fingerprint>/` 版本目录（content-addressed），`current` 用临时 symlink + `os.replace`；`current` 若是真目录会被拒绝（`certs.py:156`） | 改措辞 |
| D11 | `docs/OPERATIONS.md:153` | 失败表说 warnings 里有 `nginx unit is not active` | 该字符串是 agent 上报的 `nginx_error`；lint 在面板上拼成 `nginx is not healthy: nginx unit is not active` | 改措辞，并指向 `nginx_error` 字段 |
| D12 | `PLAN.md:753` 附录 A | outbound tag 是 `"BLOCK"` | 前端 preset 实际生成 `"block"`（`frontend/src/lib/reality_preset.ts`）。`config_service.outboundTags()` 只排除精确的 `"BLOCK"`，所以 `block` 会被当作可路由出口：allocator 会为它生成规则、渲染成 `<node>-block`（实测 tokyo01 runtime 是 `BLOCK,tokyo01-block,tokyo01-direct`），用户一旦授权 `block` 流量就直接进黑洞；授权页同时列出 `BLOCK` 和 `block` 两个黑洞 | **改代码**（1 行 + 1 个测试），见 P1c.1.4；改完附录 A 与代码就一致 |
| D13 | `src/models.ts:304,315,333,351` | 注释写 “PROTOCOL.md, protocol 1” | 协议已是 2 | 注释改 2（无行为变化） |
| D14 | `README.md:58` | “测试不读 `.dev.vars`” | 实测成立；但 `.dev.vars` 存在时 miniflare 会打印一行 loading 提示，容易误读 | 保留结论，加一句括注 |

另有三条**不是偏差、但 P1c 必须知道**：

- `PLAN.md` §10 说“必须手动写入远程 `database_id`”，而 `wrangler.example.jsonc` 的注释说 wrangler 会自动 provisioning 并写回。当前 `wrangler.jsonc` 已有 `database_id`，两种说法都不影响 P1c；README 不要展开这段历史。
- `p1a_smoke.mjs` 只覆盖 P1a 形状（`--expect-sni www.microsoft.com`），没有任何节点侧/证书检查。P1c 需要新脚本（P1c.3），`p1a_smoke.mjs` 保留不动。
- 用户授权页把 `BLOCK` 也列成可选 outbound（`UserEditPage.tsx:390` 直接映射 `/outbounds`，不过滤）。这是 P1a 遗留的 UX 瑕疵，不影响 P1c 验收；记为 P2 清理项，不在 P1c 改。

---

## 3. 已完成/未完成状态一览

| 项 | 状态 |
|---|---|
| Worker/前端/agent/证书链路（P1b） | 完成（`8b0e433`） |
| 文档存在性 | README / OPERATIONS / PROTOCOL 都在，但 §2 的偏差未修 |
| agent 0.2.1 `cert_synced_at` 修复 | 代码完成、单测完成，**真机未验证**（P1b 遗留，P1c 步骤负责） |
| agent release | 只能本地构建 + scp；无线上下载通道 |
| 验收夹具 | 无 VPS（tokyo01 已删）、无新域名、`~/.ssh/config` 陈旧 |
| 源仓库归档 / LessV tag | 未做 |

---

## 4. 先回答的决策（默认值已给，不改就按默认执行）

### D-A：agent release 从哪下载？

| 方案 | 内容 | 代价 | 结论 |
|---|---|---|---|
| **A1（推荐）** | 建 `realumino/lessv`（public，和三个源仓库一致），把 `dist/lessv-agent-0.2.1.tar.gz` + `.sha256` 挂到 release tag `agent-v0.2.1`；README 用 `curl -fsSLO` | 零代码、零重新部署；顺带满足 P1c.5 的“归档源仓库 + LessV 打 tag” | **默认** |
| A2 | 平面托管：`GET /api/admin/agent-release` 从 `CERTS` 桶流式返回 `agent/<name>.tar.gz`，admin key 保护；`release_agent.mjs --upload` | 新增端点 + 测试 + 重新部署 + `PLAN.md` §6.1 先改；私有仓库也能用 | 若仓库必须 private，走这条（§7 附录 B 给了实现清单） |
| A3 | 只保留本地构建 + scp | 不满足“可下载安装” | 不可接受 |

已核实：仓库目前的 tracked 文件里**没有真实 secret**（`git grep` 只命中 `.dev.vars.example` 的占位值；zone id / D1 id 出现在 P1A/P1B 计划文档里，属于标识符不是凭证）。public 化的唯一实质动作是确认这一点并在 push 前再跑一次审计（P1c.2 步骤 1）。

### D-B：用什么“全新域名”？

| 方案 | 内容 | 结论 |
|---|---|---|
| **B1（推荐）** | 现有 zone 里的新名字 `p1c.example.com`（DNS only，A → 新 VPS），节点地址 / `serverNames` / 证书域都用它 | **默认**：账号里只有一个 zone，买新域名不在本任务授权内；新名字仍会走完整的 zone 选择、DNS-01、CAA 检查路径 |
| B2 | 新注册/迁入一个独立 zone | 需要你先提供域名并把它加进 Cloudflare；流程不变，把 `<name>` 换掉即可 |

### D-C：客户端怎么证明“能上网”？

| 方案 | 内容 | 结论 |
|---|---|---|
| **C1（推荐）** | 第二台小 Linode（`sg-sin-2`）跑真实 Xray 客户端，`scripts/subscription_to_xray.mjs` 生成 client.json，`curl --socks5-hostname https://api.ipify.org` 期望返回节点 IP；再从隧道里取 `https://<name>/` 期望命中假站点 | **默认**：P1a 已验证过这套；可复现、可留证据 |
| C2 | 只用人工客户端导入（v2rayN/NekoBox） | 作为补充，不作为唯一证据 |

### D-D：`tokyo01.example.com` 的证书域怎么处理？

默认 **P1c 结束软删除**（`DELETE /api/admin/cert-domains/<id>`，要求无活动 run；行保留 `status=deleted`，节点分配一并移除）。理由：它指向已删节点，active 状态下 cron 会永久续签。证据（D1 行、run 记录、本文档）都保留。若你要留活证书作对照，跳过 P1c.5 步骤 2，并在执行记录里写明。

### D-E：是否构建 `scripts/p1c_accept.mjs`？

默认 **构建**（约 200 行、无新依赖、只读 + 一个显式 `--renew`）。理由：P1b 的教训是“手工记录的验收不可信”；P1c 的验收要吃两次（初次与续期后），脚本让证据可复现。若你要求零新增代码，退化为 §6 的手工命令表，并在执行记录里贴原始输出。

---

## 5. 任务分解

### P1c.0 预检与基线冻结（约 30 分钟）

1. 确认工作树与 §1.1 一致：
   ```bash
   cd C:/Users/dev/Documents/GitHub/LessV
   git status --porcelain=v1 -uall      # 期望只有 ?? P1C-PLAN.md（本文件，P1c.6 才提交）
   git log -1 --oneline                 # 期望 8b0e433
   ```
2. 记下基线（写进 §8 执行记录，不新建文件）：
   ```bash
   npm test 2>&1 | tail -4
   npm run typecheck && echo TYPECHECK_OK
   npm --prefix frontend test 2>&1 | tail -4
   python -m pytest -q agent/tests 2>&1 | tail -2
   ```
3. 生成验收用 SSH key（P1b 的 key 已删）：
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/lessv_p1c_ed25519 -N "" -C "lessv-p1c"
   ```
4. 冻结规则：**P1c.1 的代码修改（只有 preset tag 与两处模型注释，后者无行为变化）必须在 P1c.4 验收前完成并部署**；验收开始后不再改 `src/`、`frontend/src/`、`agent/`。文档改动随时可做。
5. 在 §8 顶部写下决策 D-A/D-B/D-C/D-D/D-E 的选择。

**完成判据**：基线数字与 §1.2 一致；key 存在；决策已记录。

---

### P1c.1 文档校正 + preset 修复（约半天）

顺序：先改代码（1.4），再改文档，最后跑全量测试。

#### 1.1 `README.md`

目标结构（保持现有语气，不新增教程章节）：

1. 是什么 + 拓扑图（保留）
2. 仓库结构（现有“0001–0004 是 P0 全量，0005/0006 是 P1b 证书”已准确，保留）
3. 本地开发 + 测试矩阵（数字改 63/13；`.dev.vars` 那条加括注）
4. 部署平面（现有 8 步，保留；把 `wrangler deployments list` / `workflows list` 的验证行留下）
5. **首节点（≤30 分钟）**——重写，按 §5 P1c.4 的顺序；前提必须包含：Debian 12 / root SSH / 443 与 8443 空闲 / Xray 已装 / **nginx 已装**（`apt-get install -y nginx`）/ 一个 DNS-only 的 A 记录
6. 证书（测试签发 → 生产 → 分配 → 续期 → 面板能看到什么）
7. 用户与订阅
8. 排障（短，指向 OPERATIONS）
9. 当前状态（P0/P1a/P1b/P1c 各一行）
10. 已知限制（`expire` 只影响订阅；`PUT` 不能把 `expire` 改回 null；无节点删除 API；nginx 片段手工；`ADMIN_KEY` 等价 root；`KEY_SECRET` 不可轮换；preset 的 `BLOCK` 修复说明）

必改点：D1、D2、D3、D14；第 5 节的命令必须与 P1c.4 实际跑过的完全一致（验收后回填真实 `<ver>` 与地址）。

#### 1.2 `docs/OPERATIONS.md`

- 修 D9（阶段列表）、D10（写入语义）、D11（`nginx_error` 与 lint 措辞）。
- 增加一小节“preset 生成什么”：一个 inbound + `BLOCK` + `direct`；`BLOCK` 由面板保证在首位，其余 outbound 渲染时加 `<node>-` 前缀；授权页只应选 `direct`（以及管理员自己添加的出口）。
- 保留现有排障顺序与失败对照表（P1b 已核对过大部分）；把“renewed cert never appears”一行的判据改成 `nodes.cert_etag` 与 `/api/node/certs` 的 ETag 比较（当前实现就是这样）。

#### 1.3 `docs/PROTOCOL.md`

- 修 D4–D8：heartbeat / report / 409 / actions / 422 五处（§7 附录 A 给了可直接粘贴的正文）。
- 把 `stage` 的 6 个取值和“只有 `applied` / `started` 会推进 `applied_hash` 与 `health`”写进 report 小节（代码：`node_state_service.ts:20,132-145`）。
- 保留 `protocol 2` 冻结声明；在顶部把“after deploying this plane, upgrade every node's agent to 0.2.1”改成“本仓库 agent 0.2.1 起”；不用提 P1c 新节点 id。

#### 1.4 代码修复：preset 的 blackhole tag 改成 `BLOCK`（D12）

改动：

- `frontend/src/lib/reality_preset.ts`：`{ tag: "block", protocol: "blackhole" }` → `{ tag: "BLOCK", protocol: "blackhole" }`（`direct` 不动）。
- `frontend/src/lib/reality_preset.test.ts:30`：期望值同步改 `BLOCK`。

为什么必须改：`outboundTags()` 只排除精确 `"BLOCK"`（`src/services/config_service.ts:114`），小写 `block` 会被当成可路由出口（allocator 为它生成规则、渲染成 `<node>-block`）并多出一个黑洞；`PLAN.md` 附录 A 本来写的就是 `BLOCK`，是代码偏离了文档。

验证：

```bash
npm --prefix frontend test          # 37 + 1 改断言，仍全绿
npm --prefix frontend run build
npm test                            # worker 不涉及，但确认没连带
```

部署（验收前必须）：

```bash
npm run deploy                      # 不带 --secrets-file：secrets 不变
```

部署后验证（新节点建好后再看，或用一个临时节点）：

```bash
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
curl -sS -H "Authorization: Bearer $ADMIN_KEY" https://cp.example.com/api/admin/nodes/<new>/outbounds
# 期望 BLOCK + direct（以及管理员另加的出口），不再有 block；
# 用户授权页的出口列表同样只有 direct（BLOCK 仍会被列出，属 P2 清理项）
```

#### 1.5 `PLAN.md` 与本文件

- `PLAN.md` §8 P1c 段末加状态行（开始就写“进行中”，P1c.5 改成完成）；§14 P1c 打勾在 P1c.5。
- `PLAN.md` 附录 A 的 outbound tag 保持 `BLOCK`（1.4 改完即一致）。
- 本文件 §8 追加执行记录。

#### 1.6 文档一致性验证（机械执行）

```bash
# 协议事实
grep -n "hash: z.string()\|ok: z.boolean()\|stage: z.enum" src/models.ts
grep -n "SUCCESS_STAGES" src/services/node_state_service.ts
grep -n "detail: error.detail" src/main.ts
# 阶段名
grep -n 'phase(step, runId,' src/cert/issue/workflow.ts
# 证书路径与权限
grep -n "0o644\|0o600\|0o640\|os.replace" agent/lessv_agent/certs.py
# 部署参数
grep -n "secrets-file\|migrations apply\|api/health" scripts/deploy.mjs
```

每条文档断言都要能对应到上面某一行的输出；对不上就改文档，不改代码（除 D12）。

**完成判据**：README/OPERATIONS/PROTOCOL 与代码逐条一致；`frontend` 测试 37 passed；部署后 `/outbounds` 不再出现 `block`；worker 387 / agent 63+13 仍全绿。

---

### P1c.2 agent release 通道（约 1 小时，按 D-A 选择）

#### 方案 A1：GitHub release（默认）

1. 发布前审计（必须全空）：
   ```bash
   git ls-files | wc -l                                            # 当前 230
   git ls-files | grep -E '^(wrangler\.jsonc|\.env|\.dev\.vars|dist/)'   # 空
   git grep -n -I -E '(ADMIN_KEY|KEY_SECRET|CF_DNS_API_TOKEN|LINODE_TOKEN)=[A-Za-z0-9+/=_-]{16,}'   # 空
   git ls-files -z | xargs -0 grep -lI "BEGIN.*PRIVATE KEY" | head  # 空
   ```
2. 建远程并推送：
   ```bash
   git remote add origin https://gitee.com/realumino/lessv.git
   git push -u origin main
   ```
   仓库可见性按 D-A 的选择；默认 public（与三个源仓库一致）。
3. 构建并校验 tarball（要求 `agent/` 已提交、工作树干净）：
   ```bash
   npm run release:agent     # dist/lessv-agent-0.2.1.tar.gz + .sha256，自带内容校验
   sha256sum dist/lessv-agent-0.2.1.tar.gz
   ```
4. 打 agent tag 并挂 release（web UI：Releases → Draft a new release → tag `agent-v0.2.1` → 上传 tarball 和 `.sha256`）：
   ```bash
   git tag -a agent-v0.2.1 -m "LessV agent 0.2.1"
   git push origin agent-v0.2.1
   ```
   tag 名与仓库版本（`v0.1.0`，P1c.5 打）分开：agent 版本本来就独立（`release_agent.mjs` 的注释也这么写）。
5. 验证“可下载安装”（在任意一台机器）：
   ```bash
   curl -fsSLO https://gitee.com/realumino/lessv/releases/download/agent-v0.2.1/lessv-agent-0.2.1.tar.gz
   curl -fsSLO https://gitee.com/realumino/lessv/releases/download/agent-v0.2.1/lessv-agent-0.2.1.tar.gz.sha256
   sha256sum -c lessv-agent-0.2.1.tar.gz.sha256
   ```

#### 方案 A2：平面托管（只有选它才做）

见 §7 附录 B。顺序：先改 `PLAN.md` §6.1，再写路由/测试/脚本，部署，然后在 README 写 `curl -H "Authorization: Bearer $ADMIN_KEY"`。

**完成判据**：`curl` 能拿到 tarball，`sha256sum -c` 通过，README 的安装命令就是这条路径。

---

### P1c.3 验收脚本（约 1 小时，按 D-E）

新增 `scripts/p1c_accept.mjs`：

```
node scripts/p1c_accept.mjs --host https://cp.example.com \
  --admin-key-file .env.production --node p1c01 --user p1cuser \
  --domain p1c.example.com --fingerprint <node current 指纹> \
  [--renew] 
```

原则与检查清单：

- 只读；唯一写操作是 `--renew`（`POST /issue` + 轮询 run）。
- 不打印 key、token、uuid、私钥；失败只打印字段名与期望值。
- 检查项：
  1. `/api/health` 200；`/api/admin/nodes` 无 key 401、错 key 401、正确 200。
  2. `/api/admin/nodes/<node>/sync`：`desired_hash` 非空、`applied_hash == desired_hash`、`health=ok`、`last_error=null`、`nginx_ok=1`、`nginx_error=null`、`cert_synced_at` 为整数、`warnings` 里没有 `not covered` / `not 127.0.0.1` / `nginx is not healthy`。
  3. `/api/admin/nodes/<node>/certs`：至少一条，`profile=tlsserver`，`environment=production`，`not_after > now`，`fingerprint_sha256 == --fingerprint`（这条把“平面清单 = 节点磁盘”钉死）。
  4. `/api/admin/cert-domains/<id>/certs`：production 与 staging 各一条 current，且 staging 那条 `environment=staging`；节点清单里**没有** staging。
  5. `/api/admin/users/<user>/links` + `/sub/<token>`：base64 解码后与 links 完全一致；URI 含 `security=reality`、`sni=<domain>`、`flow=xtls-rprx-vision`、`pbk`、`sid`、`spx`、`encryption=none`、`type=tcp`。
  6. `--renew`：issue → 轮询 `/api/admin/cert-runs/<id>` 到 `succeeded`（或打印 `error` 原文并不通过）→ 重新检查 2/3（fingerprint 必须变）；不检查节点磁盘（那两条 ssh 命令由人工填 §6）。
- 退出码：0 全通过，1 有 FAIL，2 参数错误（与 `p1a_smoke.mjs` 一致）。

**完成判据**：脚本 `node --check` 通过；对现有 `tokyo01` 能跑完并只有预期失败（检查 2 会在 `cert_synced_at=NULL` 处 FAIL——这正是 0.2.1 要修的现象；检查 3 仍会通过，因为节点行与分配都还在）。正式全绿要等 P1c.4。

---

### P1c.4 全新 VPS + 新域名完整验收（约半天）

#### 步骤 1：夹具（不计时）

```bash
# 两台：server(jp-tyo-3) + client(sg-sin-2)；会重写 ~/.ssh/config 的 lessv-p1a 块
node scripts/linode_provision.mjs create --token-file ~/.lessv/linode.env \
  --ssh-key ~/.ssh/lessv_p1c_ed25519.pub --out ~/.lessv/acceptance/p1c-linode.json
ssh lessv-server 'true'; ssh lessv-client 'true'          # 确认 ssh config 生效
```

Xray（两台都装，不计时）：

```bash
ssh lessv-server 'bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install'
ssh lessv-client 'bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install'
```

DNS（DNS only，`proxied:false`，这是硬要求：REALITY 与 nginx 都必须直连）：

```bash
set -a; . ~/.lessv/cloudflare.env; set +a
ZONE=00000000000000000000000000000001
curl -sS -X POST -H "Authorization: Bearer $CF_DNS_API_TOKEN" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" \
  --data '{"type":"A","name":"p1c.example.com","content":"<server-ip>","ttl":60,"proxied":false}'
ssh lessv-server 'getent hosts p1c.example.com'   # 期望 <server-ip>（Windows 无 dig）
```

POSIX-only agent 测试（Linux 上第一次执行 `agent/tests` 的 13 个 skip 用例；不计时）：

```bash
scp -r agent lessv-server:/tmp/lessv-agent-src
ssh lessv-server 'apt-get install -y -qq python3-pytest && cd /tmp/lessv-agent-src && python3 -m pytest -q tests --ignore=tests/test_e2e_pull.py'
```

期望：**70 passed / 0 skipped**（Windows 上是 63 passed / 13 skipped；`--ignore` 掉 e2e 的 6 个用例，因为它需要整个 repo + node/npm）。任一失败先修再继续——这是 0.2.1 的 POSIX 路径第一次真跑。

#### 步骤 2：计时开始（T0）

T0 = 在节点上执行第一条 README“首节点”命令（nginx 安装）的时刻；T1 = 步骤 8 的最后一个成功检查。**排除**：Xray 安装、DNS 传播（>60s 的异常要记）、LE 队列抖动（记实际值）。

1. nginx：
   ```bash
   ssh lessv-server 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx && nginx -v'
   ```
2. 平面建节点 + mint token（laptop）：
   ```bash
   ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
   CP=https://cp.example.com; NODE=p1c01; NAME=p1c.example.com
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"id\":\"$NODE\",\"label\":\"P1C Tokyo\",\"address\":\"$NAME\"}" $CP/api/admin/nodes
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" $CP/api/admin/nodes/$NODE/token
   ```
   记下 token；只显示一次。
3. 下载并安装 agent（release 由面板托管在 R2 `CERTS` 桶上：`GET /api/admin/agent-release`，admin key 保护；下载 URL/文件名与 README 首节点第 3 步逐字对应，只是改由 `printf | ssh` 传 key，不然 ssh 内嵌 `read -rs` 无法从非交互 stdin 拿到 key；token 走 stdin）：
   ```bash
   printf '%s\n' "$ADMIN_KEY" | ssh lessv-server 'read -rs AK; cd /tmp && \
     curl -fsS -H "Authorization: Bearer $AK" -o lessv-agent-0.2.1.tar.gz "https://cp.example.com/api/admin/agent-release?version=0.2.1" && \
     curl -fsS -H "Authorization: Bearer $AK" -o lessv-agent-0.2.1.tar.gz.sha256 "https://cp.example.com/api/admin/agent-release?version=0.2.1&sha256" && \
     sha256sum -c lessv-agent-0.2.1.tar.gz.sha256 && \
     mkdir -p /tmp/lessv-agent && tar -xzf lessv-agent-0.2.1.tar.gz -C /tmp/lessv-agent --strip-components=1'
   ssh -t lessv-server 'cd /tmp/lessv-agent && ./install.sh --cp https://cp.example.com --node p1c01'
   ```
   期望：`lessv-agent installed and started`；`journalctl -u lessv-agent -n 20` 有 enroll 成功。
4. 写 REALITY 配置（面板 preset 的等价 JSON；也可以点 UI 的 REALITY preset → Fill editor → Save）：
   ```bash
   cat > /tmp/p1c-reality.json <<'JSON'
   {
     "log": { "loglevel": "warning" },
     "inbounds": [{
       "tag": "reality", "listen": "0.0.0.0", "port": 443, "protocol": "vless",
       "settings": { "clients": [], "decryption": "none", "flow": "xtls-rprx-vision" },
       "streamSettings": {
         "network": "tcp", "security": "reality",
         "realitySettings": {
           "dest": "127.0.0.1:8443", "serverNames": ["p1c.example.com"],
           "privateKey": "", "shortIds": ["<8 hex>"],
           "settings": { "fingerprint": "chrome", "spiderX": "/" }
         }
       }
     }],
     "outbounds": [
       { "tag": "BLOCK", "protocol": "blackhole" },
       { "tag": "direct", "protocol": "freedom" }
     ],
     "routing": { "rules": [] }
   }
   JSON
   curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     --data @/tmp/p1c-reality.json $CP/api/admin/nodes/$NODE/config
   ```
   等 ≤60s：`/sync` 的 `applied_hash == desired_hash`，`health=ok`。
5. 测试签发（staging）→ 生产签发（`ZONE` 沿用步骤 1 的变量）：
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"name\":\"$NAME\",\"zone_id\":\"$ZONE\",\"include_wildcard\":false}" $CP/api/admin/cert-domains
   DOMAIN_ID=<返回的 id>
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" $CP/api/admin/cert-domains/$DOMAIN_ID/test-issue
   # 轮询 /runs 到 succeeded；再看 /certs：staging current 有、production current 仍为空
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"confirm\":\"$NAME\"}" $CP/api/admin/cert-domains/$DOMAIN_ID/issue
   # 轮询到 succeeded；记 serial / not_after / profile=tlsserver
   ```
6. 分配证书：
   ```bash
   curl -sS -X PUT -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"domain_ids\":[\"$DOMAIN_ID\"]}" $CP/api/admin/nodes/$NODE/cert-domains
   ```
   等 ≤60s：节点写入证书（见步骤 8 的 ssh 检查）。
7. 装 nginx 假站点（片段里的路径必须与证书域一致）：
   ```bash
   ssh lessv-server 'cat > /etc/nginx/sites-available/lessv-decoy <<"NGINX"
   server {
       listen 127.0.0.1:8443 ssl;
       server_name p1c.example.com;
       ssl_certificate     /etc/lessv/certs/p1c.example.com/current/fullchain.pem;
       ssl_certificate_key /etc/lessv/certs/p1c.example.com/current/privkey.pem;
       ssl_protocols       TLSv1.2 TLSv1.3;
       root  /var/www/lessv-decoy;
       index index.html;
       location / { try_files $uri $uri/ =404; }
   }
   NGINX
   rm -f /etc/nginx/sites-enabled/default
   ln -sf /etc/nginx/sites-available/lessv-decoy /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx'
   ```
8. 建用户 + 订阅 + 客户端探针：
   ```bash
   curl -sS -H "Authorization: Bearer $ADMIN_KEY" -H 'Content-Type: application/json' \
     -d "{\"username\":\"p1cuser\",\"access\":{\"$NODE\":{\"allowed_inbounds\":[\"reality\"],\"allowed_outbounds\":[\"direct\"]}}}" \
     $CP/api/admin/users
   curl -sS -X POST -H "Authorization: Bearer $ADMIN_KEY" $CP/api/admin/users/p1cuser/sub-token   # 201，返回 {username, sub_token, created_at}
   SUB_TOKEN=<响应里的 sub_token>
   # laptop：取订阅并生成客户端 JSON，再 scp 到 probe host
   curl -sS $CP/sub/$SUB_TOKEN -o /tmp/sub.txt
   node scripts/subscription_to_xray.mjs --sub /tmp/sub.txt --out /tmp/client.json --socks-port 1080
   scp /tmp/client.json lessv-client:/tmp/client.json
   ssh lessv-client 'systemctl stop xray; nohup xray run -c /tmp/client.json >/tmp/xray-client.log 2>&1 & sleep 2'
   ssh lessv-client 'curl -sS --socks5-hostname 127.0.0.1:1080 https://api.ipify.org; echo'
   # 期望 == server 公网 IP
   ssh lessv-client 'curl -sS --socks5-hostname 127.0.0.1:1080 -o /dev/null -w "%{http_code} %{ssl_verify_result}\n" https://p1c.example.com/'
   # 期望 "200 0"：隧道内也是一张有效证书（REALITY 把非 REALITY 的 TLS 转给 nginx）
   ```
   最后从 laptop 直连一次（同样期望 200 且证书有效，不带 `-k`）：
   ```bash
   curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://p1c.example.com/
   ```

#### 步骤 3：验收矩阵（每条都要在 §6 留证据）

| # | 检查 | 方法 | 期望 |
|---|---|---|---|
| A01 | 平面健康与鉴权 | `p1c_accept.mjs` 检查 1 | 200 / 401 / 401 / 200 |
| A02 | 配置收敛 | `/sync` | `applied_hash == desired_hash`，`health=ok`，`last_error=null` |
| A03 | staging 测试签发 | `POST test-issue` + `/certs` | run `succeeded`；staging current 有；**production current 仍为空** |
| A04 | 生产签发 | `POST issue` + `/certs` | `profile=tlsserver`；`not_after - not_before ≈ 45 天`；SAN = `[p1c.example.com]` |
| A05 | 节点投递 | `/nodes/<n>/certs` | 一条，`environment=production`，fingerprint = 节点 `current` |
| A06 | 文件与权限 | `ssh`: `readlink -f …/current`、`stat -c '%a %U:%G' …/fullchain.pem …/privkey.pem` | `current` → `<fingerprint>`；`644 root:root`、`600 root:root` |
| A07 | nginx | `nginx -t`、`systemctl is-active nginx`、`journalctl -u nginx -n 20` | OK / active / reload 成功 |
| A08 | 面板 NGINX 状态 | `/sync` | `nginx_ok=1`，`nginx_error=null` |
| A09 | 假站点证书 | `curl https://<name>/`（laptop 直连与 probe 隧道） | 200 且 `ssl_verify_result=0`；`openssl s_client` 的 SAN = `p1c.example.com`（`tlsserver` 证书无 CN，属预期） |
| A10 | REALITY 客户端 | probe `curl --socks5-hostname …/api.ipify.org` | 返回 server 公网 IP |
| A11 | 订阅不变 | `p1c_accept.mjs` 检查 5 | 链接参数齐全；sub = links |
| A12 | 强制续期 | `p1c_accept.mjs --renew` + ssh | 新 serial/fingerprint；`current` 切换；nginx reload；**`systemctl show xray -p MainPID` 不变**；`https://<name>/` 仍有效；`cert_synced_at` 前进 |
| A13 | 停 nginx | `systemctl stop nginx` → 等 2 个 poll | `/sync` `nginx_ok=0` + warning `nginx is not healthy: nginx unit is not active`；`cert_synced_at` **不被清空**（0.2.1 的 P1b 遗留修复） |
| A14 | 恢复 | `systemctl start nginx` → 等 2 个 poll | `nginx_ok=1`，`nginx_error=null`，`cert_synced_at` 不变 |
| A15 | lint 负例 | 把 `serverNames` 临时改成 `nope.example.com` 保存 → `/sync` → 改回 | warning `serverNames 'nope.example.com' is not covered by an assigned certificate`；改回后消失 |
| A16 | 重启收敛 | `systemctl restart lessv-agent`、`systemctl restart xray` | 心跳恢复；`applied_hash` 不变；probe 仍能上网 |
| A17 | 30 分钟 | T0/T1 时间戳 | ≤30 分钟（不含 Xray 安装），并记录分解 |

#### 步骤 4：记录

把 A01–A17 的实际输出摘要、T0/T1 时间戳、agent 0.2.1 的 `cert_synced_at` 最终值写进 §8；原始命令输出留在终端记录里，不新建文件。

**完成判据**：A01–A17 全绿；实测 ≤30 分钟；无“靠单测推断”的条目。

---

### P1c.5 清理、发布、归档（约 1 小时）

1. 删除验收夹具（先确认 §6 证据已记录；下面命令需要 `CF_DNS_API_TOKEN`）：
   ```bash
   set -a; . ~/.lessv/cloudflare.env; set +a
   ZONE=00000000000000000000000000000001
   node scripts/linode_provision.mjs delete --token-file ~/.lessv/linode.env --label lessv-server
   node scripts/linode_provision.mjs delete --token-file ~/.lessv/linode.env --label lessv-client
   rm -f ~/.lessv/acceptance/p1c-linode.json
   rm -f ~/.ssh/lessv_p1c_ed25519 ~/.ssh/lessv_p1c_ed25519.pub
   # 删除 DNS A 记录（record id 从列表接口取）
   curl -sS -X DELETE -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
     "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/<record-id>"
   ```
   保留：`~/.lessv/linode.env`、D1 的 `p1c01` 节点行与证书证据、`~/.ssh/config` 块（下次 create 会重写；或手工删掉 `lessv-p1a` 块）。
2. （按 D-D）软删除旧证书域，停止对已死节点的续签：
   ```bash
   curl -sS -X DELETE -H "Authorization: Bearer $ADMIN_KEY" \
     $CP/api/admin/cert-domains/00000000-0000-4000-8000-000000000001
   # 期望 {"deleted":true}；复查 listDomainOuts 里 status=deleted、node_cert_domains 已无该行
   ```
3. 确认源仓库未被修改（记录 HEAD）：
   ```bash
   for d in Lesserv-Cloud Lesserv-Agent ssl-cert-worker; do
     echo "== $d"; git -C ../$d status --porcelain; git -C ../$d log -1 --oneline
   done
   # 期望 clean；HEAD 依次 b6f40b8 / 419f125 / 6a57241
   ```
4. 归档三个源仓库（GitHub web UI → Settings → Archive this repository），记录时间。
5. 更新状态：`PLAN.md` §14 P1c 五项勾选；§8 P1c 状态行改“完成（2026-xx-xx）”；README 当前状态段加 P1c 一行；本文件 §8 写执行记录。

**完成判据**：夹具已删、DNS 已清、源仓库 archived 且 HEAD 未变、PLAN/README/本文件状态已更新。tag 与最终推送在 P1c.6（必须在最后一次提交之后）。

---

### P1c.6 收尾提交与最终回归（约 1 小时）

```bash
npm test                              # 55 files / 387 passed
npm run typecheck
npm --prefix frontend test            # 37 passed（preset 断言改过）
npm run build                         # = wrangler deploy --dry-run；prebuild 会把 dist 换成 stub
npm --prefix frontend run build       # 真实 SPA 构建放最后，避免 dist 留在 stub
python -m pytest -q agent/tests       # 63 passed / 13 skipped（Windows）
git status --porcelain=v1 -uall       # 只应有预期文件
```

提交拆分（建议）：

```bash
git add frontend/src/lib/reality_preset.ts frontend/src/lib/reality_preset.test.ts
git commit -m "P1c: emit the shared BLOCK tag from the REALITY preset"

git add README.md docs/PROTOCOL.md docs/OPERATIONS.md PLAN.md src/models.ts
git commit -m "P1c: correct protocol, operations, and onboarding docs"

git add scripts/p1c_accept.mjs
git commit -m "P1c: add the acceptance smoke script"

git add PLAN.md P1C-PLAN.md README.md
git commit -m "P1c: record fresh-node acceptance and finalize the release"
```

若 P1c 期间改了 `src/` 或 `frontend/src/`（只应有 D13 注释与 D12 preset），必须重新 `npm run deploy` 并重跑 `p1c_accept.mjs`——验收证据只能来自“部署版 = HEAD”的那一刻。

全部提交完成后打 tag 并推送（tag 必须指向最后一次提交）：

```bash
git tag -a v0.1.0 -m "LessV v0.1.0 — REALITY self-steal, ACME, certificates, subscriptions"
git push origin main
git push origin v0.1.0
```

（可选）在 `v0.1.0` release 里再挂一次同一个 agent tarball，方便只找 release 的人。

**完成判据**：全绿；工作树只剩 ignored；`v0.1.0` 指向最后一次提交并已推送。

---

## 6. 证据矩阵（填表用）

| 项 | 命令/来源 | 实际输出（填） | 时间 |
|---|---|---|---|
| T0 / T1 | `date -u +%FT%TZ` | | |
| A01–A11 | `node scripts/p1c_accept.mjs …` | PASS 行 | |
| A06/A07 | `ssh … readlink/stat/nginx -t/is-active` | | |
| A09 | `curl -o /dev/null -w '%{http_code} %{ssl_verify_result}'` | | |
| A10 | probe `curl --socks5-hostname … ipify` | | |
| A12 | 续期前后 serial / fingerprint / MainPID | | |
| A13/A14 | `/sync` 的 `nginx_ok` / `nginx_error` / `cert_synced_at` | | |
| A15 | lint warning 原文 | | |
| A16 | 重启后 `/sync` | | |
| 三十计时分解 | nginx / install / 配置 / 签发×2 / 分配 / 用户订阅 / 探针 | | |

---

## 7. 附录

### 附录 A：`docs/PROTOCOL.md` 的校正正文（可直接粘贴）

**heartbeat**（替换第 63–70 行那一段）：

````markdown
### `POST /api/node/heartbeat`

The 30s poll: cheap hash comparison, rarely a write.

Request (every field but `protocol` is optional; a missing field means
"nothing to report", never a failure):

```json
{
  "protocol": 2,
  "applied_hash": "<sha-256 hex>",
  "applied_at": 1792937643,
  "xray_running": true,
  "xray_pid": 4242,
  "agent_uptime": 3600,
  "last_error": null
}
```

Response: `{ "desired_hash": <hex|null>, "actions": [] }`.

- The plane persists `applied_hash` from the heartbeat at face value when it
  changes (it is the agent's local truth), and never writes `health` or
  `last_error` from a heartbeat. ALWAYS send `applied_hash`: omitting it
  sends `null` and clears the column. The agent always sends it.
- The request's `last_error` is accepted for forward compatibility but not
  stored; the plane keeps the error from the last report.
- The plane never emits actions today. The agent still honors
  `"restart_xray"` if one ever appears (restart Xray unchanged).
- A heartbeat never clears `last_error`; only an apply report does.
````

**report**（替换第 129 行到 `POST /api/node/stats` 之前的整段）：

````markdown
### `POST /api/node/report`

Records one apply attempt; failures keep the old applied hash. Duplicate
reports are safe.

Request (`hash` and `ok` are required):

```json
{
  "protocol": 2,
  "hash": "<sha-256 hex this report is about>",
  "ok": true,
  "stage": "applied",
  "error": null,
  "xray_exit_code": null
}
```

`stage` is one of `fetched`, `test`, `applied`, `started`,
`rolled_back`, `cert`.

- `ok: true` with `stage` `applied` or `started` → `nodes.applied_hash`
  becomes `hash`, `health` becomes `ok`, `last_error` becomes `null`.
- `ok: false` → `health` becomes `error:<stage>` and `last_error`
  becomes `error` (truncated to 500 chars by the agent). `applied_hash`
  does not move.
- Any other stage with `ok: true` (e.g. `test`, `rolled_back`) leaves
  the liveness columns untouched.
- `stage: "cert"` leaves `applied_hash`, `health`, and `last_error`
  untouched in every case — only `last_seen` and the cert columns move.

Certificate fields ride on the same object and are written when present
on a plain report, or whenever `stage` is `cert`:

```json
{
  "stage": "cert",
  "nginx_ok": true,
  "nginx_error": null,
  "cert_etag": "\"0dfcf51c...\"",
  "cert_synced_at": 1792937643
}
```

Absent cert fields stay untouched on a plain report. A `stage:"cert"`
report writes every cert field it carries, NULLs included when the agent
state has nothing to repeat yet. From agent 0.2.1 the agent never clears
`cert_synced_at`: nginx state flips and cert failures repeat the last
successful epoch.
````

**config 409 与错误形状**（替换第 77–79 行；并在文件末尾加一小节）：

````markdown
- `hash` stale → `409 {"detail":{"message":"desired config moved; re-heartbeat","desired_hash":"..."}}`;
  the agent must NOT serve stale bytes as if applied — it re-heartbeats.
````

````markdown
## Error shape

Every 4xx/5xx body is `{ "detail": <string | object | array> }`:

- semantic failures → `{"detail":"node not found"}`;
- schema failures (`parseJsonBody`) → `422 {"detail":[{"msg":"..."}]}`;
- protocol mismatch → `400 {"detail":"unsupported protocol N"}`;
- stale config fetch → `409 {"detail":{"message":"...","desired_hash":"..."}}`;
- an unreadable certificate artifact → `500 {"detail":"<R2 object path>"}`,
  never a partial manifest.
````

**stats**：正文保留，补一句请求体形状 `{"protocol":2,"boot_id":"<string>","counters":{"<name>":<int>}}`，并说明当前只校验不存储。

### 附录 B：方案 A2（平面托管 release）实现清单

仅当 D-A 选 A2 时执行。

1. `PLAN.md` §6.1 表格加一行：`GET /api/admin/agent-release` —— 从 `CERTS` 桶的 `agent/<name>.tar.gz` 流式返回，admin key 保护；`PLAN.md` §8 P1c 任务 4 补一句实现说明。
2. 新文件 `src/routers/admin_agent.ts`：
   - `adminAgent.get("/api/admin/agent-release", …)`；
   - 读 `env.CERTS.get("agent/lessv-agent-<ver>.tar.gz")`（版本从 query 或固定常量；建议 query `?version=0.2.1`，默认最新已知）；
   - 头：`Content-Type: application/gzip`、`Content-Disposition: attachment; filename=…`、`ETag`（R2 的 httpEtag）、`Cache-Control: no-store`；
   - 缺对象 → `404 {"detail":"release not found"}`。
   - 在 `src/main.ts` 里 `app.route("/", adminAgent)`（`/api/admin/*` 的 key 检查与四组守卫自动覆盖）。
3. `scripts/release_agent.mjs`：加 `--upload`，构建后执行
   `npx wrangler r2 object put lessv-certs/agent/<name>.tar.gz --file dist/<name>.tar.gz --remote`
   （先用 `--help` 确认当前 wrangler 4.152 的参数拼写）。
4. `tests/workerd/admin_agent_release.test.ts`：401 无 key、404 空桶、200 头与字节一致（测试环境里 `CERTS` 来自 `wrangler.jsonc`，可直接 `put` 一个对象）。
5. 部署：`npm run deploy`；README 安装段改为
   ```bash
   curl -fsS -H "Authorization: Bearer $ADMIN_KEY" -o lessv-agent.tar.gz "$CP/api/admin/agent-release?version=0.2.1"
   ```
   （注意：admin key 会进 VPS 的 shell 历史；README 要用 `read -rs` 或从 stdin 读，别写进命令历史。）
6. 验收时确认 `curl` 到的是与 `sha256sum` 一致的字节。

### 附录 C：命令速查

```bash
# 平面
CP=https://cp.example.com
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
A() { curl -sS -H "Authorization: Bearer $ADMIN_KEY" "$@"; }

A $CP/api/admin/nodes
A $CP/api/admin/nodes/p1c01/sync
A $CP/api/admin/nodes/p1c01/certs
A $CP/api/admin/cert-domains
A $CP/api/admin/cert-domains/<id>/runs
A $CP/api/admin/cert-domains/<id>/certs

# 节点
ssh lessv-server 'journalctl -u lessv-agent -n 50 --no-pager'
ssh lessv-server 'ls -l /etc/lessv/certs/p1c.example.com/; readlink -f /etc/lessv/certs/p1c.example.com/current'
ssh lessv-server 'systemctl is-active nginx xray; systemctl show xray -p MainPID; ss -lntp | grep -E ":(443|8443)"'
ssh lessv-server 'nginx -t; tail -20 /var/log/nginx/error.log'

# 证书
ssh lessv-server 'openssl x509 -in /etc/lessv/certs/p1c.example.com/current/fullchain.pem -noout -subject -issuer -dates -serial -ext subjectAltName'
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' https://p1c.example.com/
```

### 附录 D：时间估算

| 任务 | 估算 | 不确定性 |
|---|---|---|
| P1c.0 | 0.5 h | 无 |
| P1c.1 | 3–5 h | PROTOCOL 重写 + preset 修复 + 重新部署 |
| P1c.2 | 1 h | 仓库可见性/ release 上传 |
| P1c.3 | 1 h | 脚本与真实数据对齐 |
| P1c.4 | 3–4 h | LE 签发、DNS、第一台真机的 POSIX 路径 |
| P1c.5/6 | 1–2 h | 归档与收尾 |
| **合计** | **1–1.5 个专注日** | 证书链路仍是主要变量 |

---

## 8. 执行记录

（执行时在此追加：决策选择、基线数字、T0/T1、A01–A17 结果、提交 hash、归档时间、遗留问题。）

**决策（P1c.0 步骤 5，2026-10-26）**：用户未改默认值，按默认执行——D-A=A1（GitHub release `realumino/lessv` tag `agent-v0.2.1`）**〔2026-10-26 修订：GitHub 发布通道失效，A1 通道不可用，已切换到 A2——见下方 W1 记录〕**；D-B=B1（新名字 `p1c.example.com`，DNS only）；D-C=C1（第二台 Linode 跑真实 Xray 客户端探针）；D-D=默认（P1c.5 软删除 `tokyo01.example.com` 证书域）；D-E=默认（构建 `scripts/p1c_accept.mjs`）。

**基线（P1c.0，2026-10-26 实测）**：

- 工作树：仅 `?? P1C-PLAN.md`；HEAD `8b0e433`（`P1b: record final status`）；无 remote、无 tag——与 §1.1 一致。
- `npm test`：**55 files / 387 passed**；`npm run typecheck`：OK。
- `npm --prefix frontend test`：**7 files / 37 passed**。
- `python -m pytest -q agent/tests`：**63 passed / 0 failed / 13 skipped**——与 §1.2 全部一致。
- 验收 key：`~/.ssh/lessv_p1c_ed25519`（ed25519，`lessv-p1c`）已生成；`~/.ssh/config` 陈旧块未手改（留给 P1c.4 `linode_provision create` 重写）。
- 冻结规则确认：P1c.1 的代码改动（preset tag、models 注释）随本次部署上线；验收开始后不再改 `src/`、`frontend/src/`、`agent/`。

**P1c.1（2026-10-26 完成）**：

- 代码（D12 + D13）：`frontend/src/lib/reality_preset.ts` 黑洞 outbound tag `"block"`→`"BLOCK"`（`reality_preset.test.ts` 断言同步）；`src/models.ts` 四处注释 protocol 1→2（无行为变化）。
- 验证：frontend **37 passed**（含新断言）；`npm --prefix frontend run build` OK，bundle 含 `tag:\`BLOCK\``；`npm test` **387 passed**；typecheck OK。
- 部署：`npm run deploy`（不带 `--secrets-file`）成功——SPA 构建 → wrangler deploy → `No migrations to apply` → health 200（0.3s）。线上 `/admin` 资产 `index-5OLOrwnN.js` 与本地构建 hash 一致，即已含 BLOCK preset。`/outbounds` 不再出现 `block` 的验证需新节点，待 P1c.4（与计划一致）。
- 文档：
  - README：D1（nginx 前提 + install.sh 硬检查写入首节点流程，计时起点 = 装 nginx）、D2（agent 63/13）、D3（安装改为 curl release → sha256sum -c → 解包；本地构建标注为维护者路径）、D14（`.dev.vars` 括注）；首节点重写为 8 步、命令与 P1c.4 一一对应；拆出「证书」「用户与订阅」「排障」节；新增「已知限制」（含 preset BLOCK 修复说明）；测试矩阵加 P1c 进行中一行。
  - OPERATIONS：D9（issue_runs phase 列表改为实际 13 个，含 `order-expired-<n>`/`cleanup-failed-artifacts`）、D10（内容寻址版本目录 + temp symlink + `os.replace` + 拒绝真目录）、D11（警告措辞改为面板拼接形式并指向 `nginx_error` 字段）、续期判据改为 `nodes.cert_etag` vs `GET /api/node/certs` ETag；新增「What the REALITY preset generates」小节。
  - PROTOCOL：D4/D5（heartbeat/report 请求体按 `HeartbeatIn`/`ReportIn` 重写，含 stage 六值与 SUCCESS_STAGES 语义）、D6（409 嵌套 `detail`）、D7（actions 平面不发、agent 兼容 `restart_xray`）、D8（新增 Error shape 小节）、stats 请求形状；顶部改为“agent 自 0.2.1 起说 protocol 2”。
  - PLAN.md §8 P1c 段末加「进行中」状态行；附录 A 的 `BLOCK` 与代码现一致。
- 1.6 一致性 grep：`models.ts:336-338`（hash/ok/stage）、`node_state_service.ts:20`（SUCCESS_STAGES）、`main.ts:75`（detail 包络）、workflow 13 处 `phase()`、`certs.py:143-192`（0644/0600/0640/os.replace）、`deploy.mjs`（secrets-file/migrations/health）——文档断言逐条对应，无需再改。

**P1c.2（2026-10-26 完成，subagent 执行 + 独立复核）**：

- 审计：230 tracked；sensitive 赋值仅命中 `.dev.vars.example` 两行占位说明（`ADMIN_KEY=base64url-of-32-random-bytes` / `KEY_SECRET=base64-of-32-random-bytes`），非真实密钥；`BEGIN.*PRIVATE KEY` 命中 4 个文件但全部是文档示例/测试桩（`P1B-PLAN.md:597` 的 `"\n..."`、`agent/tests/test_certs.py:41` 的 `"\nkey\n"` fixture、`docs/PROTOCOL.md:144` 的 `"..."`、`tests/cert/workflow_steps.test.ts:128` 的负向断言）——§1.1 对该条的「空」预估不准，实际为占位文本命中，无真实私钥，与 §4 D-A 的判断一致，public 化安全。
- 仓库：**https://gitee.com/realumino/lessv**（public、无 auto_init）；remote `origin` 已加；`git push -u origin main` = `8b0e433a126b6ea21922f42523ae5e328ea01313`（ls-remote 复核一致，脏文件未提交未推送）。
- Tarball：`npm run release:agent` → `dist/lessv-agent-0.2.1.tar.gz`，**24055 bytes**，sha256 **`540a4c4e3a1fcd74199428df60dda4cda2d69dd2f50ec4f3b043dcaba8c37080`**，15 entries 内容校验通过。
- Tag/release：annotated tag `agent-v0.2.1`（对象 `689a32d0` → `8b0e433`）已推；release **id 100000012**，URL https://gitee.com/realumino/lessv/releases/tag/agent-v0.2.1 ，tarball + `.sha256` 两资产均 201 上传。
- 下载验证：匿名 `curl -fsSLO` 两文件 + `sha256sum -c` → OK，下载件 sha256 == 构建值（执行者与复核者各跑一遍一致）。
- 意外与处置：push 曾把 token 内嵌 URL 写入 `.git/config` 的 `branch.main.remote`（GCM 未按预期接管），已用 fetch + `branch --set-upstream-to=origin/main` 修正；复核确认 `.git/config` 无 token、remote URL 干净、branch.main.remote=origin。**遗留：建议 P1c 后轮换该 PAT（深度防御）。**
- 工作树未动：仍为 7 个 M + `?? P1C-PLAN.md` + `?? scripts/p1c_accept.mjs`（并行任务产物）。

**P1c.3（2026-10-26 完成，subagent 执行 + 独立复核）**：

- 新增 `scripts/p1c_accept.mjs`（511 行，无新依赖：`node:fs` + 全局 `fetch`/`AbortSignal.timeout`；只读，唯一写路径 `--renew`；头部注释声明绝不打印 admin key / sub_token / URI / uuid，指纹除外）。`node --check` 通过。
- tokyo01 只读试跑（`--node tokyo01 --user alice --domain tokyo01.example.com --fingerprint ed3205229dfc90a42f2599f20c9a431b8bb57792c87b27f76d6c30c354eaded5`）：**8 passed / 1 failed，exit 1**——唯一 FAIL 即检查 2 的 `cert_synced_at: expected non-null integer, got null`（0.2.1 要修的现象）；检查 1/3/4/5 全 PASS。与 §5 P1c.3 完成判据完全一致。
- 字段级确认（代码事实，P1c.4 依赖）：cert-domains 列表按 `name` 取 `id`；`/cert-domains/:id/certs` 条目用 `is_current` / `environment` / `fingerprint_sha256` / `not_after` / `profile`；节点清单 `NodeCertSummary` **没有** `environment` 字段，staging 排除靠 fingerprint 对比实现；`POST /issue` 响应的 run id 字段是 **`run_id`**，run `status` 为 `queued`/`running` → `succeeded`/`failed`；`/sub/<token>` = `links[].uri` 以 `\n` 连接的 base64（无尾换行）。
- 试跑过程中修了脚本自身一处 bug（URI 含 `#` fragment 时需截取 `?…#` 之间做参数断言），非线上与规格冲突。
- `--renew` 路径未实测（tokyo01 禁止签发），待 P1c.4 首跑。

**W1 / A2（2026-10-26 完成，GitHub 账号封禁应急）**：

- 触发：GitHub 发布通道失效（匿名访问 404），P1c.2 的 A1 通道失效；且本机实测 github.com 匿名下载也超时。此后默认「GitHub 账号不可用」，按 §7 附录 B 落地方案 A2（平面托管 release）。
- 代码：新增 `src/routers/admin_agent.ts`——`GET /api/admin/agent-release`，version 匹配 `^\d+\.\d+\.\d+$`、缺省取 `KNOWN_VERSIONS` 最新；`&sha256` 返回 `.sha256` sidecar（text/plain）；头含 Content-Type/Content-Disposition/ETag(httpEtag)/`Cache-Control: no-store`/Content-Length；对象缺失 → `404 {"detail":"release not found"}`（沿用 ApiError 包络）。`src/main.ts` 以 `app.route("/", adminAgent)` 挂载，adminKey 守卫自动覆盖。
- 测试：`tests/workerd/admin_agent_release.test.ts` 6 例（无/错 key 401、空桶 404、tarball 与 sha256 变体 200+字节一致+头断言）。全量 **56 files / 393 passed**（387+6）；typecheck OK；frontend 37 未受影响。
- 上传：`release_agent.mjs` 加 `--upload`（先 `--help` 核对 wrangler 4.152 语法：`r2 object put lessv-certs/<key> --file=… --content-type=… --remote`）；tarball + `.sha256` 已入 R2 `agent/lessv-agent-0.2.1.tar.gz(.sha256)`。
- 部署：`npm run deploy` 成功（No migrations to apply，health 200）。
- 线上验证（复核者复跑）：无/错 key 401；`?version=9.9.9` → `404 {"detail":"release not found"}`；`?version=0.2.1` 下载件与 `dist/` 字节一致（sha256 `f4405b4c…24d52f`）；`&sha256` 与 dist sidecar 一致；`sha256sum -c` → OK。
- sha256 变化说明：`git archive` tar.gz 内嵌构建时刻 mtime，重建即变 sha（`540a4c4e…`→`f4405b4c…`），未打包内容字节相同。验收一律用「下载件 vs 同批下载的 `.sha256`」自洽校验，**不要硬编码 540a4c4e**。
- 文档：README 安装段改为面板下载（`read -rs ADMIN_KEY` 不进 shell 历史）；README 当前状态加一行 release 通道说明；`P1C-PLAN.md` §5 P1c.4 步骤 3 换成 `printf '%s\n' "$ADMIN_KEY" | ssh lessv-server 'read -rs AK; curl …'`（管道机制已验证）；`PLAN.md` §6.1 加行 + §8 任务 4 注记；OPERATIONS.md 未提 release 通道，未动。
- 工作树新增改动均在白名单内：`?? src/routers/admin_agent.ts`、`?? tests/workerd/admin_agent_release.test.ts`、M `src/main.ts`/`scripts/release_agent.mjs`/README/PLAN。

**P1c.4（2026-10-26 完成，真实 VPS + 新域名全链路）**：

夹具（不计时）：

- Linode：`lessv-server` id 100000004（jp-tyo-3，**203.0.113.12**）、`lessv-client` id 100000005（sg-sin-2，203.0.113.13），均 `g6-nanode-1` + `linode/debian12`，tag `lessv-p1a`；inventory `~/.lessv/acceptance/p1c-linode.json`；`~/.ssh/config` 的 `lessv-p1a` 块由 `linode_provision create` 重写为 `lessv_p1c_ed25519`（陈旧 `203.0.113.10` 块消失）。两台均装 Xray **26.10.21**（`install-release.sh`）。
- 官方 install-release.sh 在裸 Debian 12 上第一步失败：`error: Installation of unzip failed`（脚本先 `apt-get install unzip` 而后才 update）。处置：`apt-get update -qq && apt-get install -y unzip` 后重跑即成功，两台一致。属上游脚本行为，与 LessV 无关。
- DNS：`A p1c.example.com → 203.0.113.12`，`ttl=60`、`proxied=false`，record id `00000000000000000000000000000003`；服务器 `getent hosts` 返回该地址；zone 无 CAA。
- POSIX-only agent 套件：**70 passed / 0 skipped**。`scp -r agent` 会丢 `install.sh` 的 0755（Windows 工作树），且服务器无 git 时 `test_git_mode_is_executable` 抛 `FileNotFoundError`（不是 skip）——因此改用 `git archive HEAD agent | ssh … tar -x`（保留 100755，blob `096b4de6` 与本地一致）+ 服务器 `git init && git add -A && git commit` 后 `python3 -m pytest -q agent/tests --ignore=agent/tests/test_e2e_pull.py`。

计时（README“首节点”8 步，不含 Xray 安装）：**T0 `2026-10-26T14:03:58Z`**（第 1 步 nginx 安装）→ **T1 `2026-10-26T14:08:27Z`**（隧道内 `https://p1c.example.com/` 返回 `200 0`）= **4 分 29 秒**（≤30 分钟）。分解：nginx 5s；建节点+token 7s；release 下载+`sha256sum -c` 6s；agent 安装+enroll 3s；配置 PUT→收敛 38s；建域名+staging 签发 43s；生产签发 40s；分配→节点落盘 3s；装假站点 <1s；建用户+订阅+探针 42s（余额为步骤间的人工/调用间隔）。

矩阵（A01–A17 全部 PASS，均为真实 curl/ssh/openssl/systemctl 输出）：

| # | 实际结果 | 时间（UTC） |
|---|---|---|
| A01 | `p1c_accept` 1a/1b/1c/1d：health 200、无 key 401、错 key 401、正确 key 200 | 14:08:33 |
| A02 | `POST /nodes` 201 → `PUT config` 200 → `/sync` `in_sync=true`、`health=ok`、`applied==desired=e890851b658f…`、`last_error=null`（PUT 后 38s） | 14:05:08 |
| A03 | `test-issue` run `succeeded`（`new-order-1`→`wait-propagation-1`→`key+csr`）；cert 列表 count=1，仅 `staging is_current=true serial=2c7354d8…`，production 仍 null | 14:06:00 |
| A04 | 生产 run `succeeded`；`profile=tlsserver`、`serial=051e76ec6130941b…`、`not_before=13:08:24Z`/`not_after=12-10 13:08:23Z`、**45.000 天**、`sans=["p1c.example.com"]` | 14:06:55 |
| A05 | `/nodes/p1c01/certs` 一条 `profile=tlsserver`、fingerprint `8301823c…` = 节点 `current`（staging 指纹未出现）；`cert_synced_at=1793023631` | 14:07:11 |
| A06 | `current → …/8301823c8c4123c5dcca983e9b2d5579b112ebabda4b333ea9ad679cdb639497`；`644 root:root fullchain.pem`、`600 root:root privkey.pem` | 14:08:47 |
| A07 | `nginx -t` successful；`is-active nginx`=active；journal 显示 14:07:11（证书落盘）与 14:07:37（假站点启用）两次 `Reloaded nginx.service`；监听 `127.0.0.1:8443 nginx` / `*:443 xray` | 14:08:47 |
| A08 | `/sync` `nginx_ok=1`、`nginx_error=null`、`warnings=[]`、`agent_version=0.2.1`、`xray_version=Xray 26.10.21` | 14:08:47 |
| A09 | laptop `200 0`（无 `-k`）；probe 隧道内 `200 0`；`openssl s_client -servername` SAN=`DNS:p1c.example.com`、issuer `CN=YE2`、**subject 为空**（`tlsserver` 无 CN，符合预期） | 14:07:37 / 14:08:27 / 14:08:55 |
| A10 | probe `curl --socks5-hostname …/api.ipify.org` → **203.0.113.12**（= server 公网 IP） | 14:08:19 |
| A11 | `p1c_accept` check 5 两条 PASS：`/sub/<token>` 380 bytes、1 条链接，参数集 = encryption,flow,fp,pbk,security,sid,sni,spx,type；`security=reality`、`sni=p1c.example.com`、`flow=xtls-rprx-vision`、`encryption=none`、`type=tcp` | 14:08:33 |
| A12 | 两次强制续期：①`051e76ec…`/`8301823c…` → `054d43a7…`/`a73a7235…`（`current` 14:09:56 切换、nginx reload、`cert_synced_at` 1793023631→1793023796）；②（脚本修好后）`06261831…`/`adcd411f…`，`current` 14:11:33 切换、`cert_synced_at=1793023893`；**两次 Xray MainPID 恒为 2053**，`https://p1c.example.com/` 续期后仍 `200 0` | 14:09:37 / 14:11:35 |
| A13 | `systemctl stop nginx` → 第二个 poll：`nginx_ok=0`、`nginx_error="nginx unit is not active"`、`warnings=["nginx is not healthy: nginx unit is not active"]`、**`cert_synced_at` 仍为 1793023893**（0.2.1 的“nginx 翻转不清空”生效：`certs.py::_noop_check` 重发上次 epoch） | 14:12:22（二次确认 14:13:02） |
| A14 | `systemctl start nginx` → `nginx_ok=1`、`nginx_error=null`、`warnings=[]`、`in_sync=true`、`cert_synced_at` 不变；probe 仍 203.0.113.12、https `200 0` | 14:13:44 |
| A15 | `serverNames=["nope.example.com"]` 保存 → `warnings=["serverNames 'nope.example.com' is not covered by an assigned certificate"]`；改回 → `warnings=[]`、`applied==desired=e12fe55e…`、probe 恢复正常 | 14:14:15 / 14:15:02 |
| A16 | `restart lessv-agent` 后 `applied=e12fe55e…` 不变、`health=ok`、`cert_synced_at` 不变；`restart xray` 后 `MainPID=2336`、`applied` 仍 `e12fe55e…`、probe `203.0.113.12`、https `200 0` | 14:15:12 / 14:15:55 |
| A17 | 4m29s（见上） | — |

补充证据与发现：

- D12 在新节点上复核：`GET /nodes/p1c01/outbounds` = `[{BLOCK,blackhole},{direct,freedom}]`，无小写 `block`；节点磁盘渲染结果 `outbounds=['BLOCK','p1c01-direct']`、`routing.rules=1`（不再有 `<node>-block`）。`/var/lib/lessv/config.json` 权限 `600 root:root`，`serverNames=['p1c.example.com']`、`dest=127.0.0.1:8443`、`privateKey` 已注入（43 字符）、`shortIds=['d6cbd256']`、1 个 client、`flow=xtls-rprx-vision`。
- 发现并修复 `scripts/p1c_accept.mjs` 的一处竞态：`6c` 在 run `succeeded` 后立即比对节点证书清单，而此时域名 `current` 刚翻转、agent 还没在下一次心跳拉取，导致假 FAIL（首次 `--renew` 12 passed / 1 failed）。改为有界等待（≤4 分钟）直到出现更晚的指纹**且** `cert_synced_at` 前进，并新增 **6d `cert_synced_at advanced`**（A12 要求项，原脚本未断言）；修后 `--renew` 14 passed / 0 failed、exit 0。属验收工具修正，未触及 `src/`、`frontend/src/`、`agent/`，不影响已部署版本。
- 收敛哈希变化说明：`e890851b…`（只有 inbound）→ `e12fe55e…`（建用户 p1cuser 后 clients 增加），A16 的“applied 不变”以 `e12fe55e…` 为基准。
- `cert_synced_at` 最终值 **1793023893**（= 2026-10-26T14:11:33Z，第二次强制续期）；全程演进 1793023465（首启空清单同步）→ 1793023631（首张证书）→ 1793023796 → 1793023893，此后 A13（停 nginx）、A14（恢复）、A15（lint 负例往返）、A16（两次 restart）均未改变它。
- 观察（非本轮修复）：`agent/tests/test_install_assets.py::test_git_mode_is_executable` 在无 git 的机器上抛 `FileNotFoundError` 而不是 skip（`subprocess.run(["git",…])` 未捕获）；建议 P2 加 `except FileNotFoundError: skipTest`。
- 夹具仍在运行（两台 Linode + `p1c.example.com` A 记录），P1c.5 删除；D1 的 `p1c01` 节点行、域名/证书/run 记录保留作证据。

**P1c.5（2026-10-27，夹具清理与证书域收尾；归档受阻）**：

- C2 补充证据：2026-10-27 用户用 **Shadowrocket** 导入 `https://cp.example.com/sub/<token>` 并实际连通（真实客户端，非脚本），A01–A17 之外的第二条独立路径。
- 夹具删除（`2026-10-27T02:33:25Z`）：`linode_provision delete` 删 `lessv-server` 100000004 与 `lessv-client` 100000005；`list` → `no instances tagged lessv-p1a`；`~/.lessv/acceptance/p1c-linode.json`、`~/.ssh/lessv_p1c_ed25519{,.pub}` 已删。`~/.lessv/linode.env` 与 `~/.ssh/config` 的 `lessv-p1a` 块按计划保留（下次 create 重写）。
- DNS：`A p1c.example.com`（id `00000003…`）删除返回 `success=true`，zone 回 12 条记录，无 `p1c` 残留。
- D-D 落地：`DELETE /api/admin/cert-domains/00000000…` → `{"deleted":true}`（`02:33:43Z`）。D1 复核：`tokyo01.example.com` `status=deleted`、`updated_at=2026-10-27T02:33:41.381Z`；`node_cert_domains` 只剩 `p1c01 → 00000002…`；该域三张证书行（production 旧已 purge / production current / staging current）**全部保留**。续期链路复核：`listRenewalCandidates` 的 SQL 带 `WHERE d.status = 'active'`（`src/cert/store/d1.ts:124`），即 cron 不再对死节点续签。
- 计划措辞纠正：§5 P1c.5 步骤 2 期望“复查 listDomainOuts 里 status=deleted”与实际不符——`listDomainOuts` 会 `filter(row.status !== "deleted")`（`src/cert/service.ts:252`），所以软删除后它**不再出现在 API 列表**，只能从 D1 查。上面 D1 查询就是因此做的。
- 源仓库未变且 clean：`Lesserv-Cloud` `b6f40b8`、`Lesserv-Agent` `419f125`、`ssl-cert-worker` `6a57241`，与 §5 期望一致。
- **归档受阻（外部）**：GitHub 发布通道仍不可用（匿名访问 404、`git ls-remote origin` → 403）。因此 P1c.5 步骤 4（归档三个源仓库）与 P1c.6 的 `git push origin main` / `v0.1.0` 推送均无法执行；agent release 已改平面托管（W1/A2），不受影响。

**P1c.6（2026-10-27，收尾回归与本地 tag；推送受阻）**：

- `p1c.example.com` 证书域同按 D-D 软删（`02:54:11Z`）→ `{"deleted":true}`；D1 三个域全部 `status=deleted`（`tokyo01`/`fail`/`p1c`），API active 域 0 条，`node_cert_domains` 空表，证书行均保留。这样两个已死节点都不会被 cron 续签（`listRenewalCandidates` 只选 `status='active'`）。
- 回归（本机，2026-10-27 10:54 +0800）：`npm test` **56 files / 393 passed**；`npm run typecheck` 通过；`npm --prefix frontend test` **7 files / 37 passed**；`python -m pytest -q agent/tests` **63 passed / 0 failed / 13 skipped**；`npm run build`（= `wrangler deploy --dry-run`）6 个资产、1589.21 KiB / gzip 281.24 KiB、Workflow+D1+R2 三个 binding 正常；`npm --prefix frontend run build` 最后跑，产物 `dist/admin/assets/index-5OLOrwnN.js` 与线上已部署资产 hash 一致（即线上 = HEAD 构建）。
- 文档回填：README 当前状态改“P1c 完成（GitHub 通道除外）”并写实测 4m29s、测试矩阵数字 393/56；PLAN §8 P1c 状态行改“完成（GitHub 通道除外）”，§14 P1c 前四项勾选、归档项标注阻塞原因。
- 同时修了一个发布缺口：`.gitignore` 的 `.env*` 把 README 引用的 `.env.production.example` 也忽略了（注释却写着“模板有意提交”），新克隆找不到模板。加 `!.env.production.example` 例外并把模板纳入版本库（内容只有 `base64url-of-32-random-bytes` 等占位值）。
- 提交拆分（本机）：`b5a056e` preset `BLOCK` → `acaca81` 平面托管 agent release（含 6 例 workerd 测试）→ `0e65957` PROTOCOL/OPERATIONS/models 注释校正 → 本提交（验收脚本 + P1C-PLAN + PLAN/README 状态回填 + `.env` 模板 tracked）。
- tag：本地 annotated `v0.1.0` 指向本提交；**未推送**（`git ls-remote origin` → 403 account suspended）。`agent-v0.2.1` 仍只在被封的 GitHub 上，但 release 通道已不依赖它。

**下一步（阻塞项）**：GitHub 发布通道恢复后——`git push origin main && git push origin v0.1.0`、归档 `Lesserv-Cloud`/`Lesserv-Agent`/`certworker` 三个源仓库（均已 clean，HEAD `b6f40b8`/`419f125`/`6a57241`）。可选：把同一个 agent tarball 再挂到 `v0.1.0` release。

---

## 9. 不要做

1. **不要重做 P1b.0–P1b.9**，不要重签 `tokyo01` 的生产证书（LE 限流 5/周，且节点已删）。
2. **不要重建 tokyo01 的 VPS**，也不要改 `PLAN.md` §14 P1b 的既有勾选。
3. **不要轮换 `KEY_SECRET`**（会锁死已封装的 REALITY/证书/ACME 私钥）。
4. **不要用裸 `wrangler deploy`**：`npm run build` 的 prebuild 会把 `frontend/dist` 换成 stub；部署只走 `npm run deploy`（它会先构建真实 SPA）。
5. **不要把 `.env.production`、`.dev.vars`、`wrangler.jsonc`、`dist/`、任何 token/私钥提交或贴进 issue/日志**。push 前跑 P1c.2 的审计。
6. **不要在 `tokyo01` 的域上做测试签发/生产签发**；所有签发只对 `p1c.example.com`。
7. **不要动 `certworker` 遗留 Workflow、`unrelated-jp01` Linode、`cp.example.com` 的 DNS 记录**。
8. **不要改三个源仓库**（不 commit、不 push、不 checkout）；它们只读，最后由 GitHub 归档。
9. **不要在验收开始后改代码**；若必须改，先部署再重跑 §6 全表，并重记 T0/T1。
10. **不要用单测结论替代 A09/A10/A12/A13**：证书和 nginx 的验收只能以真实 `curl`/`openssl`/`systemctl` 输出为准。
