# OpenKoto 云服务部署与运维手册

> 适用：`server/worker`（Cloudflare Worker，同时托管网页端 `apps/web` 的静态资源）
> 更新：2026-09-28

## 1. 环境一览

| 环境 | 地址 | D1 | R2 | Queue | 支付 |
|---|---|---|---|---|---|
| 本地 | http://localhost:5174（网页）→ :8787（Worker） | 本地模拟 | 本地模拟 | 本地模拟 | — |
| staging | https://openkoto-api-staging.beiming1201.workers.dev | `openkoto-staging` | `openkoto-files-staging` | `openkoto-jobs-staging` | Creem 测试模式 / App Store Sandbox |
| production | https://openkoto.com（**域名尚未注册**） | `openkoto` | `openkoto-files` | `openkoto-jobs` | Creem 正式 / App Store |

staging 与 production 的资源都已在 Cloudflare 账号中创建，配置写在 `server/worker/wrangler.jsonc`（顶层为生产，`env.staging` 为测试）。

## 2. 本地开发

```bash
pnpm install
cd server/worker && npx wrangler d1 migrations apply openkoto --local
```

`server/worker/.dev.vars`（已被 gitignore）至少需要：

```
APP_ORIGIN=http://localhost:5174
EMAIL_PROVIDER=console
BETTER_AUTH_SECRET=<openssl rand -hex 32>
JWT_PRIVATE_KEY="<node scripts/gen-jwt-key.mjs 的输出>"
```

然后分别启动 `pnpm dev:worker` 和 `pnpm --filter @openkoto/web exec vite --port 5174`（也可以用 `.claude/launch.json` 里的两个配置）。邮箱验证码会打印在 Worker 日志里。

## 3. 上线前必须由你本人完成的事

这些步骤涉及购买、密钥或你的个人账号，没有代为操作：

1. **域名**：统一使用 `openkoto.com`（已在同一 Cloudflare 账号下，原计划的 `openkoto.app` 不再使用）。官网、文档与应用全部由 Worker 提供，不再使用 Vercel。首次生产部署前，在 Cloudflare → openkoto.com → DNS 删除指向 Vercel 的两条记录（根域名 A `216.150.1.1`、`www` CNAME `*.vercel-dns-016.com`），否则 Worker 自定义域名绑定会失败。
2. **App Store Connect**：把隐私政策 URL 改成 `https://openkoto.com/privacy`，营销网址改成 `https://openkoto.com`（旧链接 `/privacy-policy` 也会 301 跳转）。
3. **Google 登录密钥**（JS 来源、回调 `https://openkoto.com/api/auth/callback/google`、Branding 页的主页/隐私/条款链接已于 2026-09-29 改到 openkoto.com）：Google Cloud → 项目 `textlingo` → Google Auth Platform → Clients → **OpenKoto Web** → Add secret，然后：
   ```bash
   cd server/worker
   npx wrangler secret put GOOGLE_CLIENT_SECRET            # 生产
   npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
   ```
   域名上线、`/privacy` 可以访问之后，在 Audience 页面点 **Publish app**（目前是 Testing 状态，只有测试用户能登录）。
4. **Creem**：
   - 测试模式里已经创建了 4 个商品和一个指向 staging 的 webhook（见 §5）。你需要把测试 API Key 和 webhook 签名密钥写进 staging：
     ```bash
     npx wrangler secret put CREEM_API_KEY --env staging
     npx wrangler secret put CREEM_WEBHOOK_SECRET --env staging
     ```
   - 正式模式（2026-09-29 已建）：Plus (Yearly) `prod_6Ymabyy9r3KEDzfWQCRYcB` $9.49/yr、Pro (Monthly) `prod_16RrXYuvKqwEsuQsB3Na2R` $3.89/mo、Pro (Yearly) `prod_2qwYiPMKYdOJT1OoCcF1eU` $35.99/yr、AI Credits (3,000) `prod_3DPsHkwaB8S7aAwBqFkiQz` $4.19，已写入顶层 `vars.CREEM_PRODUCTS`；webhook "OpenKoto production" → `https://openkoto.com/api/webhooks/creem`。还需要 `wrangler secret put CREEM_API_KEY` / `CREEM_WEBHOOK_SECRET`（不加 `--env`，用正式模式的值）。
