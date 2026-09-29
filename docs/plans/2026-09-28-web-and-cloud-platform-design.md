# OpenKoto 网页端重建与云端服务改造设计文档

> 日期：2026-09-28
> 状态：草案（待评审；§1.4 中的待决策项需在 P0 开工前确认）
> 范围：Cloudflare 云端服务（账号、同步、托管 AI、计费）、网页端重建、iOS / 桌面端接入改造、CLI / MCP / Skill / Agent
> 关联文档：`docs/plans/2026-07-15-ios-app-design.md`（§8 二/三期草案，本文即其落地版）、`docs/specs/vocabulary-srs-spec.md`（§8 云同步预留）

---

## 1. 背景与目标

### 1.1 现状

| 维度 | 桌面端 `textlingo-desktop/` | iOS / Mac Catalyst `openkoto-ios/` | 网页 / 云端 |
|---|---|---|---|
| 技术栈 | Tauri 2 + React 19 + Rust | SwiftUI + GRDB（OpenKotoKit） | 仓库内无 Web 应用代码；`koto_intro_web/` 为官网（Next.js，Vercel） |
| 存储 | 每实体一个 JSON 文件（`src-tauri/src/storage.rs`）；阅读进度在 localStorage | SQLite，迁移 v1–v11（`OKPersistence/AppDatabase.swift`） | — |
| 生词 / SRS | FSRS-6（`src-tauri/src/fsrs.rs`），复习事件按月 JSONL | FSRS-6（`OKSRS/FSRS.swift`），`review_log` 表；与桌面共享黄金用例 | — |
| 同步 | 无；仅 `.okdata` 单向导出给 iOS（`transfer_export.rs`） | CKSyncEngine + CloudKit 私有库（`OKPersistence/CloudKitSyncEngine.swift`），已有 `SyncEngine` 协议 | — |
| AI | BYOK，12 类 Provider；**API Key 明文存 `config.json`** | BYOK，同一 Provider 集合；Key 存 Keychain | — |
| 歌词 | 无专门实体，音视频 + SRT 当作文章处理 | 无专门实体；segment 已有 `start_time/end_time` | — |
| 账号 / 付费 | 无（旧外部后端 `src/lib/api.ts` 与 `backend_url/auth_token` 已于 2026-09-28 删除） | 无账号、无 StoreKit | 无 |

### 1.2 目标

1. **四端多端同步**：Windows / macOS / Linux 桌面、iOS / iPadOS / Mac Catalyst、网页，以自建云端替代 iCloud 作为主同步通道。
2. **网页端重建**：用户可以在浏览器里完成三大核心功能——**背单词（FSRS 复习）**、**小说 / 电子书阅读与翻译**、**歌词翻译与学习**。
3. **商业化基础设施**：OpenKoto 账号、两档会员、托管 AI 积分（仅供 OpenKoto 自身功能使用，**不做通用 API 中转**）、跨渠道支付（Web 支付 + App Store）。
4. **开发者 / Agent 生态**：`koto` CLI、MCP Server、Skill，让用户和 AI Agent 都能操作自己的学习数据（如 `koto lyrics translate song.lrc`）。

### 1.3 非目标（本期不做）

- 视频相关：视频导入、ASR 转写、KTV 导出、视频文件同步。
- PDF 保留版式翻译（`pdf-sidecar/`）上云。
- Android 客户端（协议需保证可接入，但不排期）。
- 多人协作 / 公开分享内容（小说版权风险，见 §12）。

### 1.4 已确认的决策（2026-09-28）

| # | 问题 | 结论 |
|---|---|---|
| D1 | 账号品牌 | 只做 **OpenKoto** 自己的账号，不做多产品统一平台；原 `orbit-platform/`（Aivofind 原型）已移除 |
| D2 | 域名 | **`openkoto.com`**（2026-09-29 由 `openkoto.app` 改定）：官网、文档、网页端与 API 全部由同一个 Worker 提供（`openkoto.com` + `/api/*`），`www` 跳转到根域名；完全不再使用 Vercel |
| D3 | 开源范围 | **全部开源**（含服务端、计费、托管 AI 转发逻辑）；密钥只存 Worker Secrets；提供自部署文档 |
| D4 | iCloud 去留 | **并存一个大版本**：设置中可选 iCloud / OpenKoto 云，提供一键迁移，下一个大版本移除 CloudKit |
| D5 | 免费用户同步 | **开放但限额**：生词 200 个；书籍 / 小说最多 5 本，单个文件 ≤ 10 MB；歌词见 §11.1 |
| D6 | 积分 | Plus 会员可单独充值积分；Pro 会员每月自带积分额度；积分只能用于 OpenKoto 内的功能 |
| D7 | 支付渠道 | **Creem**（网页，已开通）+ **App Store**；暂不接 Stripe 与国内支付 |
| D8 | 手机号登录 | 不做；邮箱验证码 + Apple 登录（+ Google / GitHub） |
| D9 | 旧外部后端（dify / novel-chat） | 已删除：`src/lib/api.ts`、`backend_url/auth_token` 配置及相关 UI 分支；网页抓取、阅读助手只走本地 / BYOK |
| D10 | `draft-ios/`、`draft-macos/`（Orbit Draft） | 已移除，与 OpenKoto 无关 |

### 1.5 设计原则

1. **本地优先，登录可选**：BYOK + 本地数据永久免费，不登录也能完整使用；登录只解锁同步、网页端、托管 AI。
2. **一个协议，四个客户端**：同步语义沿用 iOS 已落地的实现（整记录 payload、墓碑、复习事件重放），先写契约再写代码。
3. **不信任客户端时钟**：排序与冲突以服务端 revision + 混合逻辑时钟（HLC）为准（落实 iOS 设计文档 §8.1 的要求）。
4. **服务端是权益与额度的唯一真值**：点数、订阅必须等服务端结果；学习数据可乐观更新。
5. **能共享的逻辑放到 TypeScript core**：网页、CLI、MCP、桌面前端共用同一个 `@openkoto/core`，FSRS 直接使用上游 ts-fsrs 并以黄金用例校验。

---

## 2. 总体架构

### 2.1 架构图

```
 ┌────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────────┐
 │ iOS / Mac  │ │ 桌面 (Tauri) │ │  网页 (SPA)   │ │  koto CLI  │ │ MCP / 云端 Agent  │
 │  GRDB      │ │  SQLite      │ │  IndexedDB   │ │  (Node)    │ │                  │
 └─────┬──────┘ └──────┬───────┘ └──────┬───────┘ └─────┬──────┘ └────────┬─────────┘
       │ Bearer JWT    │ Bearer JWT     │ Cookie         │ Bearer/APIKey   │ OAuth/APIKey
       └───────────────┴────────────────┴───────┬────────┴─────────────────┘
                                                │ HTTPS  openkoto.com/api/*
                          ┌─────────────────────▼─────────────────────┐
                          │     API Worker（Hono + Better Auth）        │
                          │  auth · sync · ai · books · billing · keys │
                          └──┬──────────┬───────────┬──────────┬──────┘
                             │          │           │          │
                   ┌─────────▼──┐ ┌─────▼──────┐ ┌──▼───┐ ┌────▼──────────┐
                   │ D1 (全局)   │ │ UserVault  │ │  R2  │ │ Queues        │
                   │ 账号/会话   │ │ Durable    │ │ 书籍  │ │ 整本翻译       │
                   │ 订阅/点数   │ │ Object     │ │ 原文  │ │ 批量任务       │
                   │ API Key    │ │ (每用户一个 │ │ 附件  │ │ Webhook 重试   │
                   │ 设备/审计   │ │  SQLite)   │ │ 导出  │ └────┬──────────┘
                   └────────────┘ └────────────┘ └──────┘      │
                                                    ┌──────────▼──────────┐
                                                    │ AI Gateway → 模型供应商│
                                                    └─────────────────────┘
```

### 2.2 组件职责

| 组件 | 职责 | 选型理由 |
|---|---|---|
| **API Worker** | 唯一对外入口：认证、路由、限流、权益校验、把同步请求转发到用户的 DO | Hono 轻量、Better Auth 官方有 Hono 集成 |
| **D1（全局库）** | 用户、身份、会话/设备、订阅、支付事件、点数账本、API Key、审计 | 需要跨用户查询与后台管理的数据 |
| **UserVault（Durable Object，SQLite 存储）** | 每个用户一个实例，存全部同步记录与游标 | 单用户写入天然串行 → `server_seq` 单调递增无竞争；用户间隔离；不受单个 D1 容量上限约束 |
| **R2** | EPUB/TXT 原文件、超大 payload、导出包 | 零出口流量费，适合书籍分发 |
| **Queues** | 整本/多章节翻译、支付 webhook 重试、账号删除清理 | 超出单次请求时限的任务 |
| **AI Gateway** | 托管模型的转发、缓存、日志、限流 | 统一观测与供应商切换 |

### 2.3 仓库结构（新增部分）

