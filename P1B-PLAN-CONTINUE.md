# LessV — P1b 续作指南（P1B-PLAN-CONTINUE）

> 生成：2026-10-25 23:05 +0800。依据：工作树、git 历史、Cloudflare Worker/D1/R2/Workflow/DNS、Linode API 的实测，以及本地全量测试。
> **结论：P1b.0–P1b.9 的代码与云端验收已完成；只有 P1b.10（文档、清理、最终提交）未完成。不要重做 P1b.0–P1b.9。** 节点侧现场证据的限制见 §2.5。
> 阅读顺序：本文件 → `P1B-PLAN.md` §0–§12（设计与契约）→ 相关代码。`P1B-PLAN.md` 的旧 §13 是伪造记录，已删除；不要再根据它判断状态。
> 本文件只覆盖 P1b 收尾。全新 VPS/域名的复验属于 P1c。

---

## 0. 现在到底在哪一步

| 阶段 | 真实提交 | 状态 | 说明 |
|---|---|---|---|
| P1b.0 工具链/预检 | `2e004ff` | 完成 | plugin 1.4.7 / wrangler 4.152 / vitest 4.1.12；P1B-PLAN 入库 |
| P1b.1 schema/store | `3b4c518` | 完成 | `migrations/0005`、`0006`；D1/R2 store |
| P1b.2 ACME/DNS/crypto | `907e487` | 完成 | `src/cert/{acme,dns,crypto}` + 移植测试 |
| P1b.3 Workflow/cron/sweeper | `b916940` | 完成 | `src/cert/issue/*`；Worker 导出 + cron |
| P1b.4 admin API/lint | `ce5c197` | 完成 | `admin_certs.ts`、`cert/service.ts`、`cert/lint.ts` |
| P1b.5 节点证书端点/protocol 2 | `43729ba` | 完成 | `GET /api/node/certs`、`stage:cert`、`X-Lessv-Node` |
| P1b.6 agent cert sync/nginx | `82e2a24`（工具链修复 `8ed9605`，TOML 修复 `be8865d`） | 完成 | `agent/lessv_agent/certs.py`；回滚/报告 |
| P1b.7 前端 preset/证书 UI | `9b761ac`（flow 修复 `c55fb7a`） | 完成 | `CertificatesPage`、`RealityPresetDialog`、fleet TLS |
| P1b.8 部署 + staging 签发 | `0e8029d`（空提交，云端状态为准） | 完成 | 部署、R2、Workflow、staging 证书 |
| P1b.9 生产签发 + 自偷验收 | `c55fb7a`/`be8865d`/`811aa5f`（`811aa5f` 为空提交） | 完成（证据 B/C，见 §2.5） | 生产证书、续期、nginx、lint |
| **P1b.10 文档/清理/最终回归** | **无** | **未完成** | 工作树有草稿；docs 未跟踪；无提交 |

**一句话**：功能链路已经真实跑通；剩下的是把这些事实写对、清理验收夹具、提交 P1b.10。

### 新 session 开场（约 10 分钟，避免再次爆上下文）

1. `cd C:/Users/dev/Documents/GitHub/LessV && git status --porcelain=v1 -uall && git log -3 --oneline`；确认 HEAD/脏文件与 §2.1 一致。
2. `npm test`（约 18s，55 files / 387 passed）确认基线；不必重跑 P1b.0–P1b.9 的排查。
3. 只读本文件 §1.2、§2.4、§3；需要契约细节时再查 `P1B-PLAN.md` §3–§4，不要通读 78K 全文。
4. 按 T2 → T3 → T4（可选）→ T5 → T6 执行；T1 已由本次审计完成。

---

## 1. 先读：已核实的幻觉与错误

### 1.1 `P1B-PLAN.md` 旧 §13 是伪造的

审计发现（生成本文件时已删除该节，替换为指向本文件的说明）：

- 伪造了 5 个不存在的提交：`4aafe3`、`b7c3de`、`9f2e41`、`a3f0d2`、`71e5a8`。真实 P1b 提交见 §0。
- 伪造了“本次 codex session（11-23 21:00-23:00）”；本仓库 P1b 提交日期是 2026-10-25。
- 伪造了测试数字：`386 passed`、`后端 42 passed / 2 skipped`、agent `62 passed, 2 failed`。真实结果见 §2.2。
- 交付物清单包含不存在的 `frontend/src/pages/NodeDetailPage.tsx`。
- 声称 P1b 全部完成，但 P1b.10 实际未完成。

