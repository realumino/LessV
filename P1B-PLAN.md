# LessV — P1b 执行计划

> 状态：**P1b.0–P1b.9 已完成；P1b.10 未完成**（2026-10-25 审计）。执行状态、可复现证据与剩余工作见 `P1B-PLAN-CONTINUE.md`。
> 验收：P1b 的代码与云端资源已实测；节点侧验收（nginx/curl/Xray PID）依赖已删除的验收 VPS，不能就地复验。测试基线 `npm test` 387 passed / 55 files、前端 37 passed / 7 files、agent 62 passed / 12 skipped（POSIX 专属用例在 Windows skip）。
> 执行边界：REALITY preset（自偷）+ ACME DNS-01 + 测试签发 + 证书投递 + nginx reload + cert lint。不引入 B 拓扑、Clash、审计、revoke UI、面板托管 nginx 配置。

---

## 0. 目标与完成标准

**目标（PLAN.md §14 P1b）**

1. 前端 REALITY preset 生成 `dest=127.0.0.1:8443` 的自偷配置；保存后走现有渲染/密钥/链接管线。
2. D1 新增 `cert_domains`、`certificates`、`acme_accounts`、`issue_runs`、`challenge_records`、`node_cert_domains`；`nodes` 新增 `nginx_ok`/`nginx_error`/`cert_etag`/`cert_synced_at`。
3. 移植 ssl-cert-worker 的 ACME/DNS-01/CSR/证书解析/Workflow/R2；账户 key 改存 D1（`KEY_SECRET` 封装），不再使用 R2 `acme/<env>/`。
4. 目录常量 + environment 维度；staging/production 账户、current 证书、run 完全隔离；`test-issue` 只翻 staging current。
5. `tlsserver` profile；`newOrder` 带 `profile` 并校验 `directory.meta.profiles`；按实际寿命 1/3 续期；order/authz 过期重开（有上限）。
6. 证书管理页：zone、域名 CRUD、生产签发、测试签发、runs、证书列表/下载、节点分配、到期显示。
7. 节点证书端点 + agent 证书同步 + `nginx -t`/reload/回滚 + 报告；`agent.toml` 新增 nginx 字段；`state.json` 新增 `cert_etag`。
8. cert lint 接入 sync；fleet 显示证书到期/nginx 状态。
9. 真实域名 + LE 生产证书 + nginx 自偷替换 P1a 的临时公网 dest。
10. 测试：ACME mock、staging/prod 隔离、测试证书不投递、节点隔离、agent 回滚、E2E。
11. 文档：PROTOCOL v2、OPERATIONS（nginx/证书/排障）、README 更新。

**完成标准**

严格对应 `PLAN.md` §14 P1b 的 10 项；最后以真实 VPS、真实域名、真实 nginx/Xray、真实客户端为准，不以单测为准。

---

## 0.1 就绪检查（2026-10-25 实测）

| 项 | 结果 | 影响 |
|---|---|---|
| 本机基线 | Worker 242/32 files；前端 27；agent 54 passed + 1 skipped | P1b 可以在绿色基线上开始 |
| 测试 hermetic | 把 `.dev.vars` 临时移走后，`health`/`admin_auth` 仍绿；wrangler 只警告缺 secret | 测试不依赖本地 secret；P1b 增加 `CF_DNS_API_TOKEN` 测试默认值即可 |
| Cloudflare 账号 | `example-account` / `00000000000000000000000000000000` | 已验证 |
| Zone | `example.com`，ID `00000000000000000000000000000001`，status `active` | 证书域名可用 |
| 已部署 Worker | `lessv`，有 deployment 记录 | P1b 是增量部署，不是首部署 |
| 远程 D1 | `lessv` / `00000000-0000-4000-8000-000000000002`；已有表 `nodes/users/user_node_access/reality_keys/link_profiles`；`d1_migrations` 0001–0004 | 0005/0006 必须增量迁移，不能重建 |
| Cloudflare token | `d1 execute --remote`、`workflows list`、`r2 bucket list` 均可用；临时 bucket create/delete 成功 | **R2 权限已就绪**；`lessv-certs` 尚未创建 |
| 当前 `wrangler.jsonc` | 有 route `cp.example.com`，但**没有 `database_id`**；文件 gitignored，且只在缺失时从 example 复制 | P1b 必须手动写入 D1 id、R2、Workflow、cron |
| 当前 secrets | 线上只有 `ADMIN_KEY`/`KEY_SECRET`；本地 `~/.lessv/cloudflare.env` 已有 `CLOUDFLARE_API_TOKEN` + `CF_DNS_API_TOKEN`（均 53 字符，verify active） | P1b 部署时把 `CF_DNS_API_TOKEN` 加入 Worker secrets |
| DNS token | `CF_DNS_API_TOKEN` 可读 `example.com`，临时 TXT create/delete 成功 | ACME DNS-01 权限已就绪 |
| P1a VPS | **server 已销毁**；无 SSH；新建 VPS 尚未创建 | P1b.9 创建 |
| Linode token | `~/.lessv/linode.env` 已存在（64 chars，ACL owner-only）；scopes `account:read_only images:read_only linodes:read_write`；expiry 2027-04-25；`/account`、`/instances`、`/images/linode/debian12` 均 200 | **就绪**；可创建 VPS |
| Linode 账户 | 现有 1 台无关实例 `unrelated-jp01`（jp-tyo-3, g6-nanode-1, running）；`jp-tyo-3` 的 `g6-nanode-1` availability=true | 可新建 `lessv-server` |
| certworker 测试工具链 | certworker 用 `@cloudflare/vitest-plugin@1.3.3` + `wrangler@4.144.0`；LessV 用 1.1.13 + 4.135.0；LessV 的 plugin **没有** `introspectWorkflowInstance` | 必须先升级工具链，否则 Workflow 测试无法移植 |
| certworker ACME client | `newOrder()` **没有 profile 参数**；`AcmeOrder` 没有 `profile` 字段；目录解析有 `meta` 但未使用 | P1b 必须自己补 profile 支持 |
| certworker 账户存储 | 账户元数据 + 私钥都在 R2 `acme/<env>/`；证书私钥用 `ENVELOPE_KEY` + AAD | 必须改成 D1 sealed + LessV `key_cipher` |
| certworker User-Agent | `certworker/0.1` | 改为 `lessv/0.1` |
| LessV 路由守卫 | 只允许 `/api/admin/`、`/api/node/`、`/sub/`、`/api/health` | `PLAN.md` §6.1 的 `GET /api/zones` 会 404，必须改为 `/api/admin/zones` |
| LessV 现有加密 | `key_cipher.seal/unseal` 是 `v1:<base64(iv||ct+tag)>`，无 AAD；`KEY_SECRET` 是标准 base64 32 字节 | 证书私钥/ACME account key 统一复用；不引入 `ENVELOPE_KEY` |
| LessV agent 现状 | protocol 1；头 `X-Lesserv-Node`；无 cert sync；`agent.toml` 无 nginx 字段 | P1b 要升 protocol 2、改头、加 cert sync |
| 源仓库 | Lesserv-Cloud / Lesserv-Agent / ssl-cert-worker 均 clean | 只读复制，不修改 |
| `jose` | 只在 certworker 的 Access 代码中使用；ACME 全部是 WebCrypto | **不引入 `jose`** |

结论：**可行。** 代码工作可以立即开始；云上 staging/生产验收只剩“用 token 创建一台 VPS + 创建 `tokyo01` A 记录”，无其他外部输入。

---

## 0.2 执行参数（建议值，待确认）

| 参数 | 值 | 说明 |
|---|---|---|
| 面板主机 | `cp.example.com` | 已部署 |
| 节点 id / label | `tokyo01` / `Tokyo` | 沿用 P1a |
| 节点域名（`nodes.address`、REALITY `serverNames[0]`、nginx `server_name`） | `tokyo01.example.com` | **DNS only（灰云）**，A 记录指向节点公网 IPv4；不能走 Cloudflare 代理 |
| 证书域名 | `tokyo01.example.com` | `include_wildcard=false`；SAN 精确覆盖 serverName；多节点再考虑 `*.example.com` |
| nginx | 监听 `127.0.0.1:8443`；假站点 `/var/www/lessv-decoy` | 只被 REALITY `dest` 访问 |
| ACME profile | 默认 `tlsserver`；单域名可切 `classic` | `shortlived` 不进 UI |
| R2 bucket | `lessv-certs` | 新建；binding `CERTS` |
| Workflow | `lessv-cert-issuance` / binding `ISSUANCE` / class `CertificateWorkflow` | 与 certworker 的 `certificate-issuance` 不冲突 |
| Cron | `17 3 * * *` | 只跑 production |
| VPS | **新建一台** Linode Debian 12；client 探针用本地 Xray | 不再复用 P1a；需要 Linode token |
| Agent 版本 | `0.2.0`，protocol 2 | 根 `/usr/local/lib/lessv-agent` |
| 测试用户 | 沿用 `alice` 或新建 | 订阅不变 |
| 客户端探针 | 本地 Xray 客户端或新 VPS | `scripts/subscription_to_xray.mjs` 可复用 |

---

## 1. 调研结论

### 1.1 已验证（会改变执行方式）

| # | 事实 | 验证方式 | 影响 |
|---|---|---|---|
| V1 | P0/P1a 测试基线绿色（242/27/54+1skip） | 本机重跑 | 可以开始 |
| V2 | 远程 D1 已有 0001–0004 和线上数据 | `wrangler d1 execute lessv --remote` | 只做增量迁移；迁移前导出备份 |
| V3 | 更新后的 Cloudflare token 已有 R2 权限；临时 bucket create/delete 成功 | `wrangler r2 bucket list/create/delete` | 可创建 `lessv-certs` |
| V4 | LessV 的 `@cloudflare/vitest-plugin@1.1.13` 不含 `introspectWorkflowInstance` | 读 `node_modules/@cloudflare/vitest-plugin` | 先升级到 1.3.3（与 certworker 一致） |
| V5 | certworker `AcmeClient.newOrder` 不接受 profile；`AcmeDirectory.meta` 已解析但未使用 | 读 `src/acme/client.ts` | 必须自行实现 profile 校验和请求字段 |
| V6 | certworker 的账户 key 在 R2，证书 key 用 `ENVELOPE_KEY`/AAD | 读 `src/issue/steps.ts`、`src/store/r2.ts` | 改成 D1 `acme_accounts.private_key` + `key_cipher` |
| V7 | LessV `key_cipher` 无 AAD；`KEY_SECRET` 标准 base64 | 读 `src/services/key_cipher.ts`、`src/env.ts` | 统一封装；不复制 `envelope.ts` |
| V8 | `route_groups.ts` 只允许四组前缀 | 读源码 | `GET /api/zones` 不可用，改 `/api/admin/zones` |
| V9 | `wrangler.jsonc` 缺 `database_id`，且 gitignored | 读文件/`git check-ignore` | 部署前写入 `8d2a018e-...`，并同步 example 的结构 |
| V10 | P1a 的 server 已销毁；VPS/SSH/Linode 工件不存在 | 操作者确认 + `ls ~/.lessv` | 必须新建 VPS |
| V11 | certworker 的 ACME/JWS/CSR/Workflow 测试在 workerd 下可运行；Workflow 测试依赖 plugin 1.3.3 | 读其 `vitest.config.ts` / `test/workflow.spec.ts` | 移植测试的可行路径明确 |
| V12 | `jose` 只被 certworker 的 Access 使用 | `grep` | 不引入 |
| V13 | LessV agent E2E 用 `wrangler dev` 起真实 workerd；`--var` 提供 secrets | 读 `agent/tests/test_e2e_pull.py` | 增加 `CF_DNS_API_TOKEN` var 即可继续用 |
| V14 | `CF_DNS_API_TOKEN` verify active；可读 `example.com`；临时 TXT create/delete 成功 | Cloudflare API 实测 | DNS-01 权限就绪 |
| V15 | 当前 Cloudflare token 可 `r2 bucket list` 且临时 bucket create/delete 成功 | Wrangler 实测 | R2 Edit 就绪 |
| V16 | Linode token 已创建并验证：scopes `account:read_only images:read_only linodes:read_write`，expiry 2027-04-25；ACL 仅当前用户；`jp-tyo-3` 的 `g6-nanode-1` available | Linode API 实测 | 可创建新 VPS |