在仓库根目录引入 pnpm workspace（`koto_intro_web/` 是独立仓库，不纳入）：

```
openkoto/
├── packages/
│   ├── core/            # @openkoto/core：类型、FSRS(ts-fsrs)、句子切分、Prompt 库、JSON 修复、LRC 解析
│   ├── sync-client/     # @openkoto/sync-client：协议类型 + TS 同步客户端（网页/CLI/桌面前端共用）
│   ├── api-client/      # @openkoto/api：/v1 类型化 SDK（由服务端 zod schema 生成）
│   └── ui/              # 从桌面前端抽出的可复用 React 组件（阅读器、复习卡片等）
├── apps/
│   ├── web/             # 网页端 SPA（Vite + React）
│   ├── cli/             # koto CLI
│   └── mcp/             # MCP Server（stdio 版；远程版由 server 托管）
├── server/
│   └── worker/          # Cloudflare Worker（Hono），含 DO、Queue consumer、D1 migrations
├── textlingo-desktop/   # 改为依赖 packages/*
├── openkoto-ios/        # Swift 侧按协议 spec 自行实现
└── docs/specs/
    ├── sync-protocol-spec.md   # 新增：同步协议契约（本文 §5 定稿后拆出）
    ├── auth-spec.md            # 新增：认证契约（本文 §4 定稿后拆出）
    └── fixtures/sync/          # 新增：跨端同步契约用例
```

账户中心（订阅、积分、设备、API Key）直接在 `apps/web` 内实现。

---

## 3. 服务端设计

### 3.1 Worker 路由总览

| 前缀 | 模块 | 说明 |
|---|---|---|
| `/api/auth/*` | Better Auth | 登录、登出、OAuth 回调、设备码、会话 |
| `/api/v1/me` | account | 当前用户、权益、点数余额、设备列表 |
| `/api/v1/sync/*` | sync | `pull` / `push` / `bootstrap` / `blobs` |
| `/api/v1/ai/*` | ai | 翻译、精讲、单词释义、聊天（SSE） |
| `/api/v1/jobs/*` | jobs | 长任务（整本翻译）创建、查询、取消 |
| `/api/v1/books/*` | books | 原文件上传（R2 预签名）、下载 |
| `/api/v1/keys/*` | keys | 用户 API Key 管理（供 CLI/Agent） |
| `/api/v1/billing/*` | billing | Checkout、订阅管理门户、权益查询 |
| `/api/webhooks/*` | billing | Creem webhook、App Store Server Notifications v2 |
| `/mcp` | mcp | 远程 MCP Server（Streamable HTTP + OAuth） |

所有 `/api/v1` 请求/响应以 zod 定义，生成 `@openkoto/api` 类型化 SDK 与 OpenAPI 文档。

### 3.2 D1 全局库表设计

认证相关表以 Better Auth 生成的 schema 为准，下表列出需要自定义或扩展的部分：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `user` / `account` / `session` / `verification` | Better Auth 标准 | `account` 存身份提供方（apple/google/github/email）与 subject |
| `device` | id, user_id, platform(ios/macos/windows/linux/web/cli), name, app_version, last_seen_at, revoked_at | 登录时创建；refresh token 与之关联 |
| `refresh_token` | id, device_id, token_hash, family_id, expires_at, rotated_at | 轮换制；检测到旧 token 复用 → 撤销整个 family |
| `api_key` | id, user_id, prefix, key_hash, scopes(json), name, last_used_at, expires_at, revoked_at | 明文只在创建时显示一次 |
| `plan` / `plan_entitlement` | plan_id(free/plus/pro), capability_key, limit | 单产品，不需要 product 维度 |
| `subscription` | user_id, plan_id, channel(stripe/creem/appstore), external_id(unique), status, period_end | 多渠道统一 |
| `payment_event` | channel, external_event_id(unique), payload_hash, processed_at | webhook 幂等 |
| `credit_ledger` | id, user_id, delta, reason(grant/reserve/settle/refund/expire), ref_id, balance_after, created_at | 只追加；余额 = 最新 balance_after |
| `usage_record` | request_id, user_id, feature, key_id, model, input_tokens, output_tokens, credits, status | **不存原文与 Prompt** |
| `job` | id, user_id, kind, status, progress, total, error, created_at | 长任务元数据（明细结果写入用户 DO） |
| `audit_event` | actor, action, target, created_at | 管理操作审计，不记录密钥 |

### 3.3 UserVault Durable Object

每个用户一个实例，ID = `idFromName(user_id)`。内部 SQLite：

```sql
-- 所有同步记录的统一存储（服务端不解析业务字段，只做少量索引）
CREATE TABLE record (
  type        TEXT NOT NULL,          -- 记录类型，见 §5.2
  id          TEXT NOT NULL,          -- 客户端生成的 UUID
  rev         INTEGER NOT NULL,       -- 服务端 revision = 最后一次写入时的 server_seq
  hlc         TEXT NOT NULL,          -- 写入方的混合逻辑时钟，用于 LWW 排序
  device_id   TEXT NOT NULL,          -- 最后写入的设备
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT,                   -- JSON；deleted=1 时为 NULL
  blob_key    TEXT,                   -- payload 超限时指向 R2
  parent_id   TEXT,                   -- 可选：所属文章/书，便于按需拉取
  size        INTEGER NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX record_rev ON record(rev);

-- 已处理的 push 操作（幂等）
CREATE TABLE applied_op (op_id TEXT PRIMARY KEY, result TEXT, applied_at INTEGER);

-- 单调计数器
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);   -- server_seq, schema_version, tombstone_floor
```

要点：

- `server_seq` 由 DO 内单线程递增，每条写入都会取得新的 `rev`，`pull` 按 `rev > cursor` 增量返回。
- 服务端对 payload 基本透明，只校验大小、类型白名单与 JSON 合法性。业务合并在客户端完成，与 iOS 现有实现一致；复习事件只追加、不覆盖（见 §5.5）。
- DO 在空闲时自动休眠，存储按量计费，适合大量低频用户。
- **备份**：每日由 Cron 触发，把每个活跃用户的 DO 导出成 NDJSON 快照写入 R2（保留 30 天），同时作为"导出我的数据"功能的来源。

### 3.4 R2 布局

```
books/{user_id}/{book_id}/{sha256}.epub|txt      # 书籍原文件（内容寻址，天然去重）
blobs/{user_id}/{type}/{id}/{rev}.json.gz        # 超大 payload（> 512 KB）
exports/{user_id}/{export_id}.zip                # 用户导出，7 天过期
backups/{date}/{user_id}.ndjson.gz               # DO 每日快照
```

上传走 Worker 签发的短期预签名 URL，客户端直传 R2；下载经 Worker 鉴权后流式返回，或签发短期 URL。

### 3.5 限流与配额

| 维度 | 免费 | Plus | Pro |
|---|---|---|---|
| 生词 | 200 个 | 不限 | 不限 |
| 书籍 / 小说 | 5 本，单文件 ≤ 10 MB | 文件总量 2 GB，单文件 ≤ 50 MB | 文件总量 10 GB，单文件 ≤ 50 MB |
| 歌词 | 30 首 | 不限 | 不限 |
| 文章 | 30 篇 | 不限 | 不限 |
| 同步请求 | 60 次/分钟/设备 | 同左 | 同左 |
| 托管 AI | 无 | 充值积分后可用 | 每月赠送积分 + 可充值 |

- 超出免费额度时**本地数据不受影响**，只是超出部分不再上传，设置页提示升级。
- 书籍按章节懒切分（§8.2），避免导入一本大书就写入几十万行，这是免费用户成本的主要风险点（见 §3.7）。
- 限流使用 Workers Rate Limiting binding（按 user_id + 路由）。

### 3.6 环境与部署

- 三套环境：`dev`（本地 `wrangler dev` + 本地 D1/R2 模拟）、`staging`（`staging.openkoto.com`）、`prod`。
- D1 schema 用 Drizzle 管理迁移；DO 内部 schema 在构造时按 `meta.schema_version` 迁移。
- GitHub Actions：PR 跑单测 + 契约测试（Miniflare/`@cloudflare/vitest-pool-workers`）；合并 main 部署 staging；打 tag 部署 prod。
- 观测：Workers Logs + Analytics Engine（请求量、同步延迟、AI 用量）；错误上报 Sentry（脱敏，不含正文）。

### 3.7 成本估算（2026-09 官方价格，汇率按 1 USD ≈ 7.2 CNY）

**固定成本（每月）**

| 项目 | 费用 | 说明 |
|---|---|---|
| Cloudflare Workers Paid | $5（≈ ¥36） | 含 1000 万次请求；D1 / DO 各含 5 GB 存储、每月 250 亿行读 / 5000 万行写的免费额度 |
| 邮件（Resend） | 初期 $0；超出免费额度后 $20（≈ ¥144） | 免费额度较小（以官网为准），登录验证码是主要用量；延长会话有效期可减少发信 |
| 域名 `openkoto.com` | ≈ ¥10 | 按年付费折算 |
| Apple 开发者账号 | $99/年（≈ ¥59/月） | 已有，属沉没成本 |
| **合计** | **≈ ¥50–250 / 月** | |