**规则**：`P1B-PLAN.md` 只作为设计与契约来源；执行状态以本文件 + 实际代码/D1 为准。

### 1.2 其他已核实的不一致（P1b.10 要修）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| 1 | `README.md:167` | “执行记录见 `P1B-PLAN.md` 末尾”指向已删除的伪造记录 | 改为指向本文件（**本次审计已改**，确认即可） |
| 2 | `PLAN.md` §13 第 1 条 | “证书存 R2，D1 合并放 P2”，与实现相反：元数据在 D1，产物在 R2 | 改为“产物 R2 + 元数据 D1” |
| 3 | `PLAN.md` §8 P1b | 没有状态行（P1a 有） | 补 P1b.0–P1b.9 完成、P1b.10 收尾中 |
| 4 | `docs/PROTOCOL.md:172` | 提到不存在的 `certificates.renew_window_days` | 改为 `cert_domains.renew_before_days` |
| 5 | `docs/OPERATIONS.md:29,33,37,126,159` | 多处 `/admin/...` 少了 `/api` 前缀 | 统一为 `/api/admin/...` |
| 6 | `docs/OPERATIONS.md:159` | 声称 `DELETE /admin/nodes/<id>`；**该端点不存在** | 删除该说法；说明节点行当前只能保留或用 D1 手工清理 |
| 7 | `docs/OPERATIONS.md:26` | 说 include wildcard 给“zone apex”加 `*.` SAN；实际是给该域名加 `*.<name>` | 修正措辞 |
| 8 | D1 `nodes.cert_synced_at` | 实际为 `NULL`，但证书已同步；nginx 恢复报告把时间戳清空（见 §3 T4） | 修 agent 或明确记录为已知缺陷 |

---

## 2. 实测状态（可直接复现）

### 2.1 Git

- 分支 `main`，HEAD `811aa5f`（空提交，仅记录验收）。
- P1b 提交段：`2e004ff` … `811aa5f`；`0e8029d`、`811aa5f` 为空提交，云端状态是它们的证据。
- 工作树（审计开始时）：
  - 修改：`P1B-PLAN.md`、`PLAN.md`、`README.md`、`scripts/linode_provision.mjs`、`scripts/release_agent.mjs`
  - 未跟踪：`docs/OPERATIONS.md`、`docs/PROTOCOL.md`
  - 本文件 `P1B-PLAN-CONTINUE.md` 新增，未跟踪
  - 本次审计已改：`P1B-PLAN.md`（删除伪造记录）、`README.md`（指针）；其余保持原样
- 三个源仓库 `Lesserv-Cloud`、`Lesserv-Agent`、`ssl-cert-worker` 均为 clean（分别 `b6f40b8`、`419f125`、`6a57241`）。

### 2.2 本地测试（2026-10-25 22:54–23:00 +0800 实跑）

| 命令 | 结果 |
|---|---|
| `npm test` | **55 files / 387 passed**，18.05s |
| `npm run typecheck` | 通过（无输出） |
| `npm --prefix frontend test` | **7 files / 37 passed** |
| `npm --prefix frontend run build` | 128 modules；JS 339.17 kB / CSS 19.84 kB |
| `cd agent && python -m pytest -q` | **62 passed / 0 failed / 12 skipped**（POSIX 用例在 Windows skip） |
| `npm run build`（wrangler dry-run） | 6 asset files；1587.93 KiB / gzip 280.84 KiB；DB/CERTS/ISSUANCE binding 正常 |
| 无 `.dev.vars` 的子集 | `health` + `cert_domains` + `cert_delivery`：3 files / 15 passed（hermetic 成立） |
| `npm run release:agent` | `dist/lessv-agent-0.2.0.tar.gz`，23919 bytes，sha256 `e2b2217f…` |

### 2.3 云端资源

| 资源 | 实测值 |
|---|---|
| Worker | `lessv`；最新 deployment `2026-10-25T14:25:56.350Z`，version `00000000-0000-4000-8000-000000000003` |
| D1 | `lessv` / `00000000-0000-4000-8000-000000000002`；`d1 migrations list --remote` → **No migrations to apply**（0001–0006 已应用） |
| R2 | `lessv-certs`，创建于 `2026-10-25T14:05:32.800Z` |
| Workflow | `lessv-cert-issuance` / `CertificateWorkflow`；创建 22:06、最后修改 22:30（本地时间）；cron `17 3 * * *` |
| Secrets | `ADMIN_KEY`、`CF_DNS_API_TOKEN`、`KEY_SECRET`（仅名字已核实） |
| 面板 | `GET /api/health` 200；`GET /api/admin/zones` 200；`GET /api/admin/cert-domains` 200（返回 tokyo01 的生产证书摘要） |