### 1.2 推断（需在真实环境复核）

| # | 推断 | 复核点 |
|---|---|---|
| I1 | 新建 Linode `g6-nanode-1` / Debian 12 在 `jp-tyo-3` 或 `sg-sin-2` 可用 | 创建后 `GET /linode/instances/{id}` running |
| I2 | `tokyo01.example.com` 尚未被占用 | Cloudflare DNS records；公网 A/AAAA |
| I3 | LE staging/production 都广告 `tlsserver` | 签发前读 `directory.meta.profiles`；staging 先跑 |
| I4 | `wrangler@4.144` 在 Windows 下能本地启动 Workflows binding | P1b.1 用最小 workflow 冒烟 |
| I5 | 升级 vitest plugin 不会破坏现有 242 个测试 | P1b.0 全量回归 |
| I6 | Debian nginx master 以 root 读 `privkey.pem` 0600 可行 | P1b.9 `nginx -t` + curl |
| I7 | LE `tlsserver` 45 天 + 1/3 续期窗口足够 | 生产证书 `not_before/not_after` 实测 |
| I8 | 当前 Cloudflare 部署 token 可创建/更新 Worker、D1、Workflow、R2 | `wrangler deploy --dry-run` + 临时 bucket 实测 |

### 1.3 未决（必须由操作者确认）

- Linode 区域偏好（默认 `jp-tyo-3`，已确认 available；备选 `sg-sin-2`）。
- 真实客户端验收方式：本地 Xray 自动探针即可，还是必须人工导入 v2rayN/NekoBox/Shadowrocket。

已确认：节点域名 `tokyo01.example.com`；DNS only A 记录；LE production 签发 + 一次强制续期；R2 启用；`manage_nginx=true`；删除证书域名不 revoke；Linode token 就绪。

---

## 2. 需要你提供的输入

### 2.1 总表

| # | 输入 | 用途 | 阻塞阶段 | 提供方式 |
|---|---|---|---|---|
| E1 | **已完成**：Cloudflare token 有 R2 Edit | 创建 `lessv-certs`、部署 R2 binding | — | `~/.lessv/cloudflare.env` 已验证临时 bucket create/delete |
| E2 | **已完成**：`CF_DNS_API_TOKEN`（Zone `DNS:Edit` + `Zone:Zone:Read`，只给 `example.com`） | ACME DNS-01、zone 列表、TXT 清理 | — | `~/.lessv/cloudflare.env` 已验证临时 TXT create/delete |
| E3 | **已完成**：Linode Personal Access Token（§2.4） | 创建一台 P1b 节点 VPS | P1b.9 | `~/.lessv/linode.env`，owner-only ACL；scopes 已核对 |
| E4 | **已确认**：节点域名 `tokyo01.example.com` + DNS only A 记录 | cert SAN / REALITY SNI / nginx server_name | P1b.9 | 服务器创建后用 Cloudflare API 建 A 记录（已授权） |
| E5 | **已确认**：`tokyo01.example.com` | cert SAN / REALITY SNI / nginx server_name | P1b.8 | 不需要额外操作 |
| E6 | 真实客户端/探针 | 订阅和 REALITY 继续可用 | P1b.9（可后置人工） | 本地 Xray 自动探针；人工客户端后置导入 |
| E7 | **已同意**：LE production 签发 + 一次强制续期 | 生产证书 | P1b.9 | 先用 staging 全流程 |
| E8 | **已完成**：R2 已启用 | 创建 `lessv-certs` | — | 临时 bucket create/delete 成功 |

### 2.2 我生成、不需要你提供的

- `ADMIN_KEY`/`KEY_SECRET` 已存在；P1b 不轮换 `KEY_SECRET`（会锁死已封装的 REALITY/证书/ACME 私钥）。
- `CF_DNS_API_TOKEN` 已在 `~/.lessv/cloudflare.env`，已验证；部署时写入 Worker secret。
- 节点 token、订阅 token 由面板生成。
- 专用 SSH key `~/.ssh/lessv_p1b_ed25519` 由我生成；公钥通过 Linode API 的内联 `authorized_keys` 注入，不需要你操作。
- `lessv-certs` bucket 名称、Workflow 名称、cron 表达式使用 §0.2 默认值。

### 2.3 凭证处理规则

1. `~/.lessv/*.env`、`.env.production`、`.dev.vars` 均为 0600；不进入 git；不在日志/聊天/commit 中出现。
2. `CF_DNS_API_TOKEN` 只放 Worker secret 和本地 `.dev.vars`；不放进 `wrangler.jsonc`。
3. 迁移前 `wrangler d1 export` 的备份含 sealed 私钥、订阅 token、节点 token hash；按 secret 处理，0600，验收后删除。
4. 生产签发只跑一次；测试签发只走 staging；CI/本地测试全部 mock。

### 2.4 Linode token（已就绪）

**状态（2026-10-25 验证）**：`~/.lessv/linode.env` 已存在；`LINODE_TOKEN` 为 64 字符；ACL 已收紧为仅当前用户；`/v4/profile/tokens` 显示 scopes 正好是 `account:read_only images:read_only linodes:read_write`，expiry `2027-04-25`；`GET /account`、`/linode/instances`、`/images/linode/debian12` 均 200。现有唯一实例是无关的 `unrelated-jp01`，没有 `lessv-server`。以下创建步骤保留，供 token 过期/重建时使用。

**类型**：Linode **Personal Access Token**（不是 OAuth app）。

**创建路径**：cloud.linode.com → My Profile → API Tokens → Create Personal Access Token。

**名称**：`lessv-p1b-provision`；**Expiry**：7 天即可（不够就 30 天，验收后删除）。

**Scopes（只需要这三项）**：

| Scope | 级别 | 用途 |
|---|---|---|
| `linodes` | **Read/Write** | 创建/查询/删除 Linode、轮询 running、设置 label/tags |
| `account` | **Read Only** | `GET /account` 验证 token；读取账户设置 |
| `images` | **Read Only** | 选择并确认 `linode/debian12` 镜像 |

不需要：`domains`（DNS 在 Cloudflare）、`object_storage`、`volumes`、`nodebalancers`、`stackscripts`、`sshkeys`（SSH 公钥用创建实例时的内联 `authorized_keys`）、`firewalls`（默认用节点内 `ufw`/iptables；若你希望用 Linode Cloud Firewall 再加 `firewalls:read_write`）。

**写入文件**（0600，不要贴聊天、不要放进 `.env.production`）：

```bash
mkdir -p ~/.lessv
# 交互式写入，避免 shell history
read -rsp 'LINODE_TOKEN: ' LINODE_TOKEN; echo
printf 'LINODE_TOKEN=%s\n' "$LINODE_TOKEN" > ~/.lessv/linode.env
unset LINODE_TOKEN
chmod 600 ~/.lessv/linode.env   # Windows: icacls 限制为当前用户
```

**自检**（三条都应为 200）：

```bash
set -a; . ~/.lessv/linode.env; set +a
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/account
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/linode/instances
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $LINODE_TOKEN" https://api.linode.com/v4/images/linode/debian12
```

**我会创建什么**：一台 `lessv-server`（默认 `jp-tyo-3`，`g6-nanode-1`，`linode/debian12`；若该规格不可用则 `g6-standard-1`）。root 密码由 API 生成，写入 `~/.lessv/acceptance/linode.json`（0600）；专用 SSH key 为 `~/.ssh/lessv_p1b_ed25519`；P1b 验收完成后删除实例和 token。client 探针用本地 Xray，不再开第二台 VPS。

**为什么不要更多权限**：`linodes:read_write` 已经覆盖实例创建/删除/查询；`account:read_only` 和 `images:read_only` 只用于验证与选镜像。最小权限降低 token 泄露后的影响。

---

## 3. `PLAN.md` 修正与锁定设计

执行 P1b.0 时先把以下修正写回 `PLAN.md`，再改代码（§15.9）。

| # | `PLAN.md` 位置 | 修正 |
|---|---|---|
| C1 | §6.1 `GET /api/zones` | 改为 `GET /api/admin/zones`。四组 fail-closed 守卫不允许第五个前缀；不应为了一个端点放宽边界。 |
| C2 | §8 P1b 任务 3 依赖 `jose` | 删除 `jose`；只加 `@peculiar/x509` + `@abraham/reflection`。ACME 用 WebCrypto/JWS 自实现，`jose` 只属于已删除的 Access。 |
| C3 | §6.2 `/report` 追加字段 | 明确增加 `stage: "cert"`。否则“配置未变但证书/nginx 状态变化”时，agent 只能用 apply 成功报告伪造 Xray 状态。`stage=cert` 只更新 `last_seen` + 证书状态列，不动 `applied_hash`/`health`/`last_error`。 |
| C4 | §5.2 表清单 | 补 `challenge_records`（TXT 清理必需）、`certificates.profile`、`certificates.purged_at`、`certificates.created_at`、`issue_runs.created_at`、`acme_accounts.public_jwk`。这些是内部实现列，不扩大产品范围。 |
| C5 | §7.4 nginx reload | 明确：`nginx` active 时 `systemctl reload nginx`；inactive 时 `systemctl start nginx` 后验证。否则验收项“停 nginx 后恢复自动好转”无法成立（inactive 的 unit 上 reload 会失败）。 |
| C6 | §7.4 证书路径 | 明确 wildcard 域名的路径名：`*.example.com` → `wildcard.example.com`。否则 `*` 进入 nginx 路径/命令行会出问题。 |
| C7 | §13 第 8 条 | 明确新头是 `X-Lessv-Node`，protocol 2；旧 agent 不兼容，部署后立即升级节点 agent。 |
| C8 | §9 测试策略 | 明确先升级 `@cloudflare/vitest-plugin` 到 1.3.3、`wrangler` 到 4.144，否则 Workflow introspection 测试不可用。 |
| C9 | §7.3 测试证书保留 | 明确：staging 只保留 current；非 current 立即由 sweeper 清；current 超过 7 天也清（R2 + 行删除）。production 非 current 只清 R2，保留行。 |
| C10 | §6.1 删除证书域名 | 明确 P1b **不做 revocation**（§12 已排除 revoke UI）。DELETE = 有活动 run 则 409；否则软删除 + 删除节点分配；不调用 ACME revoke。文档写明。 |
| C11 | §10 部署 | 明确本地 `wrangler.jsonc` 要写入远程 D1 id；`wrangler.example.jsonc` 只保留结构，不写 id。 |
| C12 | §7.4 状态报告节流 | 明确 agent `state.json` 增加 `last_nginx_ok`；304 时只做 nginx active 检查，状态变化才报告，避免每 30s 写库。 |