**单用户基础设施成本（每月）**

| 用户类型 | 估算 | 依据 |
|---|---|---|
| 免费用户（用满额度） | < ¥0.1 | R2 50 MB（$0.015/GB·月）+ DO 文本约 30 MB（$0.20/GB·月）；请求量落在免费额度内 |
| Plus 用户（典型） | ≈ ¥0.1 | 同步文本几十 MB，书籍几百 MB |
| Plus 用户（用满 2 GB） | ≈ ¥1 | 最坏情况 |

**结论：同步与存储成本几乎可以忽略，真正的成本是支付手续费和托管 AI。**

需要注意的是写入行数：DO 超出免费额度后每百万行 $1。一本 10 MB 的小说如果一次性全书切句，大约会写入 10 万行，所以必须按章节懒切分。

**支付手续费**（直接决定低价会员能否回本）

| 渠道 / 价格 | 手续费 | 到手 |
|---|---|---|
| Creem ¥6/月（≈ $0.83） | 3.9% + $0.40 ≈ $0.43（**52%**） | ≈ ¥2.9 |
| Creem ¥8/月（≈ $1.11） | ≈ $0.44（**39%**） | ≈ ¥4.9 |
| Creem ¥58/年（≈ $8.06） | ≈ $0.71（9%） | ≈ ¥53（≈ ¥4.4/月） |
| Creem ¥28/月（Pro） | ≈ $0.55（14%） | ≈ ¥24 |
| App Store ¥6/月 | 15%（小型企业计划；中国区另扣税） | ≈ ¥4.5–5 |
| App Store ¥28/月 | 同上 | ≈ ¥22–24 |

Creem 每笔固定收取 $0.40，所以**网页端不适合卖低价月付**：Plus 在网页只卖年付，月付只在 App Store 提供。

**托管 AI 成本**（以 DeepSeek `deepseek-flash` 高峰价估算：输入 $0.30 / 百万 token，输出 $1.20 / 百万 token；非高峰时段半价）

| 操作 | 模型成本 | 对应积分（1 积分 = ¥0.01，按模型成本约 2 倍定价） |
|---|---|---|
| 翻译一句（批量） | ≈ $0.00011（¥0.0008） | ≈ 0.2 |
| 精讲一句（结构化 JSON） | ≈ $0.001（¥0.007） | ≈ 1.5 |
| 一首歌（40 行翻译 + 逐行注释） | ≈ $0.01（¥0.07） | ≈ 15 |
| 一本 10 万字轻小说（约 3000 句）整本翻译 | ≈ $0.33（¥2.4） | ≈ 500 |
| 一本 10 MB 长篇（约 10 万句）整本翻译 | ≈ $11（¥80） | ≈ 16000 |

整本翻译必须按积分计费、不能包月不限量；后台任务优先放在非高峰时段执行，成本减半。

**回本测算**：固定成本 ¥50–250/月，Plus 每人每月净收入约 ¥4.5，所以 **约 10–55 个付费用户即可覆盖固定成本**。托管 AI 按积分预付，本身不亏钱。

## 4. 认证与账号

### 4.1 登录方式

| 方式 | 优先级 | 说明 |
|---|---|---|
| 邮箱验证码（OTP） | P0 主力 | 国内外通用；发信用 Resend（官网模板已集成） |
| Sign in with Apple | P0 | iOS 提供第三方登录时，按 App Review 4.8 需提供等价隐私登录选项 |
| Google | P1 | 海外用户 |
| GitHub | P1 | CLI / 开发者用户 |
| Passkey | P2 | Better Auth passkey 插件 |

同一邮箱的多种方式自动合并为一个账号。Apple "隐藏邮件地址"会产生中转邮箱，需在账户中心提供"关联其他登录方式"。

### 4.2 凭证模型

| 凭证 | 形式 | 有效期 | 使用方 |
|---|---|---|---|
| Web 会话 | HttpOnly + Secure + SameSite=Lax Cookie | 30 天滑动 | 网页 |
| Access Token | JWT（EdDSA），含 `sub`、`device_id`、`scope`、`ent`（权益摘要） | 15 分钟 | iOS / 桌面 / CLI |
| Refresh Token | 随机不透明串，服务端只存哈希，**每次使用都轮换** | 90 天滑动 | 同上 |
| API Key | `ok_live_` 前缀 + 随机串，带 scopes | 用户自定，可随时吊销 | 脚本 / CI / Agent |
| MCP OAuth Token | OAuth 2.1 + 动态客户端注册 | 按 OAuth 流程 | Claude 等 MCP 客户端 |

Worker 通过 JWKS 本地验签 JWT，不查库；只有 refresh 和敏感操作才访问 D1。JWT 中的 `ent` 用于快速判断权益，扣点等关键操作仍以 D1 为准。

### 4.3 各端登录流程

**网页**：标准 Better Auth 流程，Cookie 会话；API 同域，写操作校验 Origin 防 CSRF。

**iOS / Mac Catalyst**

1. Apple 登录：`ASAuthorizationController` 拿到 `identityToken` + `nonce`，发给 `POST /api/auth/native/apple`，服务端校验后签发 token 对。
2. 邮箱 / Google：`ASWebAuthenticationSession` 打开 `openkoto.com/auth/native?client=ios&code_challenge=...`，完成后回调 `openkoto://auth/callback?code=...`，App 用 `code + code_verifier` 换 token 对。
3. Token 存 Keychain（沿用 `OKAIClient/KeychainStore.swift` 的 data-protection keychain 方案，改用独立 service 名）。

**桌面端（Tauri）**

1. 生成 PKCE，调用系统浏览器打开授权页。
2. 回调优先使用 `openkoto://auth/callback`（`tauri-plugin-deep-link`，Windows 需在安装器里注册协议）；deep link 不可用时（部分 Linux 桌面环境）回退到本机 `http://127.0.0.1:<随机端口>/callback`。
3. Token 存系统钥匙串（`keyring` crate，Cargo.toml 已引入但未使用）。**同一改造中，把 `config.json` 里的明文模型 API Key 一并迁入 keyring**。

**CLI**：OAuth 设备授权流程（RFC 8628）

```
$ koto login
请在浏览器中打开 https://openkoto.com/device 并输入：WDJB-MJHT
（已尝试自动打开浏览器）  等待授权…  ✓ 已登录为 you@example.com
```

Token 优先存系统钥匙串；无钥匙串环境（SSH / 容器）存 `~/.config/koto/credentials.json`（权限 0600）。环境变量 `KOTO_API_KEY` 优先级最高，用于 CI 与 Agent。

**远程 MCP**：`https://openkoto.com/mcp` 按 MCP 授权规范提供 OAuth 2.1（授权服务器元数据 + 动态客户端注册 + PKCE），用户在网页上确认授权范围。

### 4.4 API Key 作用域

| scope | 能力 |
|---|---|
| `vocab:read` / `vocab:write` | 生词、词包、复习 |
| `library:read` / `library:write` | 文章、书籍、歌词、书签、进度 |
| `ai:use` | 调用托管 AI（消耗积分；仅 Pro 会员可签发） |
| `sync` | 完整同步（第三方客户端） |

默认给 CLI 登录签发全部 scope；在网页创建 API Key 时默认只勾选读权限。

### 4.5 账号生命周期

- **首次登录**：客户端把本地全部记录作为一次 push 上传（见 §5.7），与云端合并，不需要专门的迁移逻辑。
- **登出**：吊销当前设备的 refresh token；本地数据默认保留，另提供"同时清除本机数据"选项。
- **切换账号**：切换前必须清除本机数据或导出，避免两个账号的数据混合。
- **账号删除**：提交后进入 7 天冷静期，之后由 Queue 任务删除 D1 行、DO 存储、R2 对象，取消订阅（App Store 订阅需提示用户到系统设置取消），写入审计。iOS 端必须提供应用内删除入口（App Store 要求）。
- **设备管理**：账户中心列出设备，可逐个吊销。

### 4.6 安全要点

- OAuth `state` / `nonce` 校验、回调白名单、PKCE 强制开启。
- 邮箱 OTP：6 位数字，10 分钟有效，同一邮箱每小时最多 5 次，错误 5 次后作废。
- Refresh token 复用检测（token family），发现被盗用时撤销整个链并强制重新登录。
- 所有密钥（JWT 私钥、支付 secret、AI 供应商 key）存 Worker Secrets，不进仓库。
- 客户端**不内置**任何平台级 AI Key。

---

## 5. 同步协议

> 本节定稿后拆为 `docs/specs/sync-protocol-spec.md`，并配套 `docs/specs/fixtures/sync/` 契约用例，四端必须全部通过。

### 5.1 基本模型