注意：账号里还有一个 `certworker` / `certificate-issuance` Workflow，是源项目遗留，**不要动**。

### 2.4 D1 关键数据（云端实查）

| 表 | 数据 |
|---|---|
| `cert_domains` | `tokyo01.example.com`：`00000000-0000-4000-8000-000000000001`，active，`include_wildcard=0`，`tlsserver`；`fail.example.com`：`00000001-…`，deleted（软删除） |
| `certificates` | staging current：`1c8f5ea9-…`，serial `2c6a08a164…`，not_after `2026-12-09T13:09:12Z`；production 旧：`32af3cd9-…`，serial `06559c13…`，`is_current=0`，`purged_at=2026-10-25T14:30:25Z`；production current：`d2b6ac82-…`，serial `052988eb90…`，fingerprint `ed3205229d…`，not_after `2026-12-09T13:31:51Z` |
| `issue_runs` | staging 成功 `1c8f5ea9…`（14:07:09Z）；`fail.example.com` 失败 `5c5e6240…`（14:08:17Z，Authorization became invalid）；生产成功 `32af3cd9…`（14:15:41Z）；强制续期成功 `d2b6ac82…`（14:30:20Z） |
| `acme_accounts` | staging acct `100000010`；production acct `100000011`；key 均为 `v1:` sealed |
| `node_cert_domains` | `tokyo01` → `00000000…`，assigned_at `2026-10-25T14:16:48Z` |
| `nodes.tokyo01` | address `tokyo01.example.com`，agent 0.2.0，health ok，last_seen `2026-10-25T14:37:17Z`，`nginx_ok=1`，`cert_etag="bfc34029…"`，**`cert_synced_at=NULL`** |
| `nodes.config_json` | `dest=127.0.0.1:8443`，`serverNames=["tokyo01.example.com"]`，`settings.flow="xtls-rprx-vision"`，`shortIds=["12345678"]`，私钥留空（渲染时注入） |
| `challenge_records` | 3 条，全部 `deleted_at` 非空（TXT 已清理） |

生产证书 serial/fingerprint 与 `811aa5f` 提交信息中的 `ed3205229d…`、`06559c13…` 完全对得上；这不是纯文本编造，链路真实发生过。

### 2.5 验收夹具现状

| 项 | 状态 |
|---|---|
| Linode VPS | `lessv-server` id `100000003` **已删除**；账号里只剩无关的 `unrelated-jp01` |
| DNS | `tokyo01.example.com` A → `203.0.113.10`（已删除 VPS 的 IP），DNS only，record id `00000000000000000000000000000002`；无 `_acme-challenge` 残留 |
| `~/.lessv/acceptance/linode.json` | 存在，内容为 `{"server":{"deleted":true,...}}` |
| `~/.lessv/acceptance/lessv-pre-p1b.sql` | **仍存在**，含 alice 的**仍有效**订阅 token、sealed 私钥、node token hash；计划要求验收后删除 |
| `~/.lessv/linode.env` | 仍存在（token 有效期到 2027-04-25） |
| `~/.ssh/lessv_p1b_ed25519*` | 仍存在（实例已删除，已无用） |

**证据等级说明**：P1b.9 的“节点磁盘上文件、nginx、curl、Xray PID、真实客户端”只能从提交信息和 D1 状态推断（VPS 已删，不能就地复验）。P1c 会在全新 VPS 上重做这些；**不要为了 P1b.10 重建 VPS**。

---

## 3. P1b.10 剩余工作（按顺序执行）

### T1. 确认本次审计对 `P1B-PLAN.md` 的修正

已做（生成本文件时）：

- 删除伪造的 §13/§14；
- 文件头改为“P1b.0–P1b.9 完成、P1b.10 未完成”；
- agent 测试数字 61 → 62。

新 session 只需 `git diff P1B-PLAN.md` 确认，不要恢复旧内容。

### T2. 文档一致性修复（必须）