### 3.1 数据模型（最终 DDL）

`migrations/0005_certs.sql`：

```sql
CREATE TABLE IF NOT EXISTS cert_domains (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,   -- lowercase punycode; may start with "*."
    zone_id          TEXT NOT NULL,
    include_wildcard INTEGER NOT NULL DEFAULT 1,
    acme_profile     TEXT NOT NULL DEFAULT 'tlsserver', -- tlsserver | classic
    renew_before_days INTEGER,               -- NULL = actual lifetime / 3
    status           TEXT NOT NULL DEFAULT 'active',    -- active | paused | deleted
    last_error       TEXT,                   -- production only
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificates (
    id                 TEXT PRIMARY KEY,
    domain_id          TEXT NOT NULL,
    environment        TEXT NOT NULL,        -- production | staging
    serial             TEXT NOT NULL,
    fingerprint_sha256 TEXT NOT NULL,
    sans_json          TEXT NOT NULL,
    not_before         TEXT NOT NULL,
    not_after          TEXT NOT NULL,
    profile            TEXT NOT NULL,        -- profile echoed by CA (or requested)
    issued_at          TEXT NOT NULL,
    r2_prefix          TEXT NOT NULL,
    is_current         INTEGER NOT NULL DEFAULT 0,
    purged_at          TEXT,
    created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_current_env
    ON certificates(domain_id, environment) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_cert_domain_env
    ON certificates(domain_id, environment, created_at);

CREATE TABLE IF NOT EXISTS acme_accounts (
    environment   TEXT PRIMARY KEY,          -- staging | production
    directory_url TEXT NOT NULL,
    account_url   TEXT NOT NULL,
    private_key   TEXT NOT NULL,             -- v1: sealed PKCS#8 PEM
    public_jwk    TEXT NOT NULL,             -- JSON; needed to rebuild CryptoKeyPair
    thumbprint    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_runs (
    id          TEXT PRIMARY KEY,
    domain_id   TEXT NOT NULL,
    environment TEXT NOT NULL,
    trigger     TEXT NOT NULL,               -- renew | manual | test
    status      TEXT NOT NULL,               -- queued | running | succeeded | failed
    phase       TEXT,
    error       TEXT,                        -- LE/Cloudflare error verbatim
    workflow_id TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    steps_json  TEXT,
    created_at  TEXT NOT NULL
);
-- One active run per domain, regardless of environment: _acme-challenge
-- TXT names collide across staging and production.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_active
    ON issue_runs(domain_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_run_domain
    ON issue_runs(domain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_workflow
    ON issue_runs(workflow_id);

CREATE TABLE IF NOT EXISTS challenge_records (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    zone_id     TEXT NOT NULL,
    cf_record_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenge_run
    ON challenge_records(run_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_challenge_stale
    ON challenge_records(deleted_at, created_at);

CREATE TABLE IF NOT EXISTS node_cert_domains (
    node_id     TEXT NOT NULL,
    domain_id   TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, domain_id)
);
```

`migrations/0006_node_cert_status.sql`：

```sql
ALTER TABLE nodes ADD COLUMN nginx_ok INTEGER;      -- NULL unknown, 0 failed, 1 ok
ALTER TABLE nodes ADD COLUMN nginx_error TEXT;
ALTER TABLE nodes ADD COLUMN cert_etag TEXT;
ALTER TABLE nodes ADD COLUMN cert_synced_at INTEGER; -- Unix seconds
```

说明：

- 证书子系统内部用 ISO-8601 TEXT 时间（沿用 certworker，避免重写步骤/测试）；`nodes.cert_synced_at` 与 agent 报告用 Unix seconds。这个混用必须在 `src/cert/store` 边界内，UI 解析 ISO，节点状态解析秒。
- 无外键（与 0001–0004 一致）；删除顺序由 store 显式处理。
- `certificates.is_current` 是每个 `(domain_id, environment)` 唯一，不再使用 `status='current'`。
- `challenge_records` 不对外暴露，只用于 TXT 清理和 sweeper。

### 3.2 存储与封装

**D1**：`src/cert/store/d1.ts` 只放 SQL；`src/cert/store/r2.ts` 只放 R2。行类型：

- `CertDomainRow`、`CertificateRow`、`AcmeAccountRow`、`IssueRunRow`、`ChallengeRecordRow`、`NodeCertDomainRow`。
- `CertificateRow` 含 `environment`、`profile`、`is_current`、`purged_at`。

**R2 路径**（`certificatePrefix(environment, pathName, certId)`）：

```
certs/<environment>/<pathName>/<cert-id>/cert.pem
certs/<environment>/<pathName>/<cert-id>/chain.pem
certs/<environment>/<pathName>/<cert-id>/fullchain.pem
certs/<environment>/<pathName>/<cert-id>/privkey.pem.enc
certs/<environment>/<pathName>/<cert-id>/meta.json
```

- `pathName = certPathName(domain.name)`：lowercase；`*.example.com` → `wildcard.example.com`；其余原样（已由 `normalizeDomainName` 限定字符）。
- `privkey.pem.enc` 的内容是 UTF-8 `v1:<base64(iv||ct+tag)>`，由 `key_cipher.seal` 生成；不存二进制 envelope。
- `meta.json` 含 `certificate_id/domain/environment/sans/serial/fingerprint_sha256/not_before/not_after/issued_at/profile/key_type`。
- 先写 R2，再在 D1 翻 `is_current`；崩溃不会让 current 指向不存在的对象。`activateCertificate` 用 batch：先把同 domain+environment 的 current 置 0，再插入新行（或更新已有行）。

**ACME account**：`acme_accounts` 一行一个 environment：

- `private_key` 用 `key_cipher.seal(env, pem)`；`public_jwk` JSON；`thumbprint` 创建时算好。
- 加载时 `unseal` → `importPrivateKeyPem`，再从 `public_jwk` import 公钥，重建 `CryptoKeyPair` 给 `AcmeClient`。
- 不复制 `src/cert/crypto/envelope.ts`；所有 sealed 值统一 `v1:`。

### 3.3 environment、锁、保留

| 维度 | 规则 |
|---|---|
| 目录 | 两个常量：`production` = `https://acme-v02.api.letsencrypt.org/directory`，`staging` = `https://acme-staging-v02.api.letsencrypt.org/directory`。不是 Worker 变量。 |
| account | `acme_accounts` 按 environment 各一行；staging/prod 绝不共用 key/URL。 |
| current | `certificates` 每个 `(domain, environment)` 一个 current（partial unique index）。 |
| 测试签发 | `test-issue` 只创建 staging run；只翻 staging current；production current 不动。 |
| 节点投递 | 只查 `environment='production' AND is_current=1`；staging 永不出现。 |
| cron | 只扫 `environment='production'`；staging 不续期。 |
| 锁 | `issue_runs` 的 `idx_run_active` 按 `domain_id`（不分 environment）。staging 与 production 同时跑会覆盖同名 `_acme-challenge` TXT。 |
| 冲突 | 已有 active run 时，`issue`/`test-issue` 返回 409，不排队。 |
| staging 保留 | 只保留 current；非 current 立即由 sweeper 清 R2 + 行；current 超过 7 天也清（R2 + 行）。 |
| production 保留 | 非 current 清 R2，保留 D1 行（`purged_at`），失败由 sweeper 重试；current 不清理。 |
| run 保留 | `issue_runs` 保留 30 天；sweeper 删除更老的已结束 run。 |
| domain 删除 | 有 active run → 409；否则软删除 + 删除 `node_cert_domains`；**不 revoke**（§12）。 |

### 3.4 ACME profile 与续期

- `cert_domains.acme_profile`：`tlsserver`（默认）或 `classic`；`shortlived` 不进 UI/DB 校验。
- `AcmeClient.newOrder(identifiers, profile?)`：
  1. `getDirectory()`；
  2. 若给了 `profile`，`directory.meta.profiles` 必须是对象且包含该 key；否则抛 `AcmeProtocolError`（workflow 包成 `NonRetryableError`），**不静默降级**；
  3. 请求体 `{ identifiers, ...(profile ? { profile } : {}) }`；
  4. `AcmeOrder` 增加可选 `profile`；若 CA 回显且与请求不一致，抛错。
- 测试：directory 无 `meta.profiles` 时请求 profile 失败；有 profiles 时请求体含 profile；回显不一致失败；不请求 profile 时不带字段。
- `certificates.profile` 存 CA 回显的（或请求的）profile；续期窗口按该证书实际 `not_before/not_after` 算。PATCH `acme_profile` 不自动重签；下一次 issue/renew 生效。
- 续期：`renew_before_days` 非空用它；为空则
  `renew_at = not_after - max(1 day, floor((not_after - not_before) / 3))`
  - `tlsserver` 45 天 → 提前 15 天；
  - `classic` 90 天 → 提前 30 天。
- `listDueDomains(db, now)`：只取 active + production current；无 current 视为 due；在 JS 里按上面的窗口过滤（域名数量小，SQL 不硬编码日期算术）。cron 的 workflow id `renew-<domainId>-<YYYY-MM-DD>` 保证同日幂等；`idx_run_active` 防并发。
- order/authz 过期：workflow 内做**最多 2 次** order 尝试。每次尝试的 step 名带后缀（`new-order-1`/`publish-txt-1`/...），失败若是 `AcmeError` 且 detail/type 含 `expired` 或 `orderNotReady`，记录 `order-expired-<n>` phase 后重开；否则失败。`finalize+store` 不在重试环内；它失败就是 run 失败，人工重试。`cleanup-txt` 在最后按 runId 清理所有尝试留下的 TXT。

### 3.5 证书投递与 ETag

**`GET /api/node/certs`**（节点 token，protocol 无需 body）：

- 查询该节点 `node_cert_domains` ⋈ `cert_domains`（active）⋈ 当前 production 证书；按 domain 排序。
- 组装 `pathName`、`sans`、`fingerprint_sha256`、有效期、`fullchain_pem`、解封后的 `private_key_pem`。
- 复合 ETag：对所有**存在的** production current 证书按 `domain + "\0" + fingerprint_sha256` 排序后 SHA-256，返回 `"<hex>"`（带引号）。
- `If-None-Match` 命中 → 304，只带 `ETag`，无 body。
- `Cache-Control: no-store`。
- 已分配但当前没有 production 证书的 domain：省略（不写空文件）；agent 保留旧 `current`；lint 报警。
- R2 对象缺失/解封失败：500 `{detail}`，不返回部分 manifest；agent 不改文件。
- 测试证书永远不查询。

**`GET /api/admin/nodes/:id/certs`**：返回 `{node_id, nginx_ok, nginx_error, cert_synced_at, certs:[...]}`；每个摘要含 `domain/path/not_after/profile`，供节点页/fleet 用。

**`GET /api/admin/nodes/:id/cert-domains`**：返回所有 active/paused 域名 + `assigned` 布尔 + 当前 production 摘要；`PUT` body `{domain_ids: string[]}` 整体替换分配。分配变化改变 ETag（如果证书集合变化），但不改变 Xray desired hash。