- **记录（record）**：`(type, id)` 唯一，`payload` 为该实体的完整 JSON（camelCase，与 `.okdata` / `TransferBundle` 字段对齐）。
- **服务端 revision**：每次成功写入分配一个单调递增的 `rev`，客户端以最后见过的 `rev` 作为游标（cursor），**cursor 对客户端不透明**。
- **HLC**（混合逻辑时钟）：格式 `"{毫秒时间戳 13 位}-{计数器 4 位}-{device_id 前 8 位}"`，按字典序比较。客户端每次修改记录时生成新 HLC；收到远端记录时推进本地时钟。**LWW 比较的是 HLC，而不是 `updated_at` 墙钟**，用来解决设备时钟漂移问题。`updated_at` 仍保留，用于 UI 展示。
- **墓碑**：删除即写入一条 `deleted=true`、payload 为空的记录，通过同一通道传播。

### 5.2 记录类型

| type | 来源 | 合并策略 | 首批 | 备注 |
|---|---|---|---|---|
| `Vocabulary` | iOS 已有 | LWW（HLC）；SRS 字段由事件重放覆盖 | ✅ | 去重规则见 SRS 规范 §1.4 |
| `WordPack` | iOS 已有 | LWW | ✅ | |
| `WordPackMembership` | iOS 已有 | 存在性集合（加入 = 记录存在，移出 = 墓碑） | ✅ | 桌面端需从 `pack_ids` 迁移为关系 |
| `ReviewEvent` | iOS 已有 | **只追加，不可修改**；同 id 重复推送视为幂等 | ✅ | 见 §5.5 |
| `Article` | iOS 已有 | LWW | ✅ | `sourceType` 新增 `lyrics` |
| `Segment` | iOS 已有 | 带 `segmentationRevision` 的整体替换；同版本内按字段补全（沿用 `decideSegment`） | ✅ | 文章重新切分时，旧版本 segment 全部写墓碑 |
| `Book` | iOS 已有 | LWW | ✅ | 原文件走 R2，payload 只存 `fileSha256` |
| `BookChapter` | iOS 已有 | LWW | ✅ | |
| `BookMark` | iOS 已有 | LWW | ✅ | |
| `BookProgress` | **新增** | LWW，**同一本书只保留一条**（id = bookId） | ✅ | 多端续读刚需；iCloud 版未同步 |
| `LyricsMeta` | **新增** | LWW | ✅ | 见 §8.3 |
| `WordGloss` | iOS v11 | LWW | 第二批 | |
| `ReadingSession` | iOS v2 | 只追加 | 第二批 | 统计用 |
| `Media` / `MediaPart` / `MediaProgress` | iOS 已有 | LWW | 本期不同步 | 视频非目标；协议中保留类型名 |
| `Setting` | **新增** | 每个 key 一条记录，LWW | 第二批 | 仅同步白名单设置（学习语言、每日目标、主题），**不同步 API Key** |

合并顺序（`mergeOrder`）沿用 iOS `CloudRecordType.mergeOrder`，新增类型依次插入：`BookProgress` 排在 `BookMark` 之后，`LyricsMeta` 排在 `Article` 之后。

### 5.3 API

**拉取**

```http
GET /api/v1/sync/pull?cursor=<opaque>&limit=500&types=Vocabulary,ReviewEvent
Authorization: Bearer <jwt>
```

```json
{
  "records": [
    { "type": "Vocabulary", "id": "3f0c…", "rev": 1042, "hlc": "1727500000123-0001-a1b2c3d4",
      "deviceId": "…", "deleted": false, "payload": { "word": "懐かしい", "...": "..." } },
    { "type": "BookMark", "id": "88aa…", "rev": 1043, "hlc": "…", "deleted": true, "payload": null },
    { "type": "Article", "id": "…", "rev": 1044, "hlc": "…", "deleted": false, "blobUrl": "https://…" }
  ],
  "cursor": "c_1044",
  "hasMore": false,
  "serverTime": "2026-09-28T10:00:00Z"
}
```

- `limit` 上限 1000 条或 4 MB（先到为准）；`hasMore=true` 时客户端继续拉取。
- 响应使用 gzip/br 压缩。
- 如果 cursor 早于墓碑保留下限（`tombstone_floor`），返回 `410 CURSOR_EXPIRED`，客户端执行全量重建（§5.7）。

**推送**

```http
POST /api/v1/sync/push
Authorization: Bearer <jwt>
Content-Type: application/json
```

```json
{
  "deviceId": "…",
  "ops": [
    { "opId": "uuid-1", "type": "Vocabulary", "id": "3f0c…", "baseRev": 1042,
      "hlc": "1727500100000-0000-a1b2c3d4", "deleted": false, "payload": { "...": "..." } },
    { "opId": "uuid-2", "type": "ReviewEvent", "id": "e91d…", "baseRev": 0,
      "hlc": "…", "deleted": false, "payload": { "grade": 3, "...": "..." } }
  ]
}
```

```json
{
  "results": [
    { "opId": "uuid-1", "status": "applied",  "rev": 1050 },
    { "opId": "uuid-2", "status": "applied",  "rev": 1051 },
    { "opId": "uuid-3", "status": "conflict", "rev": 1047, "current": { "hlc": "…", "deleted": false, "payload": { "...": "..." } } },
    { "opId": "uuid-4", "status": "rejected", "code": "PAYLOAD_TOO_LARGE" }
  ],
  "cursor": "c_1051"
}
```

服务端规则：

1. `opId` 已处理 → 直接返回上次的结果（幂等）。`applied_op` 表保留 30 天。
2. 记录不存在，或 `baseRev == 当前 rev` → 应用，分配新 rev，返回 `applied`。
3. `baseRev < 当前 rev`（期间有其他设备写过）：
   - 若 `op.hlc > 当前 hlc` → 应用（LWW 获胜），返回 `applied`；
   - 否则返回 `conflict` 并附带当前值，由客户端合并后以新的 `baseRev` 重推（对应 iOS 现有的"最多两轮 push"）。
4. `ReviewEvent`：只接受插入；同 id 已存在则视为幂等成功；尝试修改则返回 `rejected`。
5. 单次请求最多 500 个 op 或 4 MB；超过 512 KB 的单条 payload 先调用 `POST /sync/blobs` 上传到 R2，op 中改为携带 `blobKey`。

**辅助接口**

| 接口 | 用途 |
|---|---|
| `POST /api/v1/sync/blobs` | 为超大 payload 获取 R2 上传地址 |
| `GET /api/v1/sync/stats` | 各类型记录数、存储占用、配额（设置页展示） |
| `POST /api/v1/sync/reset` | 危险操作：清空云端数据（需二次确认 + 最近 5 分钟内重新认证） |

**实时通知（第二阶段）**：DO 支持 WebSocket Hibernation。网页端与桌面端在线时保持一条 WebSocket 连接，收到 `{"type":"changed","rev":1051}` 后触发一次 pull。iOS 不常驻连接，改用"前台时拉取 + 静默推送（APNs）"。

### 5.4 客户端同步循环

```
触发条件：App 启动 / 回到前台 / 本地写入后防抖 3 秒 / 定时 5 分钟 / 收到 WS 通知 / 手动
1. pull 直到 hasMore=false → 按 mergeOrder 分批应用 → 外键未就绪的记录暂存（pending，沿用 iOS pending_cloud_payload）
2. 收集本地脏记录（本地 hlc > 最后同步的 hlc，或 dirty 标记）→ push
3. 处理 conflict → 本地合并 → 以新 baseRev 重推（最多 2 轮，之后留到下个周期）
4. 若有 ReviewEvent 新增 → 对受影响的卡片执行 recomputeCardStates 重放
5. 持久化 cursor 与本地 HLC
```

iOS 目前用"扫描 updated_at 水位线"发现本地变更。接入新协议后改为比较 HLC 水位线；payload 哈希去回声的逻辑保留。

### 5.5 复习事件与 FSRS 重放

- 规则沿用 SRS 规范 §8：**卡片的 SRS 状态是复习事件的派生值**，不参与 LWW。
- 客户端收到新的 `ReviewEvent` 后，取该卡全部事件，按 `(reviewedAt, hlc)` 排序，从初始状态重放 FSRS，得到 `stability / difficulty / due / state`。
- 同一张卡在两台设备上同日各复习一次：两条事件都保留，重放后得到确定的结果，各端一致。
- 卡片的非 SRS 字段（释义、例句、暂停状态）仍走 LWW。
- 契约用例 `fixtures/sync/review-replay-*.json`：给定事件集合（乱序、重复）→ 期望最终卡片状态，四端必须一致（容差同 FSRS 黄金用例）。

### 5.6 墓碑与保留期

- 墓碑保留 180 天，之后由 DO Alarm 物理清除，并把 `tombstone_floor` 推进到被清除范围的最大 rev。
- 180 天以上未同步的设备 cursor 会过期（410），需要全量重建：先拉取全部现存记录，再以"本地有、云端无且不在墓碑中"的记录作为新建推送。这一步需要提示用户确认，避免复活已在其他端删除的数据。

### 5.7 首次同步与迁移