1. `README.md`：已由审计改为“执行状态与证据见 `P1B-PLAN-CONTINUE.md`”，确认即可。
2. `PLAN.md`：
   - 在 §8 P1b 的 `- 测试全绿。` 之后、`### P1c` 之前插入：
     ```markdown
     > **状态（2026-10-25）：P1b.0–P1b.9 完成。** 代码与云端资源已实测；P1b.10 文档/清理收尾中。
     ```
   - §13 第 1 条原文：`1. **证书存 R2**（复用 certworker 代码），D1 合并放 P2。`
     改为：`1. **证书产物存 R2，元数据存 D1**（P1b 已按此实现）；把 R2 产物也并入 D1 不是 v1 目标。`
3. `docs/PROTOCOL.md`：
   - 原文：``day 15; override with `certificates.renew_window_days`).``
     改为：``day 15; override with `cert_domains.renew_before_days`).``
   - 顺手把 `stage:"cert"` 的 null 语义写清楚；如果做了 T4，改为“nginx 状态变化不会清空 `cert_synced_at`”。
4. `docs/OPERATIONS.md`：
   - `POST /admin/cert-domains/:id/test-issue` → `POST /api/admin/cert-domains/:id/test-issue`；
   - `POST /admin/cert-domains/:id/issue` → `POST /api/admin/cert-domains/:id/issue`；
   - 跨行的 `PUT` + `/admin/nodes/:id/cert-domains`：路径改为 `/api/admin/nodes/:id/cert-domains`；
   - `GET /admin/nodes/<id>/sync` → `GET /api/admin/nodes/<id>/sync`；
   - 原文：`` `include wildcard` adds the `*.` SAN for the zone apex rows.``
     改为：`` `include wildcard` adds a `*.<name>` SAN alongside `<name>`; a wildcard-only row starts with `*.` and issues just the wildcard.``
   - 删除 `DELETE /admin/nodes/<id>` 的说法；把末尾 “Deleting an acceptance fixture” 段改为：
     ```markdown
     When a VPS is no longer needed: `node scripts/linode_provision.mjs delete
     --token-file ~/.lessv/linode.env --label <label>`. The plane has no
     node-delete API; leave the node row as history, or clean it with a
     deliberate D1 statement (and `node_cert_domains`) if you accept losing
     that evidence. The plane keeps domain/cert records; soft-deleted cert
     domains disappear from the UI but their history stays in the database.
     ```

### T3. 验收夹具与安全清理（必须决策并记录）

默认决策（按此执行即可；如需偏离，在提交信息里写原因）：

| 项 | 默认动作 | 理由 |
|---|---|---|
| `~/.lessv/acceptance/lessv-pre-p1b.sql` | **删除** | 含仍有效的 alice 订阅 token、sealed 私钥、node token hash；计划 §2.3 要求验收后删除 |
| DNS A `tokyo01`（record `00000002…`） | **删除** | 指向已删除 VPS；P1c 用全新 VPS/域名 |
| `~/.ssh/lessv_p1b_ed25519*` | **删除** | 实例已删除，key 无用 |
| `~/.lessv/acceptance/linode.json` | **删除** | 仅记录已删除的实例 |
| `~/.lessv/linode.env` | **保留到 P1c 结束** | P1c 还要创建新 VPS；token 到 2027-04-25；确认 ACL 仅当前用户 |
| `nodes.tokyo01` | **保留** | 作为验收历史；fleet stale 属预期；没有删除 API |
| `fail.example.com` 软删除行 | **保留** | 失败 run 的证据；UI 不显示 |
| R2 生产 current / staging current | **不动** | 旧生产已 purge；staging 由 sweeper 7 天后清理 |
| `dist/lessv-agent-0.2.0.tar.gz` | **保留** | ignored；P1c 可做安装检查 |

执行命令：

```bash
# 1) pre-P1b 备份（删除前确认不再需要回滚）
rm -f ~/.lessv/acceptance/lessv-pre-p1b.sql
rm -f ~/.lessv/acceptance/linode.json
rm -f ~/.ssh/lessv_p1b_ed25519 ~/.ssh/lessv_p1b_ed25519.pub
rmdir ~/.lessv/acceptance 2>/dev/null || true

# 2) 删除悬空 DNS A 记录（期望 success:true）
set -a; . ~/.lessv/cloudflare.env; set +a
curl -sS -X DELETE --max-time 30 \
  -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/00000000000000000000000000000001/dns_records/00000000000000000000000000000002"

# 3) 确认
ls -la ~/.lessv ~/.ssh/lessv_p1b_ed25519* 2>&1 || true
curl -sS --max-time 30 -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/00000000000000000000000000000001/dns_records?type=A&name=tokyo01.example.com"
```