### 3.6 agent 证书同步状态机

`agent/lessv_agent/certs.py`：

```
loop:
  GET /api/node/certs, If-None-Match: state.cert_etag
  304:
    check nginx service active
    if manage_nginx and active != state.last_nginx_ok:
      report(stage=cert, nginx_ok=active, cert_etag=state.cert_etag)
      state.last_nginx_ok = active
    return no-op
  200:
    validate payload shape and path names (no '/', '..')
    if etag == state.cert_etag and all current symlinks exist:
      check active / maybe no-op
    else:
      for each cert:
        write <cert_dir>/<path>/<fingerprint>/{fullchain.pem,privkey.pem}
        atomically swap <cert_dir>/<path>/current symlink
      nginx -t
        fail -> restore all previous symlinks; nginx -t (best effort);
                report nginx_ok=false; do not advance cert_etag
      nginx active ? systemctl reload nginx : systemctl start nginx
      verify active
        fail -> restore symlinks; report false; do not advance
      report(stage=cert, nginx_ok=true, nginx_error=null,
             cert_etag=payload.etag, cert_synced_at=now)
      only after report succeeds: state.cert_etag = payload.etag,
                                   state.last_nginx_ok = true
```

细节：

- 文件 0644/0600；`cert_group` 存在时 key 0640 + `chown root:<group>`。目录 0755。
- 版本目录名用 fingerprint（64 hex），不要用 run id；同一证书重复同步幂等。
- `current` 只用符号链接；若 `current` 是普通目录，报错，不删除。
- 回滚记录每个 domain 的旧 `readlink`；没有旧链接则删除新链接。
- `nginx -t` 用 `nginx`（模块常量 `NGINX_BINARY`，测试可 patch）；超时 15s，输出截断 500 字。
- `nginx_service` 默认 `nginx`；`cert_dir` 默认 `/etc/lessv/certs`；`manage_nginx` 默认 true。
- 证书失败不阻塞 Xray apply；`run_once` 在 apply 后独立 try/except 调 cert sync。
- 304 时只检查 nginx active；状态没变不报告（`last_nginx_ok` 节流）。这样停 nginx 会在下一轮被发现，恢复也会被发现。
- 不删除“未分配”的旧 domain `current`；避免破坏仍引用它的 nginx 配置。
- 版本目录不自动清理（P2 可加）。

### 3.7 cert lint（只读）

`src/cert/lint.ts` 纯函数；`syncState` 调用：

输入：node config、assigned production current certs（含 SAN/`not_after`）、`nginx_ok`、`now`。

规则：

1. REALITY inbound `serverNames` 为空 → `reality inbound '<tag>' has no serverNames`。
2. `serverNames` 每个名字不被任何 assigned current cert 的 SAN 覆盖 → `serverNames '<name>' is not covered by an assigned certificate`。覆盖规则：大小写不敏感；精确 SAN；`*.example.com` 只覆盖一级 `a.example.com`，不覆盖 `example.com` 或 `a.b.example.com`。
3. `dest` 不是 `127.0.0.1:<port>` → `reality inbound '<tag>' dest '<dest>' is not 127.0.0.1:<port>`。
4. `shortIds` 为空，或任一项不是偶数长度 hex → `reality inbound '<tag>' has invalid shortIds`。
5. 已分配证书 `not_after`：
   - 已过期 → `certificate for '<domain>' expired at <iso>`（错误级，但仍是 warning 字符串）；
   - < 7 天 → `certificate for '<domain>' expires in N day(s)`（强警告）；
   - < 15 天 → `certificate for '<domain>' expires in N day(s)`（提示；cron 会续）。
6. `node.nginx_ok === 0` → `nginx is not healthy: <nginx_error>`。
7. 测试证书不参与。

warnings 顺序：render warnings（现有）→ cert lint warnings；保持确定性。lint 不改变渲染、不阻塞保存。

实现边界：`node_state_service` 只 import `cert/store/d1` + `cert/lint`，**不要 import `cert/service`**，避免 `service → render_service → node_state_service` 的循环依赖。service 需要节点摘要时直接查 store。

### 3.8 前端 preset

`frontend/src/lib/reality_preset.ts` 纯函数：

```ts
buildRealityPreset({
  domain: string,
  nginxPort: number, // default 8443
  shortId?: string,  // default random 8 hex
  flow?: string,     // default xtls-rprx-vision
  tag?: string,      // default reality
}): { config: Record<string, unknown>; warnings: string[] }
```

生成 `PLAN.md` 附录 A 的结构：

- `log.loglevel = "warning"`；
- 一个 inbound：`tag`、`listen "0.0.0.0"`、`port 443`、`protocol vless`、`settings.clients []`、`decryption none`、`flow`；
- `streamSettings.network tcp`、`security reality`、`realitySettings.dest = 127.0.0.1:<port>`、`serverNames [domain]`、`privateKey ""`、`shortIds [shortId]`、`settings {fingerprint:"chrome", spiderX:"/"}`；
- `outbounds [BLOCK blackhole, direct freedom]`、`routing.rules []`。

规则：

- `domain` 为空/IP → warning（IP 提示“自偷需要域名 + 证书”），但不阻止生成；UI 保存前显示。
- `shortId` 只允许 8 位 hex（`crypto.getRandomValues` 4 字节）。
- 不把 `privateKey` 写死；渲染时 `ensureKeys` 注入。
- 弹窗只把 JSON 填进现有 config textarea，不自动保存；管理员检查后点现有 `Save config`。这样 preset 仍走现有 `PUT /config`、渲染、密钥、链接。

### 3.9 依赖与工具链

`package.json`：

- 升级 `@cloudflare/vitest-plugin` 到 `^1.3.3`、`wrangler` 到 `^4.144.0`、`vitest` 到 `^4.1.11`（与 certworker 对齐；先跑 P0 全量回归）。
- 新增 `@peculiar/x509` `^2.1.0`、`@abraham/reflection` `^0.13.0`。
- 不加 `jose`。
- 根版本 `0.2.0`；agent `__version__ = "0.2.0"`；`release_agent.mjs` 的 REQUIRED 增加 `lessv_agent/certs.py`。

---

## 4. API 契约

所有 admin 端点都在 `/api/admin/*`，由现有 `ADMIN_KEY` 中间件保护。所有 node 端点用 `X-Lessv-Node` + bearer token。

### 4.1 管理员 API

| 方法 + 路径 | 请求 | 响应/说明 |
|---|---|---|
| `GET /api/admin/zones` | — | `[{id,name,status}]`；Cloudflare 错误 → 502 `{detail}` |
| `GET /api/admin/cert-domains` | — | `CertDomainOut[]`，含 production/staging current 摘要 |
| `POST /api/admin/cert-domains` | `{name, zone_id?, include_wildcard?, acme_profile?, renew_before_days?}` | 201 `CertDomainOut`；域名非法 422/400，重复/ wildcard 冲突 409 |
| `GET /api/admin/cert-domains/:id` | — | `CertDomainOut`；404 |
| `PATCH /api/admin/cert-domains/:id` | `{include_wildcard?, acme_profile?, renew_before_days?, status?}` | 200；status 只允许 active/paused；`renew_before_days:null` 表示改回自动 1/3 寿命 |
| `DELETE /api/admin/cert-domains/:id` | — | 200 软删除；active run 409；不 revoke |
| `POST /api/admin/cert-domains/:id/issue` | `{confirm: "<domain>"}` | 202 `{run_id, workflow_id, status:"queued", environment:"production"}`；confirm 不匹配 400；active run 409 |
| `POST /api/admin/cert-domains/:id/test-issue` | 无 body | 202，environment `staging`；不需要确认 |
| `GET /api/admin/cert-domains/:id/runs` | — | 最近 20 个 run（两个 environment） |
| `GET /api/admin/cert-runs/:id` | — | `CertRunOut`，`error` 原样 |
| `GET /api/admin/cert-domains/:id/certs` | — | production + staging 证书列表（带 `is_current`） |
| `GET /api/admin/certificates/:id` | — | `CertificateOut` |
| `GET /api/admin/certificates/:id/download?file=cert|chain|fullchain|key` | — | PEM 下载；`key` 解封；404 artifacts missing；`no-store` |
| `GET /api/admin/nodes/:id/cert-domains` | — | `{node_id, domains:[{id,name,status,assigned,current_certificate}], nginx_ok, nginx_error, cert_synced_at}` |
| `PUT /api/admin/nodes/:id/cert-domains` | `{domain_ids: string[]}` | 整体替换；未知/已删除 id 422 |
| `GET /api/admin/nodes/:id/certs` | — | `{node_id, nginx_ok, nginx_error, cert_synced_at, certs:[{domain,path,not_after,profile,...}]}`（production current） |

`CertDomainOut`：

```json
{
  "id": "...",
  "name": "tokyo01.example.com",
  "path": "tokyo01.example.com",
  "zone_id": "...",
  "include_wildcard": false,
  "acme_profile": "tlsserver",
  "renew_before_days": null,
  "status": "active",
  "last_error": null,
  "created_at": "2026-...",
  "updated_at": "2026-...",
  "production_certificate": {
    "id": "...", "environment": "production", "serial": "...",
    "fingerprint_sha256": "...", "sans": ["tokyo01.example.com"],
    "not_before": "...", "not_after": "...", "profile": "tlsserver",
    "created_at": "..."
  },
  "staging_certificate": null
}
```

`CertificateOut`：`id/domain_id/domain_name/environment/serial/fingerprint_sha256/sans/not_before/not_after/profile/is_current/purged_at/created_at`。

`CertRunOut`：`id/domain_id/domain_name/environment/trigger/status/phase/error/workflow_id/started_at/finished_at/created_at/steps`。

### 4.2 节点 API

| 方法 + 路径 | 说明 |
|---|---|
| `GET /api/node/certs` | 已分配 production current；`If-None-Match`；`ETag`；`no-store` |
| `POST /api/node/report` | 增加 `stage: "cert"` + `nginx_ok/nginx_error/cert_etag/cert_synced_at` |

`GET /api/node/certs` 200：

```json
{
  "etag": "\"<sha256-hex>\"",
  "certs": [
    {
      "domain": "tokyo01.example.com",
      "path": "tokyo01.example.com",
      "sans": ["tokyo01.example.com"],
      "serial": "...",
      "fingerprint_sha256": "...",
      "not_before": "2026-...",
      "not_after": "2026-...",
      "profile": "tlsserver",
      "fullchain_pem": "-----BEGIN CERTIFICATE-----\n...",
      "private_key_pem": "-----BEGIN PRIVATE KEY-----\n..."
    }
  ]
}
```

- 304：`ETag` 相同、无 body。
- 500：任一 assigned current 的 R2 对象缺失/解封失败。
- 测试证书永不出现。

`POST /api/node/report`：

```json
{
  "protocol": 2,
  "hash": "<current applied hash, may be \"\">",
  "ok": true,
  "stage": "cert",
  "error": null,
  "nginx_ok": true,
  "nginx_error": null,
  "cert_etag": "\"<etag>\"",
  "cert_synced_at": 1758000000
}
```