| 场景 | 流程 |
|---|---|
| 新用户，本地有数据 | 登录 → `bootstrap` 拉取（云端为空）→ 本地全部记录生成 HLC 后分批 push |
| 老用户新设备 | 分页全量 pull，之后进入增量同步 |
| 同一用户两台设备都有离线数据 | 先 pull 再 push；同一个词在两台设备上各建了一张卡（id 不同）时，按 SRS 规范 §1.4 去重规则合并（保留较早创建的卡，事件迁移到保留的卡，另一张写墓碑） |
| iOS 已开 iCloud 同步 | 升级后提示"迁移到 OpenKoto 云"：先完成一次 CloudKit pull（确保本机最新）→ 登录 → 按"新用户"流程推送 → 关闭 CloudKit 同步。迁移过渡期内两个引擎不同时启用 |
| 桌面端 JSON 老数据 | 先完成本地 SQLite 迁移（§9.2），再按"新用户"流程推送 |

### 5.8 错误码

| HTTP | code | 客户端处理 |
|---|---|---|
| 401 | `TOKEN_EXPIRED` | 刷新 token 后重试 |
| 402 | `QUOTA_EXCEEDED` | 暂停推送，提示升级或清理 |
| 409 | `CONFLICT`（op 级） | 合并后重推 |
| 410 | `CURSOR_EXPIRED` | 全量重建 |
| 413 | `PAYLOAD_TOO_LARGE` | 改走 blob 上传 |
| 426 | `CLIENT_TOO_OLD` | 协议版本过低，提示升级 App |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 退避 |

所有请求带 `X-OpenKoto-Protocol: 1` 与 `X-OpenKoto-Client: ios/1.4.0`；服务端据此拒绝不兼容的旧客户端。

---

## 6. 托管 AI 服务

### 6.1 两种模式并存

| 模式 | 适用 | 数据路径 |
|---|---|---|
| **BYOK**（永久免费） | 所有端 | 客户端直连用户配置的供应商，不经过 OpenKoto 服务器 |
| **托管 AI**（积分，仅 Pro 会员） | 所有端 | 客户端 → `/api/v1/ai/*` → AI Gateway → 供应商 |

网页端 BYOK 的限制：部分供应商不允许浏览器跨域调用（CORS），并且 Key 存在浏览器中有被窃取的风险。因此网页端 BYOK 只支持明确允许浏览器调用的供应商（OpenAI 兼容、OpenRouter 等，逐个验证），Key 只存在当前浏览器本地并加密，不上传；页面上需明确提示风险。

### 6.2 接口

| 接口 | 说明 | 流式 |
|---|---|---|
| `POST /api/v1/ai/translate` | 句子或段落批量翻译 | 否 |
| `POST /api/v1/ai/explain` | 单句精讲（结构化 JSON，schema 与现有 `SegmentExplanation` 对齐） | 否 |
| `POST /api/v1/ai/gloss` | 单词释义（生词卡生成） | 否 |
| `POST /api/v1/ai/chat` | 阅读助手对话 | SSE |
| `POST /api/v1/jobs` `{kind:"translate_book", bookId, chapters, targetLang}` | 整本/多章节翻译，走 Queues | 通过查询 job 或 WebSocket 获取进度 |

Prompt 统一由 `@openkoto/core` 的 Prompt 库生成并带版本号（与 iOS `PromptLibrary.swift`、桌面 `ai_service.rs` 对齐）。服务端只接受 `taskType + 参数`，**不接受客户端传入的任意 system prompt**，防止托管额度被当成通用大模型代理滥用。`chat` 接口有单独的长度与频率上限。

### 6.3 点数计费流程

```
请求到达 → 按 模型 × 预估 token 计算预留额 → credit_ledger 写 reserve（余额不足则返回 402）
         → 调用模型 → 按实际 token 计算 → 写 settle（多退少补）
         → 失败 / 超时 → 写 refund
```

- 余额计算与扣减必须串行：给每个用户的点数账户建一个 `CreditAccount` DO（或复用 UserVault），避免并发请求导致超扣。
- `usage_record` 只记 token 数与点数，不存原文。
- 翻译结果缓存：以 `hash(promptVersion + model + 原文 + 目标语言)` 为键，缓存到 KV / AI Gateway 缓存，命中不扣点。热门歌词与公版小说收益明显。

### 6.4 模型策略

- 按任务分档：翻译 / 释义使用性价比档模型；精讲 / 对话使用高质量档模型；整本翻译使用批量档（供应商支持 batch 接口时走 batch，成本更低）。
- 模型清单与点数单价写在 D1 配置表，可随时调整，不需要发版。

---

## 7. 网页端设计

### 7.1 定位

- **在线优先**：数据以云端为准，本地使用 IndexedDB 缓存最近数据，支持短时离线的复习与阅读（离线期间的操作排队，恢复网络后 push）。
- **必须登录**：网页端不提供匿名本地模式，未登录只展示营销页与试用 Demo。这样可以降低复杂度，也便于转化。
- 官网与应用合一：`openkoto.com` 的落地页、文档、更新日志、隐私政策由网页端直接提供，登录后进入应用；旧 Vercel 官网（`koto_intro_web`）停用，旧链接（`/privacy-policy`、`/zh/...`、`/docs/...`）做 301 跳转。

### 7.2 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Vite + React 19 + React Router 7 | 与桌面前端一致，组件可直接复用 |
| 样式 | Tailwind + 桌面端现有主题 token | 视觉统一 |
| 数据 | TanStack Query + `@openkoto/sync-client`（IndexedDB 用 Dexie） | 缓存与同步 |
| i18n | 沿用桌面 `src/locales`（en/zh/ja） | |
| EPUB | foliate-js（或 epub.js），实现时评估 | 桌面端现用方案需确认能否在纯浏览器运行 |
| 部署 | Workers Static Assets，与 API Worker 同域 | 同域 Cookie |

### 7.3 桌面前端组件复用：平台适配层

桌面前端目前有 33 个文件直接 `import { invoke } from "@tauri-apps/api/core"`。改造步骤：

1. 新建 `packages/core/src/platform.ts`，定义 `interface Platform { vocab; library; ai; files; ... }`，方法签名按业务语义设计，不照搬 Tauri 命令名。
2. `textlingo-desktop/src/platform/tauri.ts` 实现 Tauri 版（内部仍然调用 `invoke`）。
3. `apps/web/src/platform/web.ts` 实现网页版（内部调用 `@openkoto/api` 与 sync-client）。
4. 逐个组件把 `invoke(...)` 替换为 `usePlatform().xxx()`。先迁移三大核心功能涉及的组件：`FavoritesPage`、`FavoritesCards`、`WordRecitePanel`、`WordPackManager`、`BookReader`、`EpubReader`、`TxtReader`、`BookmarkSidebar`、`ArticleReader`、`ArticleExplanationPanel`。
5. 迁移完成的组件移入 `packages/ui`，两端共享。

增加一条 ESLint 规则：`packages/ui` 与 `apps/web` 禁止 import `@tauri-apps/*`。

### 7.4 信息架构

```
/                     首页（今日复习数、继续阅读、最近歌词）
/review               复习（FSRS 队列）
/vocab                生词本 / 词包管理
/library              书架（书籍 + 文章 + 歌词，可筛选）
/read/:bookId         小说阅读器
/article/:id          文章阅读器
/lyrics/:id           歌词学习页
/import               导入（EPUB/TXT 上传、粘贴文本、粘贴 LRC、网页链接）
/account              账户中心（订阅、点数、设备、API Key、数据导出、删除账号）
/device               CLI 设备码确认页
```

---

## 8. 三大功能规格（网页端首发，各端对齐）

### 8.1 背单词

- **FSRS**：直接依赖 `ts-fsrs@5.4.1`（与规范一致），CI 中跑 `docs/specs/fixtures/fsrs_golden_v1.json` 黄金用例。
- **复习流程**：到期队列 → 卡片正面（单词 + 可选原句）→ 翻面（释义 / 读音 / 例句 / 原文出处）→ 四档评分 → 写入 `ReviewEvent` 并本地重放 → 后台 push。
- 快捷键：空格翻面，1–4 评分，`U` 撤销（撤销 = 删除本地尚未 push 的事件；已 push 的事件不可撤销，改为追加一条"作废"事件，协议中增加 `voidsEventId` 字段）。
- 同日巩固步骤（learning steps）：iOS 已实现，桌面端待跟进，网页端直接按规范 §2.8 实现。
- 词包：创建、导入 / 导出 `.okpack.json`（格式与桌面一致）、Anki 导出（复用 `src/lib/ankiExport.ts`）。
- 统计：今日完成数、保持率、未来 7 天到期预测（口径按规范 §6）。

### 8.2 小说阅读与翻译