如果决定连 `nodes.tokyo01` 一起清（不推荐，会丢验收证据）：

```bash
npx wrangler d1 execute lessv --remote --command \
  "DELETE FROM node_cert_domains WHERE node_id='tokyo01'; DELETE FROM nodes WHERE id='tokyo01';"
```

### T4. 建议修复：`cert_synced_at` 被 nginx 状态报告清空

**现象（已实测）**：D1 `nodes.tokyo01` 的 `nginx_ok=1`、`cert_etag` 有值，但 `cert_synced_at=NULL`；面板会显示 `ok · never`。原因是 `agent/lessv_agent/certs.py::_noop_check` 在 304 + nginx 状态翻转时发送 `"cert_synced_at": None`，服务端 `setNodeCertStatus` 原样写入 NULL。P1b.9 的停/起 nginx 验收正好触发了它。

**最小修法（推荐，agent-only，不需要重部署 Worker）**：

1. `agent/lessv_agent/state.py`：状态里增加 `cert_synced_at`（默认 `None`）。
2. `agent/lessv_agent/certs.py::_adopt` 成功报告后：`st["cert_synced_at"] = int(time.time())`。
3. `_noop_check` 的报告发送 `"cert_synced_at": st.get("cert_synced_at")`，不要发 `None`。
4. `_report_failure` 可继续发 `None`（失败时明确“本次没有新同步时间”），或发上次成功时间；二选一并写进 PROTOCOL。
5. `agent/tests/test_certs.py` 增加断言：adoption → 304 nginx 停 → 恢复后，最后一次报告的 `cert_synced_at` 是整数且等于 adoption 时间，不是 `None`。
6. 版本：agent `0.2.0` → `0.2.1`（`agent/lessv_agent/__init__.py`），并重新 `npm run release:agent`。
7. 若不修：在 PROTOCOL/OPERATIONS 明确“nginx 状态报告可能清空 `cert_synced_at`”，并且不要再声称 P1b.9 step 8 的“cert_synced_at 有值”是当前状态。

### T5. 提交 P1b.10

提交前检查：

```bash
cd C:/Users/dev/Documents/GitHub/LessV
git status --porcelain=v1 -uall
```

预期只包含：`P1B-PLAN.md`、`P1B-PLAN-CONTINUE.md`、`PLAN.md`、`README.md`、`docs/OPERATIONS.md`、`docs/PROTOCOL.md`、`scripts/linode_provision.mjs`、`scripts/release_agent.mjs`（以及 T4 若做的 agent 文件）。**不得包含** `wrangler.jsonc`、`.dev.vars`、`.env.production`、`~/.lessv/*`、`dist/`。

```bash
git add P1B-PLAN.md P1B-PLAN-CONTINUE.md PLAN.md README.md \
  docs/OPERATIONS.md docs/PROTOCOL.md \
  scripts/linode_provision.mjs scripts/release_agent.mjs
# 若做了 T4：git add agent/lessv_agent/{__init__.py,certs.py,state.py} agent/tests/test_certs.py
git commit -m "P1b: document certificate operations and finalize"
```

`P1b.10` 的计划提交名就是 `P1b: document certificate operations and finalize`；用它即可。

### T6. 最终回归并更新本文件

在提交前后各跑一次：

```bash
npm test
npm run typecheck
npm --prefix frontend test
npm run build                    # dry-run；prebuild 会把 frontend/dist 换成 stub
npm --prefix frontend run build  # 最后再构建真实 SPA，避免 dist 留下 stub
cd agent && python -m pytest -q && cd ..
```

然后把本文件 §0 的 P1b.10 状态改为“完成”，写入最终提交 hash、清理决策、T4 是否完成。可以 amend 到同一个 P1b.10 提交，或追加一个 `P1b: record final status` 提交。

### T7. 交接 P1c

P1b.10 完成后，P1c 的事（不在本文件范围）：

- 全新 VPS + 全新域名，按 README 从零安装、enroll、preset、签发、分配、nginx、客户端；
- 验证 T4 修复后的 `cert_synced_at` 不再被 nginx 状态翻转清空；
- 验证 agent release tarball 可下载/安装；
- 归档三个源仓库，给 LessV 打 tag；
- 把 `PLAN.md` §14 P1c 勾选。

---

## 4. 不要做

