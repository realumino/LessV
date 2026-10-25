# LessV — 实施计划

> 状态：v1 草案
> 目标：在 Cloudflare Workers 上跑一个真正可用的 Xray 面板（REALITY + nginx 自偷 + Let's Encrypt + 订阅），节点端 Python agent。
> 基线：**复制** Lesserv-Cloud、Lesserv-Agent、ssl-cert-worker 的代码，在 LessV 里修改；**不修改三个源仓库**。

---

## 0. 一句话

复制 Lesserv-Cloud 的 Worker/前端/测试、Lesserv-Agent 的 agent、ssl-cert-worker 的 ACME 模块；删掉 Access、多环境、B 拓扑、统计/配额/审计；加上管理员 API Key、REALITY preset、ACME 测试/生产签发、证书投递 + nginx reload；部署后用真实 VPS、真实域名、真实客户端验收。

**不重写渲染核心，不重写 agent reconcile，不做 typed inbound/outbound 数据模型。**

---

## 1. 锁定决策

| # | 决策 | 说明 |
|---|---|---|
| 1 | 基座 = Lesserv-Cloud | 复制后改名，不从头写。渲染管线、数据模型、测试是资产。 |
| 2 | 一个 repo | Worker + 前端 + agent + 协议文档 + README。跨 repo 协议变更的成本不再存在。 |
| 3 | 只做拓扑 A | Xray REALITY 443，`dest=127.0.0.1:8443` nginx 假站点；证书只给 nginx。B（nginx TLS 终止 + WS/xhttp 反代）v1 不做。 |
| 4 | 默认用户只用 REALITY | UI 只提供 REALITY preset；裸 JSON 仍可粘贴其他配置，但不提供模板/链接支持承诺。 |
| 5 | 解耦模型保留 | `config_json` 里的 inbound/outbound 是 tag；用户授权是 `(node, inbound 集合, outbound 集合)`；UUID 按 `(user, exit)`；email = `user@exit`。不把 inbound/outbound 做成 DB 实体。 |
| 6 | 管理员认证 = 单 API Key | `Authorization: Bearer <ADMIN_KEY>`；去掉 Cloudflare Access。Header 不是 Cookie，天然免 CSRF。 |
| 7 | 节点认证 = bearer token | 保持 32 字节随机 + SHA-256 哈希存储，按节点隔离。 |
| 8 | 一个主密钥 | `KEY_SECRET` 同时封装 REALITY 私钥、证书私钥、ACME account key；不再有 `REALITY_KEY_SECRET` / `ENVELOPE_KEY` 两套。 |
| 9 | 证书只走 Cloudflare DNS-01 | 不做 HTTP-01、不做其他 DNS provider、不做 RSA。ECDSA P-256。 |
| 10 | ACME profile = `tlsserver` | 默认；单域名可切 `classic` 作为 fallback。`shortlived` 不进 UI。 |
| 11 | staging 是 run 的属性，不是 Worker 的属性 | 没有 `ACME_DIRECTORY` var，没有 staging/prod 两套部署；线上面板里一个“测试签发”按钮走 LE staging。 |
| 12 | 证书续期只 reload nginx | 不重启 Xray；证书文件按域名的稳定路径写入，nginx 配置引用 `current` 符号链接。 |
| 13 | 订阅 = base64(vless://...\n...) | 已有实现；不做 Clash v1。 |
| 14 | R2 保留到 P1 | 直接复用 certworker 已验证的 R2 存储；D1 合并是 P2 可选，不阻塞上线。 |
| 15 | nginx 配置 P1 手工片段，P2 再面板托管 | P1 只自动投递证书 + reload；假站点配置很小且很少变。 |
| 16 | 不做企业级安全 | 不做 Access、mTLS、HMAC、rate limit、audit、per-key scope。API Key + 节点 token + HTTPS 是 v1 的边界。 |

---

## 2. 源仓库与复制策略

### 2.1 源仓库（只读）

| 仓库 | 用途 | 绝不修改 |
|---|---|---|
| `C:\Users\dev\Documents\GitHub\Lesserv-Cloud` | Worker、前端、迁移、测试、渲染核心 | 是 |
| `C:\Users\dev\Documents\GitHub\Lesserv-Agent` | Python agent、systemd、安装脚本、测试 | 是 |
| `C:\Users\dev\Documents\GitHub\ssl-cert-worker` | ACME/DNS-01/证书存储/Workflow 测试 | 是 |

源仓库的 `.git`、工作区、依赖目录都不动。需要修的地方一律在 LessV 的副本里改。源仓库保留到 P1 验收完成后再归档。

### 2.2 复制映射

| 从 | 到 LessV | 说明 |
|---|---|---|
| `Lesserv-Cloud/src` | `src/` | 核心；保留 core/services/routers/db/models |
| `Lesserv-Cloud/frontend` | `frontend/` | SPA；不含 `node_modules`、`dist` |
| `Lesserv-Cloud/migrations` | `migrations/` | 0001–0004；后面追加证书迁移 |
| `Lesserv-Cloud/tests` | `tests/` | 纯测试 + workerd 测试 + fixtures |
| `Lesserv-Cloud/{package.json,package-lock.json,tsconfig.json,vitest.config.ts}` | 根目录 | 合并依赖；不要复制 `worker-configuration.d.ts`（重新生成） |
| `Lesserv-Cloud/scripts` | `scripts/` | 确保 wrangler 配置、stub 前端等 |
| `Lesserv-Cloud/wrangler.example.jsonc` | `wrangler.example.jsonc` | 改造成 LessV 的绑定；不要复制 `wrangler.jsonc` |
| `Lesserv-Agent/lesserv_agent` | `agent/lessv_agent` | 改包名、路径、协议字段 |
| `Lesserv-Agent/{install.sh,systemd,tests}` | `agent/` | 改 unit 名、路径、安装方式 |
| `ssl-cert-worker/src/acme` | `src/cert/acme` | ACME client/JWS/DNS-01 |
| `ssl-cert-worker/src/dns` | `src/cert/dns` | Cloudflare DNS API |
| `ssl-cert-worker/src/issue` | `src/cert/issue` | Workflow、steps、cron、sweeper |
| `ssl-cert-worker/src/crypto/{base64url,csr,certificate,keys,pem,envelope}` | `src/cert/crypto` | 证书/CSR/密钥；envelope 只作参考，统一用 LessV 的 `key_cipher` |
| `ssl-cert-worker/src/store/{r2,d1}` | `src/cert/store` | 只取证书相关的 store |
| `ssl-cert-worker/test/*` | `tests/cert/` | 只取 ACME/DNS/JWS/CSR/证书/store/workflow 相关测试 |

### 2.3 明确不复制

- `Lesserv-Cloud/{AGENTS.md,ARCHITECTURE.md,PLAN.md,WORKBOOK.md,docs/}`：只作为参考阅读，不进 LessV。
- `Lesserv-Agent/{AGENTS.md,ARCHITECTURE.md,PLAN.md}`：同上。
- `ssl-cert-worker/{src/admin,src/auth,src/nodes,src/index.ts,web/,agent/,PLAN.md,README.md}`：认证/管理/独立 SPA/独立 node API 全部重写或不要。
- `ssl-cert-worker/wrangler.jsonc` 的 staging/prod 双环境：不要。
- 任何 `node_modules`、`.wrangler`、`dist`、`worker-configuration.d.ts`。

### 2.4 复制后的第一件事

1. `npm install`（根 + frontend）。
2. 全仓库搜索 `lesserv` / `Lesserv` / `REALITY_KEY_SECRET` / `ENVELOPE_KEY` / `Access` / `access`，区分“需要改的名字”和“历史注释”。
3. 跑一遍 `npm test`，确认复制后的基线是绿的，再开始改。
4. 不要复制后立刻重构；先让测试说话。

---

## 3. 目标仓库结构

```
LessV/
  src/
    main.ts                 Hono app；路由 + admin key 中间件
    worker.ts               default fetch + scheduled + Workflow export
    env.ts                  密钥绑定读取（KEY_SECRET）
    crypto.ts               AES-GCM / base64
    db.ts                   核心 SQL（nodes/users/access/keys/profiles）
    models.ts               Zod / API 形状
    route_groups.ts         四组 fail-closed 路径
    core/                   allocator / python_json / python_uri / x25519
    services/               render / config / qualify / reality / link /
                            link_profile / labels / share / subscription /
                            user / node / node_state / node_token / cert_lint
    routers/                admin_nodes / admin_users / admin_reality /
                            admin_link_profiles / admin_certs / node / sub / health
    auth/admin_key.ts       管理员 key 中间件 + 常量时间比较
    cert/
      acme/                 client / dns01 / errors / jws
      dns/                  cloudflare
      crypto/               base64url / csr / certificate / keys / pem
      issue/                workflow / steps / cron / trigger / sweeper / types
      store/                r2 / d1
      service.ts            证书业务（签发/测试签发/续期/分配/投递）
  frontend/                 React + Vite + Tailwind
    src/pages/              Login / Fleet / NodeConfig / NodeKeys /
                            NodeUsers / Certificates / NotFound
    src/components/         ...
  migrations/               0001–0004 + 0005_certs.sql (+ 0006 状态列)
  tests/                    workerd / pure / cert
  agent/
    lessv_agent/            client / loop / apply / certs / xray / config / state / stats
    systemd/lessv-agent.service
    install.sh
    tests/
  docs/PROTOCOL.md          节点协议 v2
  docs/OPERATIONS.md        nginx/证书/排障
  README.md                 部署 + 首节点 + 首用户 + 证书
  PLAN.md                   本文件
  package.json
  wrangler.example.jsonc
  .dev.vars.example
  .env.production.example
  scripts/
```

命名统一：

| 旧 | 新 |
|---|---|
| `lesserv-cloud` / `certworker` | `lessv` |
| `lesserv-agent` | `lessv-agent` |
| `lesserv_agent` | `lessv_agent` |
| `/etc/lesserv` | `/etc/lessv` |
| `/var/lib/lesserv` | `/var/lib/lessv` |
| `REALITY_KEY_SECRET` | `KEY_SECRET` |
| `ENVELOPE_KEY` | `KEY_SECRET` |

---

## 4. 拓扑与职责

```
client --REALITY--> Xray:443 --dest--> 127.0.0.1:8443 nginx (LE 证书 + 假站点)
                       │
                       └── 普通浏览器访问 443 时，REALITY 把握手转给 nginx，
                           看到的是真证书和假站点
```

| 组件 | 职责 | 不负责 |
|---|---|---|
| 面板（Worker + SPA） | 节点/用户/权限/REALITY 配置渲染、证书签发、证书分配、订阅 | 不碰 nginx 内容、不碰 Xray 进程 |
| agent（节点） | enroll/heartbeat/pull config、写证书文件、`nginx -t`/reload、应用 Xray、上报 | 不做授权决策、不渲染配置 |
| nginx | 8443 的假站点，只被 REALITY `dest` 访问 | 不反代 Xray、不终止代理 TLS |
| Xray | 443 的 REALITY inbound + 出站路由 | 不读证书 |

信任边界：

| 前缀 | 调用者 | 凭证 |
|---|---|---|
| `/api/admin/*` | 管理员 | `ADMIN_KEY` Bearer |
| `/api/node/*` | agent | 节点 token Bearer |
| `/sub/*` | 终端用户 | capability URL（256-bit sub_token） |
| `/api/health` | 任何人 | 无 |

---

## 5. 数据模型

### 5.1 保留（复制）

| 表 | 说明 |
|---|---|
| `nodes` | id/label/address/config_json/token_hash/applied_hash/last_seen/health/agent_version/xray_version/last_error/reported_address/created_at |
| `users` | username/status/expire/note/sub_token/created_at |
| `user_node_access` | username/node_id/allowed_inbounds/allowed_outbounds/uuids |
| `reality_keys` | node_id/inbound_tag/private_key(sealed)/created_at |
| `link_profiles` | 保留代码与表；v1 UI 隐藏（REALITY 不需要） |

### 5.2 新增

| 表 | 关键列 | 说明 |
|---|---|---|
| `cert_domains` | id, name, zone_id, include_wildcard, acme_profile, renew_before_days(null=按寿命算), status, last_error, created_at, updated_at | 签发单元；`name=example.com` 或 `*.example.com`；SAN 由 name + wildcard 派生 |
| `certificates` | id, domain_id, environment, serial, fingerprint_sha256, sans_json, not_before, not_after, profile, is_current, r2_prefix, purged_at, created_at | `environment=production / staging`；唯一索引 `(domain_id, environment) WHERE is_current=1` |
| `acme_accounts` | environment PK, directory_url, account_url, private_key(sealed), public_jwk, thumbprint, updated_at | staging/prod 各自一个账户，绝不共用 |
| `issue_runs` | id, domain_id, environment, trigger, status, phase, error, workflow_id, started_at, finished_at, steps_json, created_at | `trigger=renew / manual / test`；错误原样保留 |
| `challenge_records` | id, run_id, zone_id, cf_record_id, name, value, created_at, deleted_at | TXT 清理/sweeper 内部使用，不对外暴露 |
| `node_cert_domains` | node_id, domain_id, assigned_at | **按 domain 分配，不按 cert id**；续期后自动指向新的 production current |
| `nodes` 追加列 | nginx_ok, nginx_error, cert_etag, cert_synced_at | agent 上报；fleet 显示 |
| `nodes.nginx_config` | TEXT（P2 才加） | 面板托管 nginx 配置时使用 |

### 5.3 不做

`config_versions`、`node_stats`、`audit_log`、`cert pull_events`、`api_keys`（CertWorker 的每节点 key）、`key scopes`。v1 不需要。

### 5.4 证书存储

- 元数据在 D1；证书/链/私钥在 R2。
- 路径：`certs/<environment>/<domain>/<cert-id>/`，包含 `cert.pem`、`chain.pem`、`fullchain.pem`、`privkey.pem.enc`、`meta.json`。
- `privkey.pem.enc` 用 `KEY_SECRET` 封装；`fullchain.pem` 明文。
- 先写 R2，再翻 D1 的 `is_current`；崩溃不会留下“current 指向不存在文件”。
- staging 测试证书同样存 R2，但**永不进入 node 投递**。
- ACME account key 存在 `acme_accounts.private_key`（D1，sealed），不再用 R2 的 `acme/<env>/` 路径；证书产物仍在 R2。

---

## 6. API 与协议

### 6.1 管理员 API（`/api/admin/*`，全部要 `ADMIN_KEY`）

保留现有：

- `GET/POST /nodes`；`GET/PUT /nodes/:id`；`POST /nodes/:id/token`
- `GET/PUT /nodes/:id/config`；`GET /nodes/:id/config/runtime`；`GET /nodes/:id/sync`
- `GET /nodes/:id/inbounds`；`GET /nodes/:id/outbounds`
- REALITY keys：`GET /nodes/:id/reality`（列表）、`POST /nodes/:id/reality/rotate`（全部轮换）、`POST /nodes/:id/reality/:tag/rotate`（单个轮换；沿用现有形状）
- link profiles：保留接口，UI 隐藏
- `GET/POST /users`；`GET/PUT/DELETE /users/:username`；`POST /users/:username/sub-token`；`GET /users/:username/links`

新增：

| 方法 + 路径 | 用途 |
|---|---|
| `GET /api/admin/zones` | Cloudflare zone 列表（给 domain 选择器）。必须在 `/api/admin/*` 下：四组 fail-closed 守卫不允许第五个前缀，不为了一个端点放宽边界 |
| `GET/POST /api/admin/cert-domains` | 域名列表/创建 |
| `GET/PATCH/DELETE /api/admin/cert-domains/:id` | 详情/修改/删除（删除需确认）。删除**不做 ACME revoke**（§12 已排除 revoke UI）：有活动 run → 409；否则软删除 + 删除节点分配 |
| `POST /api/admin/cert-domains/:id/issue` | **生产**签发/重签 |
| `POST /api/admin/cert-domains/:id/test-issue` | **staging** 测试签发 |
| `GET /api/admin/cert-domains/:id/runs` | 该域名的 run 列表 |
| `GET /api/admin/cert-runs/:id` | run 详情（LE 错误原样） |
| `GET /api/admin/cert-domains/:id/certs` | production + staging 证书列表（带 test 标记） |
| `GET /api/admin/certificates/:id` | 证书详情（SAN/有效期/profile/environment） |
| `GET /api/admin/certificates/:id/download?file=fullchain`（或 `?file=key`） | 管理员下载（测试证书排障用） |
| `GET/PUT /api/admin/nodes/:id/cert-domains` | 给节点分配证书域名 |
| `GET /api/admin/nodes/:id/certs` | 节点已分配域名的当前生产证书摘要（含到期/nginx 状态） |

`GET /nodes/:id/sync` 的 warnings 追加证书 lint 结果（见 7.5）。

### 6.2 节点 API（`/api/node/*`，节点 token）

保留：

- `POST /enroll`
- `POST /heartbeat` → `{desired_hash, actions}`
- `GET /config?hash=...`
- `POST /report`
- `POST /stats`（保留端点；v1 不存储；agent 默认关闭）

新增：

| 方法 + 路径 | 用途 |
|---|---|
| `GET /api/node/certs` | 该节点分配的**生产**证书；返回 fullchain + 解封后的 key + ETag；`If-None-Match` → 304；`no-store` |

`GET /api/node/certs` 的 ETag 是“所有已分配 domain 的当前证书 fingerprint”的复合哈希；测试证书永远不出现。

`/report` 追加字段：

```json
{
  "stage": "cert",
  "nginx_ok": true,
  "nginx_error": null,
  "cert_etag": "…",
  "cert_synced_at": 1758000000
}
```

`stage: "cert"` 是必填的区分位：agent 在“配置未变但证书/nginx 状态变化”时用
它单独报告（例如 nginx 进程状态改变），服务端只更新 `last_seen` + 证书状态
列，不动 `applied_hash`/`health`/`last_error`。没有它就只能用 apply 成功报告
去伪造 Xray 状态。普通 apply report 也可以携带这些字段，服务端一并写入。

协议版本：`protocol: 2`。理由：新增证书端点 + 报告字段；没有已部署的旧 agent，
不需要兼容。

---

## 7. 关键设计

### 7.1 管理员认证

- `src/auth/admin_key.ts`：从 `Authorization: Bearer` 取 key，和 `env.ADMIN_KEY` 常量时间比较；失败 401 JSON。
- `app.use("/api/admin/*", adminKey)`；`/api/health`、`/sub/*`、`/api/node/*` 不经过。
- 路由守卫保留：四组之外 404。
- SPA：`LoginPage` 粘贴 key → 调 `GET /api/admin/nodes` 验证 → 存 `localStorage` → 之后所有请求带 header；401 清 key 回登录；logout 清 key。
- 不用 Cookie、不做 session、不做 CSRF token。
- 文档明确：`ADMIN_KEY` 等价于 root；`KEY_SECRET` 不可轮换（会锁死已封装的私钥）。
- 测试：所有 admin 测试的 helper 自动带 key；新增 401/no-key/错 key 的测试。

### 7.2 REALITY preset

前端弹窗，字段：

| 字段 | 默认 |
|---|---|
| 域名（`serverNames[0]`） | 节点 `address` |
| nginx 端口 | `8443` |
| shortId | 随机 8 位 hex |
| flow | `xtls-rprx-vision` |

生成附录 A 的 JSON。面板不解析；保存后走现有渲染：

- `buildConfig` 填 `clients` + routing rules；
- `ensureKeys` 生成并存储 `privateKey`；
- `applyRealityKeys` 注入 `privateKey`；
- `share_service` 生成 `pbk`/`sni`/`sid`/`spx`/`flow` 链接。

预设只生成一个 inbound + `BLOCK` + `direct`。外部 exit 由管理员编辑 JSON 添加，解耦模型不变。

如果节点地址为空或是 IP：preset 明确警告“自偷需要一个域名 + 证书”；不阻止保存，但不建议。

### 7.3 ACME 与测试签发

**目录常量，不是 Worker 变量：**

```ts
const ACME_DIRECTORIES = {
  production: "https://acme-v02.api.letsencrypt.org/directory",
  staging:    "https://acme-staging-v02.api.letsencrypt.org/directory",
} as const;
```

**两个动作：**

- `POST /cert-domains/:id/issue` → `environment=production`
- `POST /cert-domains/:id/test-issue` → `environment=staging`

**账户/当前指针分离：**

- `acme_accounts` 按 environment 一行；首次签发时创建；staging/prod 不共用 key/URL。
- `certificates` 按 `(domain_id, environment)` 各有一个 current。
- 测试签发只翻 staging current；production current 不动。
- `node_cert_domains` 只影响 production 投递；测试证书不可分配给节点。
- 生产 cron 只扫 `environment='production'`；测试证书不续期。
- 测试证书保留最近一份、最长 7 天；被取代的和超过 7 天的由 sweeper 清理；run 日志保留 30 天。

**并发：**

- 锁按 domain，不按 environment。`_acme-challenge.<domain>` TXT 名字相同，staging 和 production 同时跑会互相覆盖。
- 已有 run 时，测试按钮返回“该域名有 run 正在进行”，不排队。

**profile：**

- `cert_domains.acme_profile` 默认 `tlsserver`；UI 可切 `classic`。
- `newOrder` 带 `profile`；先检查 `directory.meta.profiles`；不支持就报错，不静默降级。
- `tlsserver` 事实：45 天、无 CN/SKI/keyEncipherment/clientAuth EKU、pending authz 1 小时、authz reuse 7 小时、order 8 小时、最多 25 个名字。LE staging 和 production 都广告 `tlsserver`。
- 续期按实际寿命的 1/3：`renew_at = not_after - max(1, floor((not_after - not_before) / 3))`。45 天 → 提前 15 天；90 天 → 提前 30 天。
- order/authz 过期时重新开 order，不复用；run 记录 phase。

**测试签发 UI：**

- 证书页两栏：Production / Test (staging)。
- 测试按钮不需要输入域名确认；生产重签需要输入域名确认。
- 测试证书显示 `STAGING — NOT TRUSTED`；可下载；不显示在节点分配列表。
- 测试 run 的 LE 错误原样展示。

### 7.4 证书投递 + nginx

**文件路径（稳定）：**

```
/etc/lessv/certs/<domain>/current/fullchain.pem
/etc/lessv/certs/<domain>/current/privkey.pem
```

`<domain>` 是证书域（如 `example.com`），不是节点地址。路径名用 `certPathName`：
lowercase；wildcard 域 `*.example.com` → `wildcard.example.com`（`*` 不允许进
nginx 路径/命令行），其余原样（已由 `normalizeDomainName` 限定字符）。

**agent 流程：**

1. 每个 loop 在 heartbeat 后调 `GET /api/node/certs`；带 `If-None-Match`；304 直接跳过。
2. 对每个证书：写 `<domain>/<fingerprint>/fullchain.pem`（0644）和 `privkey.pem`（0600；可选 group），然后原子切换 `current` 符号链接。
3. 全部写完后 `nginx -t`；失败则把所有 `current` 切回旧版本，再 `nginx -t`，上报失败。
4. nginx **active 时 `systemctl reload nginx`；inactive 时 `systemctl start nginx` 后再验证**（inactive 的 unit 上 reload 会失败，“停 nginx 后恢复自动好转”的验收项才能成立）；上报 `nginx_ok`/`nginx_error`/`cert_etag`。
5. 证书失败不阻塞 Xray 配置 apply；报告分别记录。
6. 首次运行如果 nginx 配置已经引用了不存在的 `current`，`nginx -t` 会失败；安装文档要求先让 agent 同步证书，再启用 nginx site。
7. `state.json` 增加 `last_nginx_ok`；304 时只做 nginx active 检查，状态变化才报告（stage=cert），避免每 30s 写库。

**测试证书保留（staging）：**

- staging 只保留 current；非 current 立即由 sweeper 清（R2 + 行删除）；current 超过 7 天也清（R2 + 行）。
- production 非 current 只清 R2，保留 D1 行（`purged_at`）；current 不清理。

**权限：**

- nginx master 以 root 读 key；`privkey.pem` 0600 root 足够。
- 如果 nginx 以非 root 运行，`agent.toml` 增加 `cert_group`，设为 nginx 组，文件 0640。

**续期：**

- 面板签发新证书 → production current 更新 → 节点 ETag 变化 → agent 写新版本 + 切 symlink + reload。
- Xray 不重启；REALITY 连接不断。
- nginx reload 是 graceful 的；旧 worker 完成现有连接。

**nginx 配置：**

- P1 手工片段（附录 B），引用 `current` 路径。
- P2 可选：`nodes.nginx_config` + agent 写 `/etc/nginx/conf.d/lessv.conf` + `nginx -t` + reload + 回滚 + 上报 `nginx_hash`。
- 假站点内容在 `/var/www/lessv-decoy`，由管理员提供；`install.sh` 创建目录和一个占位 `index.html`。

### 7.5 证书 lint

在 `sync`（fleet）和节点页返回 warnings：

- REALITY inbound 的 `serverNames` 为空 → 警告。
- `serverNames` 中任一名字不被“已分配域名的 production current 证书”的 SAN 覆盖 → 警告。
- `dest` 不是 `127.0.0.1:<port>` → 警告（A 拓扑的自偷预期是 loopback；不阻止其他用法）。
- `shortIds` 为空或不是偶数长度 hex → 警告。
- 已分配证书 `not_after < now` → 错误级；`< 7 天` → 强警告；`< 15 天` → 提示（cron 会续）。
- 节点 `nginx_ok = false` → 警告。
- 测试证书不参与 lint。

lint 只读，不改变渲染，不阻塞保存。

### 7.6 订阅

- 保留现有 `sub_token` + `/sub/{token}` + base64 链接。
- REALITY 链接由 `share_service` 生成；preset 保证 `pbk`/`sni`/`sid`/`spx`/`flow` 齐全。
- 管理员链接接口和订阅共用 `link_service.userLinks`。
- v1 不做 Clash/mihomo、不做 `subscription-userinfo` 头。

---

## 8. 工作分解

### P0 — 复制、删 Access、管理员 Key、部署

**任务**

1. 在 LessV 里建立目录；按 §2.2 复制 Worker/前端/迁移/测试/agent；不复制 `node_modules`、`dist`、`wrangler.jsonc`。
2. 改名：package、worker、D1、agent 包、systemd、路径、文档中的 `lesserv`；`REALITY_KEY_SECRET` → `KEY_SECRET`。
3. 删除 Access 相关内容：文档、SPA 的 “session expired” 文案、部署配置；不引入 JWT。
4. 加 `ADMIN_KEY` 中间件 + SPA 登录 + API client header + 401 处理；更新测试 helper。
5. 删掉旧文档（AGENTS/ARCHITECTURE/PLAN/WORKBOOK/docs），新建 README 骨架；`PLAN.md` 保留。
6. `wrangler.example.jsonc`：worker `lessv`、自定义域、D1、assets、secrets（`ADMIN_KEY`/`KEY_SECRET`）；**先不加** R2/Workflows/cron（P1b 加）。
7. `scripts/deploy`：构建前端 → `wrangler deploy` → `wrangler d1 migrations apply DB --remote` → health 检查；首次部署支持 `--secrets-file`。
8. 跑基线测试；修复制导致的 import/名字问题。

**完成标准**

- `npm test`、`npm run typecheck`、`npm run build`、`npm --prefix frontend test`、`npm --prefix frontend run build` 全绿。
- `agent/` 的 pytest 绿（E2E 可 skip）。
- Worker 部署到自定义域；D1 迁移完成；`/api/health` 200。
- 浏览器打开 `/admin`，粘贴 `ADMIN_KEY`，能登录、建节点、拿 token。
- 源三个仓库 `git status` 干净。

### P1a — 节点 onboarding + 订阅（临时公网 dest，验证基础链路）

**任务**

1. agent 安装：把 `install.sh` 做成可发布的 tarball；`--cp`/`--node`，token 从 stdin；检查 python3/systemd/xray；创建 `/etc/lessv`、`/var/lib/lessv`、`/etc/lessv/certs`、`/var/www/lessv-decoy`；写 `agent.toml` 0600；systemd enable。
2. 用裸 JSON 编辑器粘贴一份**临时** REALITY 配置：`dest`/`serverNames` 用公网站点（如 `www.microsoft.com:443`），节点地址用 IP/域名；这份配置不进入 preset/UI，P1b 删除。
3. 订阅链接在真实客户端导入（v2rayN/NG、Shadowrocket、NekoBox 或 Hiddify 至少一个）。
4. README 写“首节点”流程：Xray → agent → 临时 REALITY 配置 → 用户 → 订阅。
5. 测试：REALITY 链接参数、agent E2E（本地 plane，nginx/cert 不参与）。

P1a 只验证面板/agent/订阅；公网 dest 是开发夹具，不是用户模式。产品拓扑（自偷 + LE）在 P1b 验收。

> **状态（2026-10-25）：完成。** 面板部署在 `cp.example.com`（合并 P0 云端项）；
> Linode 两台（server 保留 / client 探针后删除）实测通过，含自动化探针、重启
> 收敛、禁用/过期。人工真实客户端导入交付给用户，后置不阻塞。执行细节见
> `P1A-PLAN.md` 执行记录与附录 E。

**完成标准**

- 一台真实 Linux 节点：安装 agent、enroll、应用 REALITY 配置；fleet 显示 applied = desired。
- 订阅链接能连上并上网。
- agent 重启、Xray 重启、面板重启后能收敛。
- 测试全绿。

### P1b — REALITY preset（自偷）+ ACME、测试签发、证书投递、nginx reload

**任务**

1. 前端 REALITY preset 弹窗 + 节点页按钮；生成附录 A（`dest=127.0.0.1:8443`）；保存后走现有渲染/密钥/链接管线。
2. 迁移：`cert_domains`、`certificates`、`acme_accounts`、`issue_runs`、`node_cert_domains`；`nodes` 加 `nginx_ok`/`nginx_error`/`cert_etag`/`cert_synced_at`。
3. 复制 certworker 的 ACME/DNS-01/证书/Workflow/R2 代码；合并 vitest 配置（R2/Workflows）；合并依赖（`@peculiar/x509`、`@abraham/reflection`；**不引入 `jose`**——它只属于已删除的 Access，ACME 全部用 WebCrypto/JWS 自实现）。ACME account key 改存 `acme_accounts`（D1，sealed），不再用 R2 的 `acme/<env>/` 路径。
4. 目录常量 + environment 维度；`acme_accounts` 分环境；`certificates` current 分环境；`issue_runs.environment`；`test-issue`。
5. `tlsserver` profile；`newOrder` 带 `profile`；校验 `meta.profiles`；1/3 寿命续期；order/authz 过期处理；每日 cron 只跑 production。
6. 证书管理页：zone 选择、域名 CRUD、生产签发、测试签发、runs、证书列表、下载、节点分配、到期显示。
7. 节点证书端点 + agent cert sync + nginx test/reload/回滚 + 报告；`agent.toml` 新增 `manage_nginx`/`cert_dir`/`nginx_service`/`cert_group`；`state.json` 新增 `cert_etag`。
8. 证书 lint 接入 sync；fleet 显示证书到期/nginx 状态。
9. 用 LE production 证书 + 自偷 nginx 替换 P1a 的临时公网 dest；nginx 片段引用 `current` 路径；`serverNames` 切到节点域名。
10. 测试：ACME 单测（mock）、测试签发不影响 production current、测试证书不投递、节点隔离、agent 证书回滚、E2E。
11. 文档：证书/测试签发/nginx 排障。

**完成标准**

- REALITY preset 保存；30 秒内 applied = desired；`serverNames` 被已分配证书覆盖。
- 线上面板“测试签发”成功（LE staging）；测试证书标记 untrusted；production current 不变；测试证书不在节点投递里。
- 生产签发 `tlsserver` 成功；分配给节点；agent 写入；`nginx -t`/reload 成功。
- `curl https://<domain>` 返回假站点，证书有效（无需 `-k`）。
- REALITY 客户端继续可用；订阅不变。
- 强制续期：nginx reload，`curl` 仍有效，Xray 进程未重启。
- 停 nginx：fleet 显示错误；恢复后自动好转。
- 证书 lint：`serverNames` 不被证书覆盖时报警。
- 测试全绿。

### P1c — 文档、发布、真实验收

**任务**

1. README：部署、D1/R2、secrets、首节点、证书、测试签发、用户/订阅、排障。
2. `docs/OPERATIONS.md`：nginx/假站点/证书路径/续期/回滚/日志。
3. `docs/PROTOCOL.md` v2：节点端点、证书端点、报告字段、错误、版本。
4. agent release tarball + 安装说明。
5. 在全新 VPS + 全新域名上跑一遍验收清单。
6. 归档三个源仓库（不删除）；更新 `PLAN.md` 状态。

**完成标准**

- 验收清单全部通过。
- 新机器按 README 从零到“客户端能上网”不超过 30 分钟（不含 Xray 安装时间）。
- 源仓库未被修改。

### P2 — 可选，不进 v1

- 面板托管 nginx 配置（opaque artifact + agent apply）。
- TLS/WS/xhttp 模板（B 拓扑）加回来。
- Clash/mihomo 订阅。
- stats/quota。
- D1 合并证书存储（去掉 R2）。
- 到期通知（邮件/Telegram）。
- 多管理员。

---

## 9. 测试策略

| 层 | 来源 | 新增 |
|---|---|---|
| Worker workerd | Lesserv-Cloud 236 | admin key、证书 API、测试签发隔离、节点证书隔离、lint |
| 纯逻辑 | Lesserv-Cloud core | preset 生成（前端）、证书覆盖匹配、续期窗口 |
| 前端 | Lesserv-Cloud | 登录、preset、证书页、lint 显示 |
| CertWorker | 219 | environment 维度、staging/prod account、test current 不冲突 |
| Agent | Lesserv-Agent 33 | cert fetch、文件原子写、symlink 回滚、nginx mock、报告字段 |
| E2E | Agent 的 plane E2E | 本地 `wrangler dev` + agent + fake cert endpoint；真实 VPS 手工验收 |

工具链前置：先把 `@cloudflare/vitest-plugin` 升到 `^1.3.3`、`wrangler` 到
`^4.144.0`（P1b.0 做）。旧 plugin（1.1.13）没有 `introspectWorkflowInstance`，
Workflow 步骤测试无法移植。

规则：

- CI 不碰 LE production。ACME 测试用 mock；staging 测试手工在线上面板点。
- 每个 phase 结束跑全部测试；P1b 的证书测试必须先绿再上真实域名。
- 不为了测试通过而放宽生产逻辑；测试 helper 适配 auth，不改业务规则。

---

## 10. 部署与运维

**绑定（P1b 完成后）：**

```jsonc
{
  "name": "lessv",
  "main": "src/worker.ts",
  "routes": [{ "pattern": "cp.example.com", "custom_domain": true }],
  "d1_databases": [{ "binding": "DB", "database_name": "lessv", "migrations_dir": "migrations" }],
  "r2_buckets": [{ "binding": "CERTS", "bucket_name": "lessv-certs" }],
  "workflows": [{ "name": "lessv-cert-issuance", "binding": "ISSUANCE", "class_name": "CertificateWorkflow" }],
  "triggers": { "crons": ["17 3 * * *"] },
  "assets": { "directory": "./frontend/dist", "not_found_handling": "single-page-application" },
  "secrets": { "required": ["ADMIN_KEY", "KEY_SECRET", "CF_DNS_API_TOKEN"] }
}
```

**首次部署：**

1. `npx wrangler r2 bucket create lessv-certs`
2. 生成 `ADMIN_KEY`（32 字节 base64url）、`KEY_SECRET`（32 字节 base64）
3. `CF_DNS_API_TOKEN`：`Zone:DNS:Edit` + `Zone:Zone:Read`，只给目标 zone
4. `npm --prefix frontend run build`
5. `npx wrangler deploy --secrets-file .env.production`
6. `npx wrangler d1 migrations apply DB --remote`
7. `curl https://cp.example.com/api/health`
8. 打开 `/admin`，粘贴 `ADMIN_KEY`

注意：本地 `wrangler.jsonc` 是 gitignored 的，必须手动写入远程
`database_id`（否则 `d1 migrations apply DB --remote` 找不到库）；
`wrangler.example.jsonc` 只保留结构，不写 id。

**本地开发：**

- `.dev.vars`：`ADMIN_KEY`、`KEY_SECRET`、`CF_DNS_API_TOKEN`。
- `npm run dev` + `npm --prefix frontend run dev`。
- 本地“测试签发”也走 LE staging；会写真实 DNS TXT，测试后清理。

**运维：**

- 证书过期/续期失败：证书页 + fleet；run 的 LE 错误原样。
- nginx 失败：节点 `nginx_error`；agent 回滚；`journalctl -u lessv-agent`。
- Xray 失败：现有 `last_error` / `last_good`。
- 证书文件：`/etc/lessv/certs/<domain>/`；日志在 agent journal。
- 不要手动改 `current` 符号链接；让 agent 管理。

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| CertWorker 移植到 LessV 的 Env/存储/Workflow 不匹配 | P1b 延期 | 先复制测试，让 219 个测试在 LessV 里绿，再接 UI；不要同时改存储 |
| `tlsserver` 45 天 + 1 小时 authz | 续期频繁、order 易过期 | 1/3 寿命续期；order 过期重开；staging 全流程先跑 |
| 测试签发与生产签发共用 `_acme-challenge` | TXT 冲突 | 锁按 domain；UI 显示“已有 run” |
| nginx 权限/`nginx -t` 失败 | 证书不生效 | agent 版本目录 + symlink 回滚；`cert_group`；P1 手工验收 |
| REALITY `serverNames`/证书不匹配 | 假站点证书错/伪装失败 | lint；`curl` 验收；preset 从节点地址生成 |
| agent 安装包/路径改名遗漏 | 节点装不上 | P1a 在全新 VPS 验收；安装脚本检查 Xray/nginx/python3 |
| Admin key 泄露 | 全节点失守 | 32 字节随机；只走 HTTPS；不写日志；可轮换 `ADMIN_KEY`；`KEY_SECRET` 不轮换 |
| 订阅客户端不兼容 | 用户导入失败 | P1a 用真实客户端验收；链接参数逐项对照 |
| 复制后旧测试大面积失败 | 进度受阻 | P0 先让基线绿；失败只改副本；不放松断言 |
| 文档再次膨胀 | 重蹈覆辙 | 只允许 README + PROTOCOL + OPERATIONS；行为变更同 commit 更新 |

---

## 12. 明确不做

- B 拓扑（nginx TLS 终止 + WS/xhttp 反代）。
- TLS/WS/xhttp 模板、`primary` link profile、CDN fronting。
- Cloudflare Access / JWT / 多管理员。
- staging/prod 两套 Worker、D1、R2、Workflow。
- 审计、pull log、rate limit、per-key scope、证书 revoke UI。
- 流量统计、配额、在线用户、到期邮件。
- HMAC、agent 自更新、docker restart mode、配置历史/回滚。
- typed inbound/outbound 数据库模型。
- 从头重写 Worker、渲染、agent。

---

## 13. 默认项 / 待确认

以下是计划采用的默认值；如果不同意，在 P0 开始前改：

1. **证书存 R2**（复用 certworker 代码），D1 合并放 P2。
2. **nginx P1 手工片段**，P2 再面板托管。
3. **测试证书保留最近一份、最长 7 天 + 可下载**；run 日志 30 天。
4. **生产重签要输入域名确认**；测试签发不需要。
5. **ADMIN_KEY 存 localStorage**；提供 logout；不做 sessionStorage 切换。
6. **保留 `/api/node/stats` 端点但不上报/不存储**；agent 默认关闭。
7. **agent 包名/路径统一改为 `lessv_agent` / `/etc/lessv` / `/var/lib/lessv`**。
8. **协议版本 `protocol: 2`**。节点身份头改为 `X-Lessv-Node`，随协议在 P1b 同批改名（P0 保持 `X-Lesserv-Node` 不变）。旧 agent 不兼容；部署后立即升级节点 agent。
9. **`KEY_SECRET` 统一封装** REALITY + 证书 + ACME account key。
10. **`node_cert_domains` 按域名分配**，不按 cert id；续期自动生效。

---

## 14. 验收清单

### P0

- [x] 面板部署在自定义域；`/api/health` 200。（云部署可与 P1a 合并）
- [x] 无 Access；未带 key 的 `/api/admin/*` 返回 401。
- [x] 粘贴 `ADMIN_KEY` 能登录；刷新保持；logout 清除。（机制：本地 curl + auth 单测；浏览器视检待云部署后）
- [x] 创建节点、拿 token、看 fleet。（本地 wrangler dev 实测）
- [x] 全部测试/类型检查/构建绿。
- [x] 三个源仓库未被修改。

### P1a

- [x] 全新 VPS 按 README 安装 Xray + agent。（Linode Debian 12；P1a.1 加固后的 install.sh + release tarball）
- [x] agent enroll；fleet 显示健康。（state=active，last_seen 更新，health ok）
- [x] 临时 REALITY 配置（公网 dest）保存；30 秒内 applied = desired。（首次实陈 60–90s；实测 t+10s 内，另见 P1A-PLAN 附录 E）
- [x] 订阅 URL 导入真实客户端，能上网。（自动化探针：第二台 VPS 上真实 Xray 客户端，出口 IP = 节点；人工真实客户端导入交付给用户后置）
- [x] agent/Xray/面板重启后收敛。
- [x] 用户禁用/过期后订阅为空。（禁用还从配置移除且探针失败；过期仅订阅为空，V8）

（preset / 自偷 / LE 证书在 P1b 验收。）

### P1b

- [ ] REALITY preset（自偷）保存；30 秒内 applied = desired。
- [ ] “测试签发”成功；测试证书标 staging；production current 不变。
- [ ] 测试证书不在节点分配列表、不出现在 `/api/node/certs`。
- [ ] 生产签发 `tlsserver` 成功；节点分配；agent 写入；nginx reload。
- [ ] `curl https://<domain>` 返回假站点，证书有效。
- [ ] REALITY 客户端继续可用；订阅不变。
- [ ] 强制续期：nginx reload；`curl` 有效；Xray 未重启。
- [ ] 停 nginx：fleet 显示错误；恢复后自动好转。
- [ ] `serverNames` 不被证书覆盖时 lint 报警。
- [ ] 证书到期/续期失败在面板可见。

### P1c

- [ ] README 从零到可用 ≤ 30 分钟（不含 Xray 安装）。
- [ ] OPERATIONS/PROTOCOL 与实际一致。
- [ ] agent release 可下载安装。
- [ ] 全新 VPS + 全新域名完整验收。
- [ ] 源仓库归档，LessV 打 tag。

---

## 15. 执行规则

1. **源仓库只读**。所有修改在 LessV。需要对比时 `git -C <source> show`/`diff`，不 checkout、不 commit。
2. **先复制，再改**。复制后先跑测试，建立绿色基线；不要边复制边重构。
3. **保留测试**。旧测试是安全网；改名后修 import，不放宽断言。
4. **一次只改一件事**。移植证书时不要同时把 R2 换 D1；改 auth 时不要同时动渲染。
5. **每个 phase 一个 commit**，commit message 用 `P0: ...` / `P1a: ...`。
6. **文档最小化**。只维护 README、PROTOCOL、OPERATIONS；不写 ARCHITECTURE/WORKBOOK/M*-PLAN。
7. **不扩大范围**。P1 只做 A + REALITY + 证书 + 订阅；B、stats、Clash 全部 P2。
8. **真实验收优先**。P1b 的“完成”以真实域名、真实客户端、真实 nginx/Xray 为准，不以单测为准。
9. **`PLAN.md` 是执行源**。范围变化先改本文件，再改代码。
10. **源仓库归档**。P1c 完成后把三个源仓库设为 archived；LessV 成为唯一活跃仓库。

---

## 附录 A — REALITY preset JSON

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
          "dest": "127.0.0.1:8443",
          "serverNames": ["tokyo01.example.com"],
          "privateKey": "",
          "shortIds": ["a1b2c3d4"],
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

面板渲染时填 `clients` 和 `privateKey`；`shortIds`/`serverNames`/`dest` 由 preset 固定，管理员可改。

---

## 附录 B — nginx 假站点片段

```nginx
server {
    listen 127.0.0.1:8443 ssl;
    server_name tokyo01.example.com;

    ssl_certificate     /etc/lessv/certs/example.com/current/fullchain.pem;
    ssl_certificate_key /etc/lessv/certs/example.com/current/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root  /var/www/lessv-decoy;
    index index.html;

    location / {
        try_files $uri $uri/ =404;
    }
}
```

P1a 不接 nginx；P1b 直接用上面的 `current` 路径 + LE 证书。若想提前手工验证 nginx，可以临时把 `ssl_certificate` 指向一张自签证书，但那不是产品路径。

---

## 附录 C — `agent.toml` 新增字段

```toml
# 现有
poll_interval = 30
xray_binary = "xray"
config_path = "/var/lib/lessv/config.json"
xray_service = "xray"
restart_mode = "systemd"

# 新增
manage_nginx = true
cert_dir = "/etc/lessv/certs"
nginx_service = "nginx"
# cert_group = "www-data"   # nginx 非 root 时设置
```

---

## 附录 D — 关键状态机

### 证书签发 run

```
queued -> dns_publish -> dns_wait -> accept_challenge -> await_authz
       -> finalize -> download -> store -> activate -> cleanup -> done
                                     ^ 失败：error（LE problem 原样）+ cleanup
```

- `activate` 只翻对应 `environment` 的 current。
- staging run 不写 production current。
- order/authz 过期 → 重新开 order，回 `dns_publish`（有次数上限）。

### agent cert sync

```
GET /api/node/certs (If-None-Match)
  -> 304: no-op
  -> 200: for each cert:
        write version dir (0644/0600)
        swap current symlink
     nginx -t
       -> ok: systemctl reload nginx; verify active; report ok
       -> fail: restore all symlinks; nginx -t; report error
```

---

## 附录 E — 时间估算

| 阶段 | 估算 | 主要不确定性 |
|---|---|---|
| P0 | 0.5–1 天 | 改名/复制导致的测试修复 |
| P1a | 1–2 天 | 真实 VPS 的 Xray/nginx/systemd |
| P1b | 2–4 天 | ACME 移植、tlsserver、nginx 权限/回滚 |
| P1c | 0.5–1 天 | 真实域名/客户端验收 |
| **合计** | **4–8 个专注日** | 证书链路是主要变量 |

---

## 附录 F — 源文档参考（只读）

- `Lesserv-Cloud/ARCHITECTURE.md`：渲染管线、数据模型、信任边界、订阅。
- `Lesserv-Cloud/docs/PROTOCOL.md`：节点协议基线（v1 → v2）。
- `Lesserv-Agent/ARCHITECTURE.md`：apply 序列、失败模式、启动修复。
- `ssl-cert-worker/PLAN.md`：ACME/DNS-01/Workflow 设计、staging 实测记录、免费计划限制。
- `ssl-cert-worker/README.md`：证书/密钥/ETag/续期行为。

这些只用于阅读和对照，不复制进 LessV 的文档体系。