- **导入**：上传 EPUB/TXT → 客户端计算 sha256 → 请求预签名地址直传 R2 → 客户端解析章节（EPUB 按 spine；TXT 按章节标题正则，沿用 iOS `OKBooks` 规则并移植到 core）→ 生成 `Book` + `BookChapter` 记录并同步。
- 章节正文按需生成 `Article` + `Segment`（打开某章时才切分），避免整本书一次性产生海量同步记录。
- **阅读模式**：原文 / 双语对照 / 仅译文；点句查看精讲；点词查释义并一键收藏（`Vocabulary.sourceArticleId` 指回章节）。
- **翻译**：单章即时翻译（逐段请求，边翻边显示）；整本 / 多章翻译提交后台任务，完成后译文写入 segment 并同步到所有端。
- **进度**：`BookProgress`（chapterIndex、segmentOrder、scrollFraction）每 10 秒或翻章时写入，多端续读。
- **书签 / 高亮**：沿用 `BookMark`。EPUB 定位方面，桌面用 CFI，iOS 用 `char_start/end + locator`，需要统一：以"章节 index + 章内字符偏移"为主定位，CFI 仅作为可选附加字段。

### 8.3 歌词翻译与学习

**数据模型**：不新增歌词正文表，复用 Article + Segment：

- `Article.sourceType = "lyrics"`，每行歌词对应一个 `Segment`，时间戳写入 `startTime/endTime`（iOS segment 已有这两个字段；桌面 `ArticleSegment` 也有）。
- 新增 `LyricsMeta` 记录（id = articleId）：`artist`、`album`、`language`、`lrcOffsetMs`、`coverUrl?`、`sourceFormat(lrc|txt|srt)`、`musicLinks?`（仅外链，不存音频）。

**导入**：粘贴或上传 LRC / 纯文本 / SRT。LRC 解析放在 `@openkoto/core`，需要支持 `[mm:ss.xx]`、同一行多个时间戳、`[offset:]` 与元信息标签。

**学习页**：逐行显示原文 + 注音（日语振假名 / 中文拼音）+ 译文；点行查看精讲；点词收藏。有时间轴的歌词支持"跟唱模式"（用户在外部播放器播放，网页端按手动起点 + offset 滚动高亮；不内置音频播放以规避版权问题）。

**翻译**：整首一次请求（保证上下文与押韵的连贯性），Prompt 要求逐行对齐输出 JSON 数组；行数不一致时触发修复流程（复用 JSON 修复管线）。

**版权**：歌词由用户自行导入，仅私有存储，不提供公开歌词库和分享链接；翻译缓存只以哈希为键，不对外暴露原文。

---

## 9. 客户端改造

### 9.1 iOS / Mac Catalyst

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 登录模块 | 新模块 `OKAccount`：Apple 登录、ASWebAuthenticationSession、token 存储与自动刷新 | 新建 |
| API 客户端 | `OKCloudAPI`：基于 URLSession，处理协议头、错误码、退避 | 新建 |
| `HTTPSyncEngine` | 实现 `SyncEngine` 协议，复用 `ContentRepository+Cloud.swift` 的 `pendingCloudPayloads` / `applyCloudPayloads` / `pendingCloudDeletions` / `applyCloudDeletions` | `OKPersistence/` |
| 引擎注入 | 把 `ContentStore+Sync.swift:120-129` 中写死的 `CloudKitSyncEngine` 改为按设置注入（None / iCloud / OpenKoto 云） | `OKFeatures/Transfer/` |
| 数据库迁移 v12 | 新增 `hlc`、`server_rev`、`dirty` 列（或独立的 `sync_record_meta` 表，参考 `cloud_record_meta`）；`sync_state` 存 cursor | `AppDatabase.swift` |
| 新记录类型 | `BookProgress`、`LyricsMeta` 纳入同步；`source_type` 支持 `lyrics` | `CloudRecord.swift` 等 |
| 歌词 UI | 导入 LRC、歌词学习页 | `OKFeatures/` |
| StoreKit 2 | 购买时设置 `appAccountToken = user_id`；服务端通过 App Store Server Notifications v2 更新权益 | 新建 `OKCommerce`（开源） |
| 托管 AI | `ChatTransport` 新增 `OpenKotoCloudTransport`，在 Provider 列表中显示为"OpenKoto AI（会员）" | `OKAIClient/` |
| 设置页 | 账号、同步状态、存储占用、iCloud 迁移向导、删除账号 | `Transfer/SyncSection.swift` |

### 9.2 桌面端

| 任务 | 说明 |
|---|---|
| **存储迁移到 SQLite** | 用 `rusqlite` 或 `sqlx`，表结构对齐 iOS `AppDatabase.swift`（article / segment / favorite_vocabulary / word_pack / word_pack_membership / review_log / book / book_chapter / book_progress / book_mark / deleted_record / sync_state）。首次启动时把 JSON 数据一次性导入，原 JSON 目录重命名为 `legacy-json-backup/` 保留。阅读进度从 localStorage 迁入 `book_progress`。复用 `transfer_export.rs` 的映射逻辑 |
| 平台适配层 | 见 §7.3 |
| 同步 | 同步逻辑放在 Rust 侧（`src-tauri/src/sync/`），实现 `trait SyncEngine`（SRS 规范 §8 已定义）。协议类型用 JSON Schema 生成 Rust 类型；也可以复用 TS 的 sync-client 在前端跑，但放在 Rust 侧更利于后台运行和保证一致性，**推荐 Rust** |
| 登录 | deep link + PKCE，token 存 keyring |
| 密钥迁移 | `config.json` 中 `model_configs[].api_key` 迁入 keyring，config 里只保留引用 |
| ~~清理旧后端~~ | ✅ 已完成（2026-09-28）：`src/lib/api.ts` 删除，`backend_url` / `auth_token` 字段移除 |
| 歌词 | 导入 LRC；歌词学习页复用 `packages/ui` |
| Windows | 安装器注册 `openkoto://` 协议；钥匙串使用 Windows Credential Manager（keyring crate 已支持） |

### 9.3 各端能力矩阵（本期交付后）

| 能力 | 网页 | iOS | 桌面 | CLI |
|---|---|---|---|---|
| 登录 / 同步 | ✅ | ✅ | ✅ | ✅ |
| 背单词复习 | ✅ | ✅ | ✅ | ✅（`koto vocab review`，终端交互） |
| 小说阅读 | ✅ | ✅ | ✅ | 仅导入 / 翻译 |
| 歌词翻译学习 | ✅ | ✅ | ✅ | ✅ 翻译 / 导出 |
| BYOK | 受限（§6.1） | ✅ | ✅ | ✅ |
| 托管 AI | ✅ | ✅ | ✅ | ✅ |
| 视频 / ASR / KTV / PDF 版式翻译 | ❌ | 部分 | ✅ | ❌ |

---

## 10. CLI / MCP / Skill / Agent

### 10.1 `koto` CLI

- 技术：Node 20+（TypeScript），依赖 `@openkoto/core` + `@openkoto/api`；以 npm 包 `@openkoto/cli` 分发，另提供单文件二进制（`bun build --compile`）。
- CLI 本身不保存本地数据库，直接读写云端 API，所以操作结果立即在所有端可见。
- 输出：默认是人类可读格式；加 `--json` 输出稳定的 JSON 结构，供脚本和 Agent 使用。退出码有明确语义（0 成功 / 2 参数错误 / 3 未登录 / 4 额度不足）。

```bash
koto login | logout | whoami
koto lyrics translate song.lrc --to zh [--save] [--out song.zh.lrc] [--byok]
koto lyrics list | show <id> | export <id> --format lrc|md
koto vocab add 懐かしい [--meaning ...] [--pack N3] [--from <articleId>]
koto vocab due [--json]            # 今日到期
koto vocab review                  # 终端交互复习
koto vocab import words.csv --pack N3
koto book import novel.epub
koto book translate <bookId> --chapters 1-5 --to zh   # 创建后台任务
koto job status <jobId> [--watch]
koto article add --url https://... | --file a.md
koto keys create --name ci --scopes vocab:read
```

- `--byok`：使用本地配置的供应商（`~/.config/koto/config.toml`），不消耗点数；此时翻译在本地完成，只把结果写回云端。

### 10.2 MCP Server

- **本地 stdio 版**：`npx @openkoto/mcp`，使用 CLI 的登录凭证或 `KOTO_API_KEY`。
- **远程版**：`https://openkoto.com/mcp`，使用 OAuth 授权，适合 Claude 网页端等不能运行本地进程的客户端。
- 工具（tools）设计为粗粒度、贴近业务：

| tool | 说明 |
|---|---|
| `search_library` | 按关键词、类型搜索书籍 / 文章 / 歌词 |
| `get_lyrics` / `translate_lyrics` | 读取 / 翻译歌词 |
| `list_due_vocab` / `add_vocab` / `update_vocab` | 生词操作 |
| `get_review_stats` | 学习统计 |
| `read_chapter` / `translate_chapters` | 小说章节 |
| `create_word_pack_from_text` | 从一段文本中抽取生词生成词包 |

- 写操作的工具描述中注明"会修改用户数据"，由 MCP 客户端向用户确认；删除类操作本期不开放给 MCP。

### 10.3 Skill