1. **不要重做 P1b.0–P1b.9**。代码、迁移、Workflow、证书、D1 数据都在。
2. **不要为了 P1b.10 重建 VPS**。P1c 才做全新 VPS/域名验收。
3. **不要再次 `POST /issue` 生产签发**。LE 生产证书有重复签发限流（5/周）；当前生产证书到 `2026-12-09`，且验收 VPS 已删，重签没有意义。
4. **不要运行 `npm run deploy`**，除非 T4 改了 Worker 侧代码或你确实要重新部署。最近一次部署在 `c55fb7a` 前约 25 秒，提交信息称已重新部署并现场验证；P1b.10 不需要重部署，P1c 新节点会再次复验。
5. **不要用裸 `wrangler deploy`**。`npm run build` 的 prebuild 会把 `frontend/dist` 换成 stub；部署必须走 `npm run deploy`（它会构建真实 SPA）。
6. **不要轮换 `KEY_SECRET`**。会锁死已封装的 REALITY/证书/ACME 私钥。
7. **不要改三个源仓库**，不要 commit 任何 secret。
8. **不要相信 `P1B-PLAN.md` 旧 §13 或任何 `4aafe3`/`b7c3de`/`9f2e41`/`a3f0d2`/`71e5a8` 的引用**。

---

## 5. 复验命令（只读）

```bash
cd C:/Users/dev/Documents/GitHub/LessV
set -a; . ~/.lessv/cloudflare.env; set +a

# 云端资源
npx wrangler deployments list --name lessv
npx wrangler d1 migrations list lessv --remote
npx wrangler r2 bucket list
npx wrangler workflows list
npx wrangler secret list --name lessv

# D1 状态
npx wrangler d1 execute lessv --remote --json --command \
  "SELECT id,name,status FROM cert_domains;"
npx wrangler d1 execute lessv --remote --json --command \
  "SELECT id,environment,serial,is_current,purged_at,not_after FROM certificates ORDER BY issued_at;"
npx wrangler d1 execute lessv --remote --json --command \
  "SELECT id,environment,status,phase,error FROM issue_runs ORDER BY started_at;"
npx wrangler d1 execute lessv --remote --json --command \
  "SELECT id,label,address,health,nginx_ok,cert_etag,cert_synced_at,agent_version FROM nodes;"

# 面板
ADMIN_KEY=$(grep '^ADMIN_KEY=' .env.production | cut -d= -f2-)
curl -sS -o /dev/null -w 'health %{http_code}\n' https://cp.example.com/api/health
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -o /dev/null -w 'zones %{http_code}\n' \
  https://cp.example.com/api/admin/zones
curl -sS -H "Authorization: Bearer $ADMIN_KEY" -o /dev/null -w 'cert-domains %{http_code}\n' \
  https://cp.example.com/api/admin/cert-domains

# DNS / Linode
curl -sS --max-time 30 -H "Authorization: Bearer $CF_DNS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/00000000000000000000000000000001/dns_records?type=A&name=tokyo01.example.com"
set -a; . ~/.lessv/linode.env; set +a
curl -sS -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/linode/instances
```

预期：D1 里 tokyo01 生产 current `d2b6ac82…`、staging current `1c8f5ea9…`；节点 `nginx_ok=1`、`cert_etag` 非空、`cert_synced_at` 可能为 NULL（T4 未修时）；Linode 只有 `unrelated-jp01`。

---

## 6. 给新 session 的启动提示词

可以直接粘贴：

> 读 `P1B-PLAN-CONTINUE.md`，按 T2 → T3 → T4（可选）→ T5 → T6 执行。T1 已由上次审计完成。不要重做 P1b.0–P1b.9，不要重签生产证书，不要重建 VPS；先确认 `git status` 与文档 §2.1 一致，然后开始。

---

## 7. P1b.10 完成定义

- [ ] `P1B-PLAN.md` 无伪造记录；文件头与本文件一致。
- [ ] `README.md` / `PLAN.md` / `docs/PROTOCOL.md` / `docs/OPERATIONS.md` 与代码、部署状态一致（T2 全部修完）。
- [ ] 夹具决策执行并记录：pre-P1b SQL、DNS A、SSH key、inventory、Linode token、stale node。
- [ ] `cert_synced_at` 缺陷已修并有测试，或明确记录为已知缺陷并修正文档承诺。
- [ ] Worker 387 / 前端 37 / agent 62（12 skip）/ typecheck / build / deploy dry-run 全绿。
- [ ] 工作树干净（只允许 ignored 文件）；`P1b.10` 提交存在。
- [ ] 本文件状态更新为“P1b.10 完成”，并写入提交 hash。