`stage=cert` 只更新 `last_seen` + `nginx_ok/nginx_error/cert_etag/cert_synced_at`；不动 `applied_hash/health/last_error`。普通 apply report 也可以携带这些字段，服务端一并写。

### 4.3 协议 2

- `PROTOCOL_VERSION = 2`（`src/routers/node.ts` 与 `agent/lessv_agent/__init__.py`）。
- 节点身份头：`X-Lessv-Node`。
- 旧 protocol 1 / 旧头不兼容；部署后立即升级 agent。P1a 节点在升级前会 401/400，这是预期。
- `GET /config`、`GET /certs` 没有 body protocol；POST 全部校验 2。

---

## 5. 文件级改动

### 5.1 新增

```
migrations/0005_certs.sql
migrations/0006_node_cert_status.sql

src/cert/acme/client.ts
src/cert/acme/dns01.ts
src/cert/acme/errors.ts
src/cert/acme/jws.ts
src/cert/dns/cloudflare.ts
src/cert/crypto/base64url.ts
src/cert/crypto/certificate.ts
src/cert/crypto/csr.ts
src/cert/crypto/keys.ts
src/cert/crypto/pem.ts
src/cert/issue/cron.ts
src/cert/issue/steps.ts
src/cert/issue/sweeper.ts
src/cert/issue/trigger.ts
src/cert/issue/types.ts
src/cert/issue/workflow.ts
src/cert/store/d1.ts
src/cert/store/r2.ts
src/cert/models.ts          # Zod 形状（证书域/证书/run/分配）
src/cert/service.ts         # 业务：CRUD/签发/下载/分配/投递/lint 输入
src/cert/lint.ts            # 纯 lint
src/routers/admin_certs.ts  # /api/admin/{zones,cert-domains,cert-runs,certificates}

tests/cert/                  # 从 certworker 移植并改写
  base64url.test.ts
  jws.test.ts
  keys.test.ts
  csr.test.ts
  certificate.test.ts
  pem.test.ts
  dns01.test.ts
  acme_errors.test.ts
  acme_client.test.ts        # + profile
  cloudflare_dns.test.ts
  store_r2.test.ts
  store_d1.test.ts
  issue_trigger.test.ts
  workflow_steps.test.ts
  workflow.test.ts           # plugin 1.3.3 introspection
  cron.test.ts
  sweeper.test.ts
  support/{fake-fetch,mock-acme,mock-dns,fixtures}.ts
tests/pure/cert_lint.test.ts
tests/workerd/cert_domains.test.ts
tests/workerd/cert_admin.test.ts
tests/workerd/cert_delivery.test.ts
tests/workerd/cert_schema.test.ts
tests/workerd/cert_report.test.ts
tests/workerd/node_protocol_v2.test.ts（或更新现有 node_protocol）

agent/lessv_agent/certs.py
agent/tests/test_certs.py

frontend/src/lib/reality_preset.ts
frontend/src/lib/reality_preset.test.ts
frontend/src/lib/cert.ts
frontend/src/lib/cert.test.ts
frontend/src/components/RealityPresetDialog.tsx
frontend/src/components/DownloadButton.tsx
frontend/src/pages/CertificatesPage.tsx
frontend/src/pages/NodeCertsPage.tsx

docs/PROTOCOL.md
docs/OPERATIONS.md
```

### 5.2 修改

```
src/main.ts                 # 注册 adminCerts；路由仍四组
src/worker.ts               # default { fetch, scheduled } + export CertificateWorkflow
src/db.ts                   # NodeRow + setNodeCertStatus
src/models.ts               # NodeSyncOut/ReportIn/NodeOut 新字段
src/routers/node.ts         # protocol 2 / X-Lessv-Node / GET certs / report cert
src/services/node_state_service.ts  # syncState cert 字段 + lint；reportValues stage=cert
src/route_groups.ts         # 不改（继续四组）
wrangler.example.jsonc      # R2/Workflow/cron/secrets.required
wrangler.jsonc              # 手动：D1 id + R2/Workflow/cron
vitest.config.ts            # plugin 版本 + CF_DNS_API_TOKEN test binding
package.json                # deps/versions/0.2.0
worker-configuration.d.ts   # npm run types 重新生成（R2/Workflow/CF_DNS_API_TOKEN）
.dev.vars.example           # CF_DNS_API_TOKEN
.env.production.example     # CF_DNS_API_TOKEN
scripts/release_agent.mjs   # REQUIRED certs.py
scripts/linode_provision.mjs # P1b.9 可选：--server-only，避免固定创建两台
scripts/deploy.mjs          # 可选 preflight（R2/workflow 提示）
agent/install.sh            # nginx 检查 + 目录
agent/lessv_agent/config.py # nginx 字段/bool TOML
agent/lessv_agent/state.py  # cert_etag/last_nginx_ok
agent/lessv_agent/client.py # header/protocol/fetch_certs/report
agent/lessv_agent/loop.py   # cert sync 集成
agent/lessv_agent/__main__.py # enroll flags
agent/lessv_agent/__init__.py # 0.2.0 / protocol 2
agent/systemd/lessv-agent.service # 若需要，ReadWritePaths 保持
frontend/src/api.ts         # zones/cert endpoints/download
frontend/src/types.ts       # cert types + NodeSyncOut
frontend/src/App.tsx        # Certificates nav
frontend/src/pages/NodeLayout.tsx # cert facts + tab
frontend/src/pages/NodeConfigPage.tsx # preset button
frontend/src/pages/FleetPage.tsx      # TLS column
frontend/src/lib/fleet.ts / test      # cert 状态
README.md                   # P1b 部署/首节点
PLAN.md                     # 状态/修正
```

### 5.3 明确不复制

- `ssl-cert-worker/src/{admin,auth,nodes,index.ts,http}/**`：LessV 用 Hono + admin key + 现有 node 路由。
- `ssl-cert-worker/src/issue/revoke.ts`、`src/crypto/envelope.ts`、`src/auth/access.ts`、`src/admin/*`、`src/nodes/*`。
- `ssl-cert-worker/{web,agent}/**`、`wrangler.jsonc` 的 staging/prod 双环境、`ratelimits`、`api_keys/pull_events/audit_log`。
- 测试：`access-jwt`、`admin-keys`、`api-key`、`nodes-pull`、`revoke`、`routing`、`admin-misc`；其余 ACME/DNS/CSR/证书/store/workflow 测试按 §5.1 移植。

---

## 6. 执行阶段

每个阶段结束跑全量相关测试并 commit；commit message 用 `P1b: ...`。源仓库只读。

### P1b.0 — 工具链升级、基线、云预检（0.5 天）

**目标**：让 Workflow 测试工具链可用，确认云资源/权限/输入，建立可回滚点。

**步骤**

1. 记录源仓库 clean、本机基线（已做）。
2. 升级 `@cloudflare/vitest-plugin@^1.3.3`、`wrangler@^4.144.0`、`vitest@^4.1.11`；`npm install`。
3. `npm test`、`npm run typecheck`、`npm run build`、前端/agent 测试全量回归；只修兼容性，不改断言。
4. `vitest.config.ts` 顶部设置测试默认值（`process.env.ADMIN_KEY ??= "test-admin-key"`、`process.env.KEY_SECRET ??= <现有测试值>`、`process.env.CF_DNS_API_TOKEN ??= "test-only-token"`），miniflare bindings 增加 `CF_DNS_API_TOKEN` 同值；验证在**没有 `.dev.vars`** 的临时副本里 `npm test` 仍绿（hermetic）。
5. 云预检：
   - `wrangler whoami`、`d1 list`、`workflows list`、`d1 execute lessv --remote --command "SELECT name FROM d1_migrations ORDER BY id"`；
   - `wrangler r2 bucket list`（已验证 R2 Edit；当前 bucket 列表为空，`lessv-certs` 留到 P1b.8 创建）；
   - `wrangler deployments list --name lessv`；
   - `CF_DNS_API_TOKEN` 已实测可读 zone、临时 TXT create/delete；
   - `~/.lessv/linode.env` 存在，且 `GET /v4/account`、`/v4/linode/instances`、`/v4/images/linode/debian12` 均 200（见 §2.4）；
   - 备份：`mkdir -p ~/.lessv/acceptance && npx wrangler d1 export lessv --remote --output ~/.lessv/acceptance/lessv-pre-p1b.sql`（目录/文件 0600）。
6. 读取 `PLAN.md` 修正 C1–C12 并写回；本文件 §3 作为 diff 依据。

**完成标准**：全量测试绿；R2/DNS/Linode token/域名四个输入项结论明确；D1 备份存在；P1b.9 可直接创建 VPS。

**Commit**：`P1b: upgrade workflows test toolchain`

### P1b.1 — 迁移、D1/R2 store、节点状态列（0.5–1 天）

**目标**：schema 和存储先落地，后续移植有稳定接口。

**步骤**

1. 写 `migrations/0005_certs.sql`、`0006_node_cert_status.sql`（§3.1）。
2. `src/cert/store/d1.ts`：复制 certworker `store/d1.ts`，改表名/列名/environment/current；删除 api keys/pulls/audit/overview；保留 challenge/run/account/domain/cert 函数；增加：
   - `getCurrentCertificate(db, domainId, environment)`
   - `listCurrentCertificates(db)`（按 domain+env）
   - `activateCertificate`（同 env current 置 0）
   - `listUnpurgedProductionCertificates`
   - `listExpiredStagingCertificates(now)`
   - `deleteStagingCertificate`
   - `listNodeCertDomains` / `replaceNodeCertDomains`
   - `listNodeAssignedCerts`
3. `src/cert/store/r2.ts`：`certificatePrefix(environment, pathName, id)`；删除 account metadata 函数；保留 artifacts/delete/list/get。
4. `src/db.ts`：`NodeRow` 加 `nginx_ok/nginx_error/cert_etag/cert_synced_at`；新增 `setNodeCertStatus`（不动现有 `touchNode` 签名）。
5. `wrangler.example.jsonc` / 本地 `wrangler.jsonc`：
   - `r2_buckets: [{binding:"CERTS", bucket_name:"lessv-certs"}]`
   - `secrets.required` 加 `CF_DNS_API_TOKEN`
   - 本地写 `database_id`；example 不写
   - 本地 `.dev.vars` 加占位 `CF_DNS_API_TOKEN=test-only-token`（真实值在 P1b.8）
   - Workflow/cron 在 P1b.3 加（class 尚未存在）
6. `npm run types`；`vitest.config.ts` 增加 `CERTS` 自动来自 wrangler；测试用 `env.CERTS`。
7. 写 `tests/workerd/cert_schema.test.ts`：表/列/partial unique index/active run lock；`tests/cert/store_d1.test.ts`/`store_r2.test.ts`。
8. 全量测试；现有 242 必须仍绿（节点测试暂不受新列影响）。

**完成标准**：迁移在本地 D1 可应用；store 测试绿；`npm run typecheck` 绿；R2 prefix 符合 §3.2。

**Commit**：`P1b: certificate schema and stores`

### P1b.2 — 移植 ACME/DNS/CSR/证书解析（0.5–1 天）

**目标**：无数据库、无 UI 的协议层先在 LessV 里绿。

**步骤**