5. **App Store**：
   - App Store Connect 中创建内购：`com.openkoto.plus.month`（¥8）、`com.openkoto.plus.year`（¥68）、`com.openkoto.pro.month`（¥28）、`com.openkoto.pro.year`（¥258），放在同一个订阅群组；消耗型 `com.openkoto.credits.3000`（¥28，App Store 没有 ¥30 档位）。
   - 加入 App Store 小型企业计划（佣金 15%）。
   - 创建 In-App Purchase API 密钥，然后：
     ```bash
     npx wrangler secret put APPSTORE_ISSUER_ID
     npx wrangler secret put APPSTORE_KEY_ID
     npx wrangler secret put APPSTORE_PRIVATE_KEY   # .p8 文件内容
     ```
   - App Store Server Notifications V2 地址：`https://openkoto.com/api/webhooks/appstore`（沙盒填 staging 地址）。**2026-09-30 已设置**，订阅群组 "OpenKoto"（ID 22425469）与 5 个内购（4 个订阅 + `com.openkoto.credits.3000` 消耗型）也已创建，但价格、本地化显示名与描述尚未填写。
   - **下一个带云同步的 iOS 版本提交时**：App 隐私里目前是"未收集数据"，需要改为收集"电子邮件地址（账户）、用户内容（同步的生词/书籍/歌词）、用户 ID、购买项目"；隐私政策网址改为 `https://openkoto.com/privacy`（只能随新版本修改）；首个订阅群组和内购必须随该版本一起提交审核。
   - 在开发者后台给 App ID `com.openkoto.ios` 打开 **Sign in with Apple**。
6. **Apple 网页登录（可选）**：Services ID + 私钥生成的 client secret（有效期最长 6 个月）写入 `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET`。
7. **托管 AI**：`AI_API_KEY`（例如 DeepSeek），可选 `AI_API_BASE` / `AI_MODEL`。
8. **邮件**：生产 `EMAIL_PROVIDER=cloudflare`，走 Cloudflare Email Service（`send_email` 绑定 `EMAIL`，Workers 付费计划每月含 3000 封，之后 $0.35/千封）。`openkoto.com` 已于 2026-09-29 在 Email Service → 邮件发送中接入并激活（DNS：`cf-bounce` 子域的 MX/SPF/DKIM 与 `_dmarc`），每日额度 1000 封。备选：把 `EMAIL_PROVIDER` 改成 `resend` 并设置 `RESEND_API_KEY`。

## 4. 部署命令

```bash
pnpm --filter @openkoto/web build           # 构建网页端到 apps/web/dist
cd server/worker
npx wrangler d1 migrations apply openkoto --remote          # 生产（staging 加 --env staging，库名 openkoto-staging）
npx wrangler deploy                                          # 生产
npx wrangler deploy --env staging                            # staging
```

首次部署生产前，还需要生成两个服务端密钥：

```bash
openssl rand -hex 32 | npx wrangler secret put BETTER_AUTH_SECRET
node scripts/gen-jwt-key.mjs | npx wrangler secret put JWT_PRIVATE_KEY
```

**不要轮换 `JWT_PRIVATE_KEY`**，除非你打算让所有设备重新登录（refresh token 仍然有效，但所有 access token 会立即失效，客户端会自动刷新）。

## 5. 已配置的第三方资源

| 资源 | 位置 | 值 |
|---|---|---|
| Google OAuth Web 客户端 | GCP 项目 `textlingo` → OpenKoto Web | Client ID `506826712750-uubvvapb2v0l976jutqsree5gaavq3jd.apps.googleusercontent.com`；回调已包含 openkoto.com、localhost:5173 和 staging |
| Google 同意屏幕 | 同上 → Branding | 应用名 OpenKoto，首页 / 隐私 / 条款指向 openkoto.com，授权域名新增 openkoto.com |
| Creem 测试商品 | 店铺 textlingo（测试模式） | Plus 年付 $9.49 `prod_6v5Z5VzHCJkH2Lw13OaCZN`；Pro 月付 $3.89 `prod_IOVBOniqHPSdkhfecE5Lu`；Pro 年付 $35.99 `prod_6wLJyGLDKYAsMSkMACVVFU`；积分 3000 $4.19 `prod_1Sq0hHek0znn21NM7qwlo1` |
| Creem 测试 webhook | 测试模式 → 网络钩子 | `OpenKoto staging` → staging `/api/webhooks/creem` |

## 6. 运营

- **生成激活码**（小红书等渠道销售）：用 `ADMIN_EMAILS` 中的账号登录网页后调用：
  ```bash
  curl -X POST https://openkoto.com/api/admin/codes \
    -H 'Content-Type: application/json' -H 'Origin: https://openkoto.com' \
    --cookie '<登录后的会话 cookie>' \
    -d '{"batch":"xhs-2026-10","plan":"plus","durationDays":365,"credits":0,"count":50}'
  ```
  响应里的激活码**只出现这一次**，数据库只保存哈希。`GET /api/admin/codes` 查看各批次的兑换情况。
- **每日定时任务**（03:17 UTC）：清理过期授权码和 refresh token，执行冷静期已满的账号删除。
- **日志**：`npx wrangler tail`（staging 加 `--env staging`）。
- **备份**：D1 支持 Time Travel（30 天）；UserVault 的数据可以通过 `/api/v1/account/export` 按用户导出。