在仓库中新增 `skills/openkoto/`（格式与现有 `agent-worker/.claude/skills/generate-mindmap/` 一致）：

```
skills/openkoto/
├── SKILL.md              # 何时使用；koto CLI 命令速查；常见工作流
├── workflows/
│   ├── lyrics-study.md   # 翻译歌词 → 抽取生词 → 建词包
│   ├── novel-reading.md  # 导入小说 → 翻译前 N 章 → 生成人物表
│   └── daily-review.md   # 查询到期 → 汇报 → 根据错题生成例句
└── schemas/              # --json 输出的 schema，方便 Agent 解析
```

这样 Claude Code、opencode 等本地 Agent 加载 Skill 后，就能通过 CLI 操作用户数据。

### 10.4 云端 Agent（P5）

- 在网页端提供"学习助手"对话框，服务端运行 Agent 循环，工具集与 MCP 相同（直接复用同一套 tool 实现）。
- 典型用法："把这首歌里 N2 以上的生词加到我的 JLPT 词包"、"把这本书第 3–5 章翻译好，明天通勤看"。
- 执行模型：短任务在 Worker 内同步完成；长任务转为 job。每次工具调用都消耗点数，并在对话中展示操作记录，支持撤销（基于同步记录的 rev 回滚）。
- 桌面端现有的 `agent-worker/`（opencode）继续保留给本地 BYOK 场景，后续可以切换为调用同一套 MCP 工具。

---

## 11. 商业化与计费

### 11.1 套餐（2026-09-28 定稿，价格可微调）

| | 免费 | Plus | Pro |
|---|---|---|---|
| 价格 | ¥0 | App Store ¥6/月 或 ¥58/年；网页（Creem）¥58/年 | ¥28/月 或 ¥258/年（两个渠道都卖） |
| 本地功能 + BYOK | ✅ 全部 | ✅ | ✅ |
| 云同步 + 网页端 | ✅ 限额（§3.5：生词 200、书 5 本 ≤ 10 MB、歌词 30 首） | ✅ 大额度 | ✅ 更大额度 |
| CLI / MCP / Skill | ❌ | ✅（使用自己的 Key） | ✅ |
| AI 接入指引（推荐供应商与模型、配置教程） | 基础文档 | ✅ 完整指引 | ✅ |
| 托管 AI 积分 | ❌ | 可单独充值 | 每月赠送 1500 积分 + 可充值 |
| 整本翻译后台任务 / 云端 Agent | ❌ | ✅（消耗积分） | ✅（消耗积分） |

**积分充值包**：¥28 = 3000 积分（App Store 无 ¥30 档位，2026-09-30 改为 ¥28）（网页与 App Store 均可购买）。网页端最低 ¥30，否则 Creem 固定手续费占比过高。充值积分 12 个月有效；Pro 每月赠送的积分当月有效、不结转。

**原则**：
- **Plus 不含托管 AI**：所有 AI 用用户自己的 Key，Plus 卖的是同步、网页端、CLI 和配置指引，边际成本几乎为零。
- **积分只能在 OpenKoto 内使用**：只用于翻译、精讲、释义、整本翻译、Agent 等预定义功能，**不提供 OpenAI 兼容的通用接口**，不做 API 中转。
- 网页端 BYOK 受浏览器 CORS 限制（§6.1），Plus 用户在网页上只能使用支持浏览器直连的供应商，需要在购买页写清楚。
- Pro 的经济账：App Store ¥28 到手约 ¥23 − 1500 积分的模型成本约 ¥7.5 − 基础设施约 ¥1 → 每人约 ¥15 毛利。

### 11.2 支付渠道

| 渠道 | 商品 | 实现 |
|---|---|---|
| **Creem**（网页，MoR 代收全球税费） | Plus 年付、Pro 月付 / 年付、积分包 | Checkout + webhook → `/api/webhooks/creem`；Customer Portal 管理订阅；`koto_intro_web/src/extensions/payment/` 有现成接入参考 |
| **App Store**（StoreKit 2） | Plus 月付 / 年付、Pro 月付 / 年付、积分包（消耗型内购） | `appAccountToken = user_id` 绑定账号；App Store Server Notifications v2 → `/api/webhooks/appstore`；App Store Server API 校验；加入小型企业计划（15%） |

- **权益统一**：不论从哪个渠道购买，都写入 `subscription` / `credit_ledger`，`/api/v1/me` 返回统一的 `entitlements`，四端据此解锁功能。
- **iOS 合规**：iOS App 内只使用 IAP；网页购买的会员可以在 iOS 上使用（多平台服务），但 App 内不引导去网页购买，除非届时目标地区的 3.1.1 规则允许。
- **已知缺口**：国内 Windows / 网页用户没有外币卡时可能无法通过 Creem 付款（需确认 Creem 是否支持支付宝 / 微信）。短期可引导这部分用户在 iPhone 上购买，权益在四端通用。

## 12. 安全、隐私与合规

- **传输与存储**：全链路 HTTPS；D1 / DO / R2 由 Cloudflare 提供静态加密。暂不做端到端加密（否则托管 AI 与云端 Agent 无法读取内容），在隐私政策中写明。
- **日志**：不记录正文、Prompt、AI 响应、API Key；错误上报前脱敏。
- **数据权利**：账户中心提供"导出我的数据"（NDJSON + 原文件 zip）与"删除账号"。
- **隐私政策 / App Privacy 更新**：新增"账号信息、学习数据存储于 Cloudflare（数据中心遍布全球）"的说明；iOS 隐私标签从"无数据收集"更新为相应类别。
- **版权**：用户上传的书籍与歌词仅私有存储；不提供公开分享、公共库或按原文检索的公共缓存。
- **国内访问**：Cloudflare 在国内可达性不稳定，`*.workers.dev` 尤其差。必须使用自有域名；上线前实测国内各运营商的延迟；如果国内用户占比高，后续评估国内边缘代理（涉及 ICP 备案），本期不做。
- **滥用防护**：注册与 OTP 限流；必要时在注册 / 登录页接入 Turnstile；托管 AI 只接受预定义任务类型（§6.2）。

---

## 13. 里程碑（P0–P5）

### 实施状态（2026-09-28，分支 `feat/p0-foundation`）

| 阶段 | 状态 | 说明 |
|---|---|---|
| P0 地基 | ✅ | 同步 / 认证规范与契约用例；`@openkoto/core`、`@openkoto/client`；Worker（Better Auth + D1、令牌服务、UserVault DO、配额）；staging 已部署 |
| P1 背单词 + 网页 + iOS | ✅ | 网页登录 / 生词本 / FSRS 复习（含撤销）/ 账户中心；iOS `OKAccount` + `HTTPSyncEngine`（v12/v13）+ iCloud 迁移 |
| P2 桌面 | ✅ | SQLite + JSON 迁移、Rust 同步引擎、深链登录、钥匙串；书籍 / 歌词同步与实时通知在后续提交中补齐 |
| P3 小说 + 歌词 | ✅ | R2 原文件、按章懒切分、BookProgress、歌词 LRC / 跟唱 / 导出；iOS 歌词显示 |
| P4 支付 + CLI | ✅ 代码完成 | Creem（测试商品已建）、App Store 校验与通知、激活码；`koto` CLI、MCP、Skill。**待办**：正式商品、密钥、域名（见 `docs/ops/deploy.md` §3） |
| P5 托管 AI + Agent | ✅ 代码完成 | `/api/v1/ai/*` 积分计费与缓存、整本翻译队列、远程 MCP + OAuth、云端学习助手、WebSocket 实时同步、数据导出。**待办**：`AI_API_KEY` |

最终定价：Plus App Store ¥8/月、¥68/年；网页（Creem，仅美元）Plus $9.49/年、Pro $3.89/月、$35.99/年，积分包 $4.19。

估算为单人净开发量，不含审核等待与设计返工，建议另加 25% 缓冲，合计约 24–28 周。每个阶段结束都可以单独发版。

### P0 地基（约 3 周）

- [ ] 仓库清理：更新 README 中"网页版"入口；`cargo clean` 修复失效的 target 缓存
- [ ] 定稿 `docs/specs/sync-protocol-spec.md`、`docs/specs/auth-spec.md`，建立 `docs/specs/fixtures/sync/` 契约用例
- [ ] 根目录 pnpm workspace；`packages/core`：接入 ts-fsrs 5.4.1 并通过 FSRS 黄金用例，实现 LRC 解析、句子切分移植和 Prompt 库
- [ ] `packages/sync-client`：TS 参考实现，全部通过契约用例
- [ ] `server/worker`：Hono 骨架、zod 路由与 OpenAPI、D1 迁移（Drizzle）
- [ ] Better Auth：邮箱验证码（Resend）、Apple 登录、设备表、refresh token 轮换
- [ ] UserVault DO：`record` 表、`/sync/pull`、`/sync/push`、幂等、墓碑、免费额度校验
- [ ] 环境：`openkoto.com` 绑定到 Cloudflare，staging / prod 两套，GitHub Actions 自动部署
- **完成标准**：用 curl 能跑通 登录 → push → pull；契约用例全绿