1. 复制：
   - `src/acme/{client,dns01,errors,jws}.ts` → `src/cert/acme/`
   - `src/dns/cloudflare.ts` → `src/cert/dns/`
   - `src/crypto/{base64url,csr,certificate,keys,pem}.ts` → `src/cert/crypto/`
   - 不复制 `envelope.ts`、`revoke.ts`、`auth/access`。
2. 改 import 路径；`AcmeClient` User-Agent `lessv/0.1`；**删除** `revokeCertificate` 与 `isAlreadyRevoked`（P1b 不做 revoke；保持精简，测试也不移植 revoke）。
3. 实现 profile：
   - `AcmeDirectory.meta.profiles` 校验；
   - `newOrder(identifiers, profile?)`；
   - `AcmeOrder.profile?` 回显校验。
4. `keys.ts` 只保留 `generateEcP256KeyPair/exportPublicJwk/jwkThumbprint/EcPublicJwk`；删除 `sha256Hex`（api key 用不到）。
5. 依赖加 `@peculiar/x509`、`@abraham/reflection`；`npm install`。
6. 移植测试：base64url/jws/keys/csr/certificate/pem/dns01/acme-errors/acme-client/cloudflare-dns；acme-client 增加 profile 用例；fixtures 改 `tests/cert/support`。
7. 测试不触网；mock fetch。

**完成标准**：ACME/JWS/CSR/证书/DNS 测试绿；无 `certworker`/`ENVELOPE_KEY` 残留；`npm run typecheck` 绿。

**Commit**：`P1b: port ACME, DNS, and certificate crypto`

### P1b.3 — Workflow、steps、trigger、cron、sweeper（1–1.5 天）

**目标**：真实签发管线在 mock 下完整，environment/profile/续期/保留就位。

**步骤**

1. 复制 `src/issue/{types,trigger,workflow,steps,cron,sweeper}.ts` → `src/cert/issue/`。
2. `types.ts`：
   - `AcmeEnvironment = "production" | "staging"`；
   - `ACME_DIRECTORIES` 常量；
   - `IssuePayload { runId, domainId, environment }`；
   - `IssueTrigger = "renew" | "manual" | "test"`。
3. `steps.ts`：
   - `IssueDependencies` 含 `env: Env`、`environment`、`directoryUrl`、`dnsApiToken`；
   - `createIssueDependencies(env, environment, options)`；
   - `ensureAcmeAccount/loadAcmeAccount` 走 `acme_accounts`，seal/unseal 用 `key_cipher`；
   - `loadIssue` 只取同 env previous current；identifiers 规则不变；
   - `createOrder` 传 `domain.acme_profile`；
   - `createLeafKeyAndCsr` 用 `seal`；`privkey.pem.enc` 文本；
   - `finalizeAndStore` 写 `environment/profile/is_current`；`activateCertificate` 同 env；
   - `purgePreviousCertificate` 只清同 env previous；
   - `cleanupFailedArtifacts` prefix 含 env/path；
   - `assertPrivateKeyMatchesCertificate` 用 `unseal`。
4. `trigger.ts`：`startIssueRun(db, workflow, domainId, {environment, trigger})`；workflow id `manual-<runId>`/`test-<runId>`/`renew-<domainId>-<date>`；active run 错误。
5. `workflow.ts`：
   - payload environment；
   - phases 按附录 D；
   - order/authz 过期 2 次重试（§3.4）；
   - `finishIssueRun` 只在 production 更新 `cert_domains.last_error`；
   - cleanup 永远执行。
6. `cron.ts`：`listDueDomains` production only + 1/3 窗口；jitter；sweeper；只 production。
7. `sweeper.ts`：
   - production `is_current=0 AND purged_at IS NULL` 清 R2 + mark purged；
   - staging 非 current 清 R2 + 删行；staging current 超 7 天清 R2 + 删行（跳过有 active run 的 domain）；
   - 24h stale TXT；
   - 30 天旧 run。
8. `src/worker.ts`：
   - `export { CertificateWorkflow }`；
   - `default { fetch: (req,env,ctx)=>app.fetch(req,env,ctx), scheduled(...) { await runCertCron(...) } }`；
   - `src/main.ts` 暂时不需要 cert 路由。
9. `wrangler.example.jsonc` / `wrangler.jsonc`：
   - `workflows: [{name:"lessv-cert-issuance", binding:"ISSUANCE", class_name:"CertificateWorkflow"}]`
   - `triggers.crons: ["17 3 * * *"]`
10. `npm run types`；`npm test`；`npm run build`；`wrangler dev` 冒烟。
11. 测试：trigger/workflow-steps/workflow/cron/sweeper；mock ACME/DNS/R2/D1；environment 隔离、profile、1/3 窗口、staging current 清理、production current 不动、active run 锁。

**完成标准**：Workflow 在 vitest introspection 下成功/失败两条路径绿；cron/sweeper 绿；`wrangler dev` 能启动 Workflow binding；`build --dry-run` 绿。

**Commit**：`P1b: certificate issuance workflow and retention`

### P1b.4 — 管理员 API + cert lint（1 天）

**目标**：面板能管理域名、签发、查看 run/证书、下载、分配节点；sync 出 lint。

**步骤**

1. `src/cert/models.ts`：Zod 形状（§4.1）。
2. `src/cert/service.ts`：
   - zones/list/create/update/delete domains；
   - issue/test-issue；
   - runs/certs/download；
   - node assignment；
   - node cert summaries；
   - `certPathName`、`certEtag`、`nodeCertManifest`（P1b.5 用）。
3. `src/routers/admin_certs.ts`：Hono 路由；`parseJsonBody`/`parseJsonObject`；错误映射 404/409/422/502；`/api/admin/zones`。
4. `src/main.ts` 注册 `adminCerts`。
5. `src/cert/lint.ts` + `node_state_service.syncState`：
   - `NodeSyncOut` 增加 `nginx_ok/nginx_error/cert_synced_at/certs`；
   - sync warnings 追加 lint；
   - 更新 `src/models.ts`、`frontend/src/types.ts`（P1b.7 一起）。
6. 测试：
   - `tests/workerd/cert_domains.test.ts`：CRUD、zone 解析、wildcard 重叠、删除 active run 409、软删除、无 revoke；
   - `tests/workerd/cert_admin.test.ts`：issue/test-issue、环境隔离、run 列表/详情、download fullchain/key、artifact missing；
   - `tests/pure/cert_lint.test.ts`：覆盖规则、dest、shortIds、到期分级、nginx false、无 assigned cert；
   - 更新 `admin_sync` 等现有测试的 `NodeSyncOut` 形状。
7. 全量测试。

**完成标准**：所有 admin 端点经 HTTP 测试；lint 纯测试；现有测试更新后全绿。

**Commit**：`P1b: certificate admin API and lint`

### P1b.5 — 节点证书端点 + protocol 2（0.5–1 天）

**目标**：agent 能按 ETag 拉取 production 证书；报告 nginx/证书状态。

**步骤**

1. `src/cert/service.ts` 的 `nodeCertManifest(env, nodeId)`：
   - 查询 assigned active domains + production current；
   - 缺失 current 省略；R2 缺失/解封失败 500；
   - ETag 复合；排序确定。
2. `src/routers/node.ts`：
   - `PROTOCOL_VERSION = 2`；
   - 头 `X-Lessv-Node`；
   - `GET /api/node/certs`；`If-None-Match`；`ETag`；`Cache-Control: no-store`；
   - `ReportIn` 增加 cert 字段 + `stage: "cert"`。
3. `src/models.ts`：
   - `ReportIn.stage` 加 `cert`；
   - `NodeSyncOut` 新字段；
   - `NodeOut` 可不变。
4. `src/db.ts` `setNodeCertStatus`；`node_state_service.reportValues` stage=cert 只改 last_seen；router 在 report 后写证书列。
5. 测试：
   - `tests/workerd/cert_delivery.test.ts`：ETag 稳定、304、测试证书不出现、两节点隔离、未分配为空、artifact missing 500、assignment 变化 ETag 变化；
   - `tests/workerd/cert_report.test.ts`：stage=cert 不改 applied/health、更新 nginx/cert 列、普通 report 携带 cert 字段；
   - 更新 `node_protocol`/`admin_sync`/`error_envelope`/`two_nodes` 的 protocol 2/header；`protocol_freeze` 改 2。
6. 全量测试。

**完成标准**：节点证书隔离/304/报告测试绿；protocol 2 测试绿；旧 protocol 1 明确 400。

**Commit**：`P1b: node certificate delivery and protocol 2`

### P1b.6 — agent 证书同步 + nginx（1–1.5 天）

**目标**：真实节点能写证书、切 symlink、`nginx -t`/reload/回滚、报告。

**步骤**

1. `agent/lessv_agent/certs.py`（§3.6）：
   - `fetch_certs`/`sync_certificates`；
   - 版本目录、原子写、symlink、回滚；
   - `nginx -t`/`reload`/`start`/`active`；
   - 文件模式/`cert_group`；
   - 路径校验。
2. `config.py`：
   - DEFAULTS `manage_nginx=True`、`cert_dir="/etc/lessv/certs"`、`nginx_service="nginx"`、`cert_group=""`；
   - `_parse_simple_toml` 支持 bool；`_to_toml` 写 bool/新字段；`_validate` 校验。
3. `state.py`：`cert_etag=""`、`last_nginx_ok=None`；load/save。
4. `client.py`：header 改 `X-Lessv-Node`；protocol 2；`fetch_certs`（If-None-Match）；`do_report` 支持 cert 字段。
5. `loop.py`：`run_once` 在 apply 后独立调用 cert sync；失败只记录/报告；304 时 nginx active 检查；状态节流。
6. `__main__.py`：enroll flags `--manage-nginx/--no-manage-nginx`、`--cert-dir`、`--nginx-service`、`--cert-group`；`_save_enroll_config` 写入。
7. `install.sh`：`need nginx`/`systemctl cat nginx` 检查；目录已存在；不写 nginx 配置。
8. `__init__.py` 0.2.0/protocol 2；`scripts/release_agent.mjs` REQUIRED 加 `certs.py`。
9. `agent/tests/test_certs.py`：
   - 200 写文件/权限/内容；
   - symlink 切换；重复同步幂等；
   - `nginx -t` 失败回滚；
   - reload/start 失败回滚；
   - 304 + active 变化报告节流；
   - 路径非法；
   - Windows 上 symlink/权限测试 skip（与现有 POSIX skip 一致）。
10. 更新 `test_client/test_config/test_state/test_loop/test_e2e_pull`：
    - protocol 2/header；
    - E2E `--var CF_DNS_API_TOKEN:test`，`manage_nginx=False`；
    - 增加空 certs 端点 200/304 路径。
11. `python -m pytest -q agent/tests` 全绿。

**完成标准**：agent 测试全绿（仅 POSIX skip）；E2E 0 skip；无 nginx 环境下 `manage_nginx=False` 正常。

**Commit**：`P1b: agent certificate sync and nginx reload`

### P1b.7 — 前端 preset + 证书 UI（1–1.5 天）

**目标**：管理员能在 UI 完成 preset、域名、测试/生产签发、run、证书、分配、到期/nginx 状态。

**步骤**