### P1 背单词多端打通 + 网页端上线（约 4 周）

- [ ] `apps/web` 骨架：登录页、路由、主题与 i18n（复用桌面 locales）
- [ ] 网页：生词本、FSRS 复习（快捷键、撤销）、词包、`.okpack.json` 导入导出
- [ ] 账户中心基础版：设备管理、用量与额度、**删除账号**（iOS 上架要求）
- [ ] iOS：`OKAccount`（Apple / 邮箱登录）、`OKCloudAPI`、`HTTPSyncEngine`、数据库迁移 v12（HLC / rev / dirty）、同步引擎改为可注入
- [ ] iOS：设置页中 iCloud / OpenKoto 云二选一，加 iCloud → OpenKoto 云迁移向导
- **完成标准**：iPhone 上复习的单词在网页上立即可见，两端 FSRS 状态一致；免费用户超过 200 个生词时正确提示

### P2 桌面端接入（约 5 周）

- [ ] 桌面存储迁移到 SQLite（表结构对齐 iOS），JSON 老数据一次性导入并保留备份；localStorage 进度迁入 `book_progress`
- [ ] 平台适配层 `platform.ts`，先迁移生词、复习、阅读器相关组件，抽到 `packages/ui`
- [ ] Rust 同步引擎 `src-tauri/src/sync/`（实现 `SyncEngine` trait）
- [ ] 登录：deep link（`openkoto://`）+ PKCE，Linux 回退本机回调；token 与模型 API Key 迁入 keyring
- [ ] Windows 安装器注册 `openkoto://` 协议
- **完成标准**：Windows / Mac 桌面与 iOS、网页四端生词同步；老用户升级后数据完整

### P3 小说 + 歌词（约 4 周）

- [ ] 书籍：客户端直传 R2（预签名）、`Book` / `BookChapter` / `BookProgress` / `BookMark` 同步、按章节懒切分
- [ ] 网页阅读器：EPUB（先用 10 本样本书做 foliate-js / epub.js 选型）/ TXT，双语对照、点句精讲、点词收藏
- [ ] 歌词：`sourceType=lyrics` + `LyricsMeta`，LRC 导入，歌词学习页（网页、iOS、桌面）
- [ ] 网页 BYOK：逐个验证支持浏览器直连的供应商，Key 只存本机
- [ ] 免费额度：5 本 ≤ 10 MB、30 首歌词、30 篇文章
- **完成标准**：在桌面上看到第 3 章，换到 iPhone / 网页能接着读；歌词在三端一致

### P4 会员支付 + CLI（约 4 周）

- [ ] 套餐与权益：`plan` / `plan_entitlement` / `subscription`，`/api/v1/me` 返回 `entitlements`，各端按权益解锁
- [ ] Creem：Plus 年付、Pro 月付 / 年付、积分包，webhook 幂等处理
- [ ] App Store：StoreKit 2 订阅与消耗型积分包，Server Notifications v2，加入小型企业计划
- [ ] 积分账本 `credit_ledger`（先上线充值和余额展示，扣费在 P5）
- [ ] `koto` CLI：设备码登录、`lyrics` / `vocab` / `book` / `article` 命令、`--json`、BYOK 模式（Plus 权益）
- [ ] 本地 MCP（`@openkoto/mcp`）+ `skills/openkoto`
- [ ] AI 接入指引文档（放在 openkoto.com 文档站）
- **完成标准**：分别在网页（Creem）和 iPhone 购买 Plus，四端都显示会员身份；`koto lyrics translate x.lrc --save` 后其他端立即可见

### P5 托管 AI + Agent（约 5 周）

- [ ] `/api/v1/ai/*`（翻译、精讲、释义、对话）：AI Gateway、只接受预定义任务、翻译缓存
- [ ] 积分扣费：reserve → settle / refund，按用户串行防超扣；Pro 每月赠送积分
- [ ] 整本翻译后台任务（Queues，优先非高峰执行）
- [ ] 各端接入"OpenKoto AI"作为一个 Provider（iOS `OpenKotoCloudTransport`、桌面、网页、CLI）
- [ ] 远程 MCP（`openkoto.com/mcp`，OAuth 2.1）
- [ ] 网页云端 Agent（复用 MCP 工具集，操作记录可撤销）
- [ ] WebSocket 实时同步通知、数据导出、账号删除完整清理流程
- [ ] 自部署文档（服务端全部开源）
- **完成标准**：Pro 用户在四端都能直接使用 AI、扣费准确；用自然语言让 Agent 完成"翻译这首歌并把 N2 以上生词加入词包"

关键依赖链：P0 协议定稿 → P1 iOS 同步 → P2 桌面同步。网页端 UI 可以与客户端改造并行推进；P4 的支付可以提前到 P3 并行开发。

## 14. 测试策略

| 层级 | 内容 | 工具 |
|---|---|---|
| 协议契约 | `fixtures/sync/`：LWW、冲突重推、幂等、墓碑、cursor 过期、复习事件乱序重放、外键延迟到达；四端实现都跑同一套用例 | TS / Swift / Rust 各自的测试框架读取同一份 JSON |
| 服务端单测 | 路由、权限、点数 reserve / settle / refund 与并发扣点 | `@cloudflare/vitest-pool-workers` |
| 多端模拟 | 用脚本模拟 3 台设备，随机离线、编辑、删除、时钟偏移 ±1 天，最终状态必须收敛 | 基于 sync-client 的属性测试（fast-check） |
| FSRS | 黄金用例（已有），新增 TS 端 | vitest |
| 迁移 | 桌面 JSON → SQLite（使用真实用户数据样本脱敏后的 fixture）；iOS v11 → v12 | 各端测试框架 |
| E2E | 网页：登录 → 导入 → 阅读 → 收藏 → 复习；桌面现有 Playwright 扩展 | Playwright |
| 支付 | Creem test mode、StoreKit Testing in Xcode、App Store Sandbox 通知 | |
| 压测 | 1000 名虚拟用户同步 + AI 调用，观察 DO 延迟与错误率 | k6 |

---

## 15. 风险与开放问题

1. **桌面 SQLite 迁移风险最高**：老用户数据格式多样（SM-2 旧字段、`pack_ids` JSON、localStorage 进度）。缓解：迁移前自动备份、迁移失败时回退到 JSON 只读模式、先在 beta 渠道灰度。
2. **iOS 从 HLC 前的数据迁移**：已有记录没有 HLC。首次生成时用 `updated_at` 合成 HLC（计数器为 0），接受少量历史冲突按墙钟判定。
3. **Segment 数据量**：长篇小说全部切分后会有数十万条 segment。缓解：按章节懒切分（§8.2）；按需拉取（pull 支持 `parentId` 过滤，列入 P2 评估）。
4. **网页 EPUB 渲染兼容性**：复杂排版、竖排日文书籍。需要在 P2 早期用 10 本样本书做选型验证。
5. **托管 AI 成本失控**：模型降价与涨价都很快。缓解：单价配置化、每用户每日上限、翻译缓存、异常用量告警。
6. **开放问题**：
   - (a) 免费用户同步配额的最终数值；
   - (b) Android 是否纳入下一期（协议已兼容）；
   - (c) 视频功能后续上云时，媒体文件存储的成本模型；
   - (d) 自部署版本的支持范围（服务端已全部开源，需要决定官方是否提供自部署支持与升级保障）；
   - (e) 国内用户比例与访问质量的实测数据。

---

## 附：关键参考文件

| 文件 | 用途 |
|---|---|
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKPersistence/SyncEngine.swift` | 同步协议接口（`HTTPSyncEngine` 实现目标） |
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKPersistence/CloudKitSyncEngine.swift` | 现有同步循环、水位线、去回声、两轮 push 的参考实现 |
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKPersistence/CloudRecord.swift` | 记录类型与 `mergeOrder` |
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKPersistence/ContentRepository+Cloud.swift` | 与传输无关的 pending / apply 逻辑、冲突与重放 |
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKFeatures/Transfer/ContentStore+Sync.swift` | 同步引擎装配点（需改为注入） |
| `openkoto-ios/Packages/OpenKotoKit/Sources/OKPersistence/AppDatabase.swift` | 桌面 SQLite 表结构对齐基准 |
| `textlingo-desktop/src-tauri/src/storage.rs` / `types.rs` | 桌面现有 JSON 存储与类型 |
| `textlingo-desktop/src-tauri/src/transfer_export.rs` | 桌面 → 传输包字段映射（迁移可复用） |
| `textlingo-desktop/src-tauri/src/fsrs.rs` / `docs/specs/vocabulary-srs-spec.md` | FSRS 与复习事件规范 |
| `textlingo-desktop/src-tauri/src/ai_service.rs` / `OKAIClient/PromptLibrary.swift` | Prompt 来源（迁入 `@openkoto/core`） |
| `koto_intro_web/src/extensions/payment/` | Creem 接入参考 |