1. `frontend/src/lib/reality_preset.ts` + test（§3.8）。
2. `RealityPresetDialog.tsx`：域名（默认 node.address）、nginx 端口、shortId、flow；预览 JSON；IP/空域名警告；“填入编辑器”；不自动保存。
3. `NodeConfigPage` 加 “REALITY preset” 按钮；保留现有 Save。
4. `frontend/src/lib/cert.ts` + test：`daysUntilIso`、`certTone`、`nearestCert`、`isStaging`。
5. `types.ts`/`api.ts`：
   - `ZoneOut`、`CertDomainOut`、`CertificateOut`、`CertRunOut`、`NodeCertDomainOut`、`NodeCertSummary`；
   - 新 API 调用；
   - `downloadCertificate(id, file)` raw fetch + blob，401 清 key。
6. `CertificatesPage.tsx`：
   - zone 选择（失败可省略，后端自动找 zone）；
   - 创建域名（name/wildcard/profile/renew days）；
   - 域名表：production/test 两列、到期、profile、状态、last_error；
   - 生产签发需输入域名确认；测试签发无确认；
   - runs 面板（status/phase/error 原样，刷新）；
   - certs 面板（production/staging 标记，下载 fullchain/key）；
   - 删除需确认；active run 409 显示。
7. `NodeCertsPage.tsx`：节点 tab “Certificates”；域名勾选；保存分配；显示 current cert 到期 + nginx 状态。
8. `NodeLayout` 增加 tab + header facts（TLS/nginx/cert synced）；`FleetPage` 增加 TLS 列；`lib/fleet` 更新。
9. `App.tsx` top nav “Certificates”；路由 `/certificates`。
10. `npm --prefix frontend test`、`typecheck`、`build` 全绿。

**完成标准**：preset 纯测试；证书页/节点页能构建；fleet 显示 TLS；前端 27+ 测试绿。

**Commit**：`P1b: REALITY preset and certificate UI`

### P1b.8 — 部署 + staging 测试签发（0.5 天）

**目标**：线上面板具备证书能力；staging 成功且不影响 production。

**前置**：E1/E2/E8 已完成；`CF_DNS_API_TOKEN` 有效；R2 bucket 可创建（权限已验证，`lessv-certs` 尚未创建）。

**步骤**

1. 配置本地 `wrangler.jsonc`：
   - `database_id` = 远程 D1；
   - `r2_buckets`、`workflows`、`triggers`、`secrets.required`。
2. `wrangler.example.jsonc` 同步结构（无 id）。
3. `.env.production` 加 `CF_DNS_API_TOKEN`；`.dev.vars` 加本地测试值；权限 0600。
4. `npx wrangler r2 bucket create lessv-certs`（若已存在则跳过；需要 R2 权限）。
5. `npm run types`；`npm test`；`npm run build`；前端 build。
6. **先应用迁移再部署**（缩短新代码查询新表的窗口）：
   `npx wrangler d1 migrations apply DB --remote`
   （0005/0006 只加表/列，旧 Worker 不受影响；P1b.0 的 D1 export 是回滚点）。
7. `npm run deploy -- --secrets-file .env.production`；部署脚本会再跑一次迁移（幂等）；health 200。
8. 验证：
   - `wrangler workflows list` 有 `lessv-cert-issuance`；
   - `wrangler deployments list` 新版本；
   - `GET /api/admin/zones` 200；
   - `GET /api/admin/cert-domains` 200。
9. 创建域名 `tokyo01.example.com`（`include_wildcard=false`，`tlsserver`）。
10. `POST /test-issue`；轮询 `/runs` 至 succeeded；检查：
   - staging current 存在、`environment=staging`、`profile=tlsserver`；
   - production current 仍为 null；
   - `/api/node/certs` 不包含 staging（或该节点未分配时为空）；
   - UI 显示 `STAGING — NOT TRUSTED`；
   - TXT 记录已清理（Cloudflare DNS 查询/日志）。
11. 记录 staging 证书 `not_before/not_after`、SAN、serial；不下载 key 到本地（除非排障）。
12. 失败可见性（可选，推荐）：创建一个临时域名 `fail.example.com`，在 Cloudflare 加 CAA `0 issue "none"`；`test-issue` 应失败，run/UI 原样显示 LE CAA 错误；删除 CAA 和临时域名。若不改 DNS，则由 `cert_admin` 的 seeded failed run + UI run 面板覆盖该验收项。

**完成标准**：staging 签发成功；production current 不变；测试证书不投递；run 错误可见；签发的 SAN 正确。

**Commit**：`P1b: deploy certificate stack and verify staging issuance`

### P1b.9 — 生产签发 + nginx 自偷验收（0.5–1 天）

**目标**：完成 `PLAN.md` §14 P1b 的真实链路。

**前置**：E3/E4/E5/E7；`~/.lessv/linode.env` 已就绪；新 VPS 在步骤 0 创建，Xray/nginx 在步骤 1 安装；DNS A（灰云）在步骤 2 创建。

**步骤**

0. **创建 VPS**：**不要直接运行现有 `scripts/linode_provision.mjs create`**——它固定创建 `lessv-server` + `lessv-client` 两台。P1b 只需要一台：给脚本加 `--server-only`（推荐，P1b.9 实现）或直接用 Linode API。生成专用 SSH key `~/.ssh/lessv_p1b_ed25519`；用 Linode API 创建一台 `lessv-server`（默认 `jp-tyo-3` / `g6-nanode-1` / `linode/debian12`，`authorized_keys` 内联公钥，`booted=true`）；轮询 `GET /linode/instances/{id}` 至 `running`，记录公网 IPv4；root 密码/inventory 写入 `~/.lessv/acceptance/linode.json`（0600）。若 `g6-nanode-1` 不可用，改用 `g6-standard-1`。
1. **VPS 基础软件**：
   ```bash
   apt-get update
   apt-get install -y curl ca-certificates nginx ufw
   bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
   xray version
   systemctl enable nginx
   ```
   安装后确认 `nginx -v`、`systemctl cat xray`；`/var/www/lessv-decoy/index.html` 由 `install.sh` 创建。默认 nginx site 的 80 端口不冲突；Xray 官方默认配置可能先占用 443，agent 会在拿到渲染配置后替换。
2. **DNS**：`tokyo01.example.com` A → VPS IPv4，**DNS only**；验证 `dig +short tokyo01.example.com`。
3. **面板节点**：创建/更新 `tokyo01`，`address=tokyo01.example.com`；mint node token（只显示一次）。
4. **安装 agent 0.2.0**：`npm run release:agent` 生成 tarball；scp 到 VPS，解包后运行
   `./install.sh --cp https://cp.example.com --node tokyo01`（token 走 stdin）。
   验证 `systemctl status lessv-agent`、fleet `state=active`、`agent_version=0.2.0`。
5. **REALITY preset**：用 preset 生成配置并保存（`dest=127.0.0.1:8443`，`serverNames=["tokyo01.example.com"]`，shortId 8 hex，flow vision）。等待 applied=desired；确认 Xray 监听 443。
6. **生产签发**：`POST /issue` body `{"confirm":"tokyo01.example.com"}`；轮询 run 至 succeeded；检查 production current 的 SAN/profile/有效期。
7. **分配证书**：`PUT /api/admin/nodes/tokyo01/cert-domains {"domain_ids":["<id>"]}`。
8. **agent 证书同步**：等待 `/api/node/certs` ETag 变化；检查
   - `/etc/lessv/certs/tokyo01.example.com/current/fullchain.pem`
   - `/etc/lessv/certs/tokyo01.example.com/current/privkey.pem`
   - `current` 指向 fingerprint 目录；
   - `nginx -t` 成功；nginx active；节点 sync `nginx_ok=true`、`cert_synced_at` 有值。
9. **nginx 片段**：写 `Appendix B` 改 domain/path 的片段，`nginx -t && systemctl reload nginx`。首次应在证书同步后启用 site（或确认 agent 已写入 current）。
10. **验收**：
    - `curl -v https://tokyo01.example.com/` 返回假站点，证书有效，无 `-k`；
    - `openssl s_client -connect ... -servername ...` 显示 SAN/有效期；
    - REALITY 客户端/订阅继续可用；出口 IP 为节点；
    - `systemctl show xray -p MainPID` 在证书签发/nginx reload 前后不变。
11. **强制续期**：再次 `POST /issue`（confirm）；等待新 production current；agent ETag 变化；nginx reload；`curl` 仍有效；Xray PID 不变。若 LE duplicate rate limit，记录并等待/用 staging 验证；不要反复重试。
12. **停 nginx**：`systemctl stop nginx`；30–60s 内 sync `nginx_ok=false` + lint warning；`systemctl start nginx`；下一轮恢复 `true`。
13. **lint**：把 `serverNames` 改成未覆盖域名并保存；sync warnings 出现 `not covered`；恢复正确配置。
14. **证据**：证书日期/SAN/profile、ETag、nginx/Xray 状态、curl 输出、测试结果、命令时间。

**清理**：验收后删除 Linode 实例、`~/.lessv/linode.env`、`~/.lessv/acceptance/linode.json`、专用 SSH key（保留 `cloudflare.env`）；除非需要留作后续 P1c 新 VPS 验收。

**完成标准**：§14 P1b 10 项全部通过。

**Commit**：`P1b: complete self-steal acceptance`

### P1b.10 — 文档、清理、最终回归（0.5 天）

**步骤**

1. `docs/PROTOCOL.md` v2：端点、头、protocol、ETag、report cert stage、错误。
2. `docs/OPERATIONS.md`：nginx 片段、证书路径/current、测试签发、续期、回滚、停 nginx 排障、`journalctl`、`nginx -t`。
3. README：P1b 状态、R2/Workflow/cron、`CF_DNS_API_TOKEN`、首节点 nginx 步骤、preset/证书页。
4. 更新 `PLAN.md` §14 P1b 复选框、§8 状态、§13 默认项；执行记录与证据写入 `P1B-PLAN-CONTINUE.md`（本文件只保留设计与计划）。
5. 全量回归：Worker/前端/agent/typecheck/build/deploy dry-run。
6. 确认三个源仓库 clean；`git status` 只含 P1b 预期文件。
7. P1c 之前不删除本文件；P1c 结束时按 P1a 惯例删除。

**Commit**：`P1b: document certificate operations and finalize`

---

## 7. 测试矩阵

| 层 | 现有 | P1b 新增/移植 | 命令 |
|---|---|---|---|
| Worker workerd/pure | 242 | 移植 ACME/DNS/CSR/证书/store/workflow/cron/sweeper；新增 schema/domain/admin/delivery/report/lint | `npm test` |
| 前端 | 27 | preset、cert 格式、fleet TLS、download helper（纯） | `npm --prefix frontend test` |
| Agent | 54 + 1 skip | cert fetch/写文件/symlink/回滚/nginx mock/report/config bool/state/E2E | `python -m pytest -q agent/tests` |
| 类型/构建 | — | — | `npm run typecheck`、`npm run build`、`npm --prefix frontend run build` |
| 真实 | — | staging 签发、production 签发、nginx/curl、强制续期、停 nginx、lint | §6 P1b.8/P1b.9 |

规则：

- CI 不碰 LE production；ACME 测试全 mock；staging 只手工在线上面板点。
- 测试 helper 带 `ADMIN_KEY`，不改业务规则；不放宽断言。
- 证书测试必须先绿，再上真实域名。
- 每个阶段结束跑全量；阶段内允许只跑相关文件。
- `npm test` 必须在没有 `.dev.vars` 的副本里也绿（hermetic）。

---

## 8. 部署与运维要点

### 8.1 一次性云资源

```bash
# 需要 Workers R2 Storage:Edit
npx wrangler r2 bucket create lessv-certs

# .env.production 增加 CF_DNS_API_TOKEN（0600）
npm run deploy -- --secrets-file .env.production
```

- `wrangler deploy` 创建 Workflow；cron 随 Worker 部署。
- 远程迁移：`npm run deploy` 内已执行 `d1 migrations apply DB --remote`；若手动部署，单独执行。
- 验证：`curl https://cp.example.com/api/health`、`wrangler workflows list`、`GET /api/admin/zones`。

### 8.2 nginx 片段（P1b 手工）

```nginx
server {
    listen 127.0.0.1:8443 ssl;
    server_name tokyo01.example.com;

    ssl_certificate     /etc/lessv/certs/tokyo01.example.com/current/fullchain.pem;
    ssl_certificate_key /etc/lessv/certs/tokyo01.example.com/current/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root  /var/www/lessv-decoy;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

- wildcard 证书路径用 `wildcard.example.com`。
- 不要在 nginx 里写 `listen 443`；443 属于 Xray。
- `cert_group` 只在 nginx 非 root 时设置；Debian 默认 master root，0600 足够。

### 8.3 排障顺序

1. `GET /api/admin/cert-domains/:id` + `/runs`：LE 错误原样。
2. `GET /api/admin/nodes/:id/sync`：`nginx_ok`/`nginx_error`/cert lint。
3. 节点：`journalctl -u lessv-agent -n 100`；`ls -l /etc/lessv/certs/<path>/`；`readlink -f current`。
4. `nginx -t`；`systemctl status nginx`；`journalctl -u nginx -n 50`。
5. `curl -v https://<domain>`；`openssl s_client`。
6. Xray：`systemctl status xray`；`xray run -test -c /var/lib/lessv/config.json`；`journalctl -u xray`。
7. 证书产物缺失：R2 `certs/<env>/<path>/<id>/` 检查；不要手工改 `current`。

### 8.4 关键命令样例（验收用）

以下命令只作形状参考；secret 从 0600 文件读取，不写进 shell history。

```bash
set -a; . ~/.lessv/cloudflare.env; set +a
ADMIN_KEY=$(sed -n 's/^ADMIN_KEY=//p' .env.production)
CP=https://cp.example.com
AUTH="Authorization: Bearer $ADMIN_KEY"

# 1. zone / 域名
curl -sS -H "$AUTH" "$CP/api/admin/zones" | jq
curl -sS -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"tokyo01.example.com","include_wildcard":false,"acme_profile":"tlsserver"}' \
  "$CP/api/admin/cert-domains" | jq

# 2. 测试签发（staging；无 body）
DOMAIN_ID=<cert-domain-id>
curl -sS -X POST -H "$AUTH" "$CP/api/admin/cert-domains/$DOMAIN_ID/test-issue" | jq
curl -sS -H "$AUTH" "$CP/api/admin/cert-domains/$DOMAIN_ID/runs" | jq

# 3. 检查 staging 与 production 隔离
curl -sS -H "$AUTH" "$CP/api/admin/cert-domains/$DOMAIN_ID" | jq \
  '{production:.production_certificate,staging:.staging_certificate}'

# 4. 生产签发（需要 confirm）
curl -sS -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"confirm":"tokyo01.example.com"}' \
  "$CP/api/admin/cert-domains/$DOMAIN_ID/issue" | jq

# 5. 节点分配 + 节点证书端点
curl -sS -X PUT -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"domain_ids\":[\"$DOMAIN_ID\"]}" \
  "$CP/api/admin/nodes/tokyo01/cert-domains" | jq
NODE_TOKEN=<node-token>
curl -sS -D /tmp/cert.headers \
  -H "Authorization: Bearer $NODE_TOKEN" -H 'X-Lessv-Node: tokyo01' \
  "$CP/api/node/certs" | jq '{etag,certs:[.certs[]|{domain,path,not_after,profile}]}'
ETAG=$(awk 'tolower($1)=="etag:"{print $2}' /tmp/cert.headers | tr -d '\r')
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $NODE_TOKEN" -H 'X-Lessv-Node: tokyo01' \
  -H "If-None-Match: $ETAG" "$CP/api/node/certs"   # 期望 304

# 6. nginx / 证书 / Xray
curl -sS -v https://tokyo01.example.com/ 2>&1 | head -40
openssl s_client -connect tokyo01.example.com:443 \
  -servername tokyo01.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -dates -ext subjectAltName
systemctl show xray -p MainPID

# 7. 停/起 nginx 后看 sync
systemctl stop nginx; sleep 40
curl -sS -H "$AUTH" "$CP/api/admin/nodes/tokyo01/sync" | jq '{nginx_ok,nginx_error,warnings}'
systemctl start nginx; sleep 40
curl -sS -H "$AUTH" "$CP/api/admin/nodes/tokyo01/sync" | jq '{nginx_ok,nginx_error}'
```

DNS A 记录（如由我创建）：

```bash
ZONE_ID=00000000000000000000000000000001
curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"A","name":"tokyo01","content":"<VPS-IPv4>","proxied":false,"ttl":60}' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" | jq
dig +short tokyo01.example.com
```

---

## 9. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| plugin/wrangler 升级破坏现有测试 | P1b 起步受阻 | P1b.0 先做，只修兼容性；失败则临时只跑 Workflow 测试用独立 config，但不推荐 |
| Workflows 本地/Windows 不可用 | agent E2E/开发受阻 | P1b.1 最小 workflow 冒烟；失败则 E2E 跳过 workflow 操作，真实 staging 验收兜底 |
| R2 权限/未启用 | 无法部署/签发 | **已验证**：临时 bucket create/delete 成功；P1b.8 仍先 `r2 bucket list` 并创建 `lessv-certs` |
| `tlsserver` 不被广告/拒绝 | 生产签发失败 | 先 staging；读 `meta.profiles`；失败不静默降级，UI 切 `classic` |
| LE 速率限制（duplicate/validation） | 强制续期失败 | 只做一次生产签发+一次强制；staging 先全流程；失败记录等待 |
| 同域 staging/prod TXT 冲突 | 校验失败 | domain 级 active run 锁；UI 显示“已有 run” |
| nginx 权限/`nginx -t` 失败 | 证书不生效 | 版本目录+symlink 回滚；`cert_group`；先同步证书再启用 site |
| agent 回滚失败/半写 | 证书文件不一致 | 先写版本目录再切 symlink；记录旧 target；失败回滚；版本目录幂等 |
| REALITY SNI/证书不匹配 | 伪装失败/证书错 | lint + `curl`/openssl 验收；preset 从 node.address 生成 |
| 旧 protocol 1 agent | 已部署节点升级前失联 | P1a server 已销毁；新节点直接装 0.2.0；文档写明不兼容 |
| KEY_SECRET 轮换 | 所有 sealed 私钥不可读 | 明确不轮换；备份 |
| R2 对象缺失 | 节点拿不到 key | 端点 500，不返回部分；agent 不改文件；面板报错 |
| D1 迁移失败 | 线上面板不可用 | 迁移前 export；0005/0006 只加表/列；回滚 deploy 代码仍兼容旧 schema |
| 证书删除误操作 | 节点旧文件仍可用 | 软删除 + 删除分配；不 revoke；文档说明 |

回滚：

- Worker：`npx wrangler rollback` 回上一版本；D1 新表/列保留，旧代码忽略；R2/Workflow binding 不影响旧代码。
- Agent：重装上一版 tarball；证书文件/`current` 保留，旧 agent 忽略；nginx 仍可用。
- 证书：生产 current 不被测试签发修改；签发失败 run 失败，old current 继续服务。
- nginx：恢复手工片段/`current` 由 agent 管理；不要手工改 symlink。

---

## 10. 待确认问题

已确认：

- 节点域名 `tokyo01.example.com`；允许创建 **DNS only** A 记录。
- LE production 签发 + 一次强制续期。
- Cloudflare R2 权限、`CF_DNS_API_TOKEN` 已就绪。
- 删除证书域名不 revoke；`manage_nginx=true`。

仍需你完成：

1. 确认 Linode 区域偏好：默认 `jp-tyo-3`（已确认 `g6-nanode-1` available）；备选 `sg-sin-2`。
2. 真实客户端验收：本地 Xray 自动探针是否足够？人工客户端可后置导入。

`~/.lessv/linode.env` 已就绪，无需再操作。P1a 的 `lessv-server` 已销毁；P1b 将用该 token 新建一台，验收后删除实例和 token。

---

## 11. 完成清单（对应 PLAN.md §14 P1b）

- [x] REALITY preset（自偷）保存；30 秒内 applied = desired。
- [x] “测试签发”成功；测试证书标 staging；production current 不变。
- [x] 测试证书不在节点分配列表、不出现在 `/api/node/certs`。
- [x] 生产签发 `tlsserver` 成功；节点分配；agent 写入；nginx reload。
- [x] `curl https://<domain>` 返回假站点，证书有效。
- [x] REALITY 客户端继续可用；订阅不变。
- [x] 强制续期：nginx reload；`curl` 有效；Xray 未重启。
- [x] 停 nginx：fleet 显示错误；恢复后自动好转。
- [x] `serverNames` 不被证书覆盖时 lint 报警。
- [x] 证书到期/续期失败在面板可见。

---

## 12. 时间估算

| 阶段 | 估算 | 主要不确定性 |
|---|---|---|
| P1b.0 工具链/预检 | 0.5 天 | plugin 升级回归、Linode token |
| P1b.1 schema/store | 0.5–1 天 | 现有测试适配 |
| P1b.2 ACME/crypto | 0.5–1 天 | profile 支持、测试移植 |
| P1b.3 workflow/cron/sweeper | 1–1.5 天 | Workflows 本地、order 重试 |
| P1b.4 admin API/lint | 1 天 | 形状/错误映射 |
| P1b.5 node delivery/protocol | 0.5–1 天 | ETag/304/报告语义 |
| P1b.6 agent cert sync | 1–1.5 天 | symlink/nginx 回滚/Windows 测试 |
| P1b.7 前端 | 1–1.5 天 | 证书页/预设 |
| P1b.8 staging 部署 | 0.5 天 | R2/LE staging/DNS |
| P1b.9 生产/自偷验收 | 1–1.5 天 | 新 VPS 初始化、nginx/LE/真实客户端 |
| P1b.10 文档/回归 | 0.5 天 | — |
| **合计** | **6–9 个专注日** | 证书链路和真实 nginx 是主要变量 |

> `PLAN.md` 附录 E 的 2–4 天是原估算；把 certworker 测试移植、Workflow 工具链升级、真实 nginx 回滚验收算进去后，6–9 天更现实。

---

## 13. 实施状态

**P1b.0–P1b.9 已完成；P1b.10 未完成。** 逐阶段状态、可复现证据、剩余工作和清理决策见 `P1B-PLAN-CONTINUE.md`。

> 审计说明（2026-10-25）：本节此前存在一份伪造的实施记录（不存在的 commit hash、错误的测试数字、与本仓库无关的 session 描述和文件清单），已删除。`P1B-PLAN.md` 只作为设计与契约来源；不要再从本文件推断执行状态。
