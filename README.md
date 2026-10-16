# 丝译 Silk Translate · Beta

面向大众的 Chrome 网页翻译扩展（Manifest V3）。只使用 **Silk AI 云端翻译**：经 Silk 后端调用 [OpenRouter](https://openrouter.ai) 上的大模型，装好即用，无需 API Key。**测试版期间免费，每天 200 万字额度。**
界面支持**简体中文与 English**（默认跟随浏览器语言，可在面板中切换）。
扩展：TypeScript + esbuild，无前端框架、无运行时依赖。后端：Cloudflare Worker（`server/`）。

*English: a Chrome extension for in-place web page translation. It only uses the Silk AI cloud engine (no API key needed; free during the beta with 2,000,000 characters per day). During the beta it runs DeepSeek V4 Flash, the cheapest model; Claude Haiku 5.5, GPT-6 Sol and Gemini 3.8 Flash open after the beta. The interface is available in Simplified Chinese and English.*

## 功能

- **四个 AI 模型**（面板「AI 模型」中切换，译文按模型分开缓存）。**测试期间只开放最便宜的 DeepSeek V4 Flash**，其余三个在面板中显示为「正式版开放」，无法选择；后端同样只放行 DeepSeek V4 Flash。

  | 模型 | OpenRouter ID | 特点 | 每百万 token 输入 / 输出 | 测试期 |
  |---|---|---|---|---|
  | DeepSeek V4 Flash（默认） | `deepseek/deepseek-v4-flash` | 最便宜 · 中文强（关闭思考模式） | $0.091 / $0.182 | ✅ 开放 |
  | Claude Haiku 5.5 | `anthropic/claude-haiku-5.5` | 快速 | $0.10 / $0.50 | 🔒 |
  | GPT-6 Sol | `openai/gpt-6-sol` | 质量最高 | $2 / $10 | 🔒 |
  | Gemini 3.8 Flash | `google/gemini-3.8-flash` | 均衡 | $0.825 / $4.125 | 🔒 |

- **整页翻译，两种显示模式**
  - **覆盖原文**：译文直接写回原文本节点，链接、加粗、行内代码等格式原样保留。
  - **双语对照**：在段落下方（导航项、短标签则在行内）插入译文，样式可选「虚线下划线」或「高亮」。
  - 原文 / 覆盖 / 双语之间切换**完全来自内存缓存**，不会重新请求 API；切回原文后 DOM 与翻译前一致。
- **按需翻译**：只翻译视口及即将滚入的段落（IntersectionObserver），滚动时继续加载。
- **SPA 兼容**：MutationObserver 监听动态插入的内容和被框架改写的文本，自动补翻；页面原有的事件监听不受影响。
- **自动跳过**：已是目标语言的段落、`<pre>`/`<code>`、纯数字/时间等不送翻。
- **划词翻译**：选中文字后出现小图标，点击弹出流式翻译卡片，支持复制、朗读（Web Speech）；选中的文字若已是目标语言，自动反向翻译（如中 → 英）。
- **悬浮控制条**：页面右下角显示进度环，可切换模式、重试失败段落，空闲后自动收起。
- **快捷键**：默认 `Alt+T`，循环切换 原文 → 默认模式 → 另一种模式；可在面板中重新录制。
- **按网站记忆**：每个域名可设为「总是翻译」或「从不翻译」（同时禁用该站的划词翻译）。
- **12 种目标语言**：简体中文、繁體中文、English、日本語、한국어、Français、Deutsch、Español、Русский、Português、Italiano、Tiếng Việt。
- **中英文界面**：面板、悬浮控制条、划词卡片和错误提示都有中文与英文版本；「界面语言」可选「跟随浏览器」（中文浏览器显示中文，其余显示英文）、简体中文或 English。

## 安装

```bash
npm install
npm run build
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目下的 `dist/` 目录。
3. 点击工具栏中的丝译图标。测试期间固定使用 DeepSeek V4 Flash，无需设置；点「查看额度」可确认服务可用和今日剩余额度。

扩展安装前已打开的标签页无需刷新：在面板中点「翻译此页」时会自动注入脚本。

## 设置说明

| 项目 | 说明 |
|---|---|
| AI 模型 | DeepSeek V4 Flash（测试期唯一可用）/ Claude Haiku 5.5 / GPT-6 Sol / Gemini 3.8 Flash |
| 目标语言 | 整页翻译与划词翻译的目标语言 |
| 默认模式 | 点「翻译此页」或按快捷键时首先使用的模式 |
| 双语样式 | 虚线下划线 / 高亮 |
| 界面语言 | 跟随浏览器 / 简体中文 / English |
| 并发数 | 固定为 8，不能修改（所有标签页共用）。遇到 429 限流时并发自动减半、按 `Retry-After` 退避重试，之后逐步恢复；「今日额度用完」不会重试 |

从旧版本（带自定义 AI 接口、Google 翻译、Chrome 本地模型）升级时，扩展会在更新后自动删除本机保存的旧 API Key 和引擎设置。

## Silk AI 后端（`server/`）

Cloudflare Worker，作用是**把 OpenRouter 的 Key 留在服务器上**（写进扩展的 Key 一定会被人拆出来盗用），并给每个安装按日限额。

- 扩展首次使用时生成一个随机 UUID（安装 ID），请求时放在 `X-Silk-Install` 头里；不含任何个人信息。
- 每次请求按提示词字符数扣额度，UTC 0 点重置。三层限额都在 `server/wrangler.toml` 里调：
  - 每个安装：`INSTALL_DAILY_CHARS`（默认 200 万字）
  - 每个 IP：`IP_DAILY_CHARS`（默认 600 万字，防止反复重装刷额度）
  - 全站：`GLOBAL_DAILY_CHARS`（默认 2 亿字，钱包保护，超出后当天所有人暂停）
- 模型由客户端在请求的 `model` 字段中指定。`server/src/app.ts` 的 `MODELS` 是全部已知模型（与扩展的 `CLOUD_MODELS` 一致），未知模型返回 `400`；`PLAN_MODELS` 决定每个套餐能用哪些：测试版只有 `deepseek/deepseek-v4-flash`，`pro` 全部可用。请求套餐外的模型返回 `403` 并带 `X-Silk-Error: model_locked`，不扣额度；不传模型时用套餐的第一个。
- `GET /v1/entitlement` 会返回套餐可用的 `models`，扩展据此锁定面板里的其他模型；用户之前选了锁定的模型时，自动改用套餐默认模型。
- 同一个模型在 OpenRouter 上由多家服务商提供，速度差很多（DeepSeek V4 Flash 约 5–80 token/秒）。后端请求时带上 `provider.preferred_min_throughput`（`MIN_PROVIDER_THROUGHPUT`，默认 50）：达不到这个速度的服务商排到后面，只在其他都不可用时才用，所以总是先用「够快的里面最便宜的」。
- DeepSeek V4 Flash 支持推理模式，后端请求时带 `reasoning: { effort: "none" }` 关闭思考，避免多花输出 token（`MODEL_OPTIONS`）。
- 额度按字数计，不区分模型；正式版开放贵的模型时，建议按模型设不同额度（GPT-6 Sol 的价格约是 DeepSeek V4 Flash 的 30–50 倍）。
- OpenRouter 出错时会退还本次扣的额度，客户端的自动重试不会白扣额度。
- 接口：`GET /v1/entitlement`（套餐与今日额度）、`POST /v1/chat/completions`（OpenAI 兼容，流式）。JSON 响应统一为 `{ success, data, error, meta }`；额度用完返回 `429` 并带 `X-Silk-Error: quota_exceeded`。

### 部署

```bash
cd server
npm install
npx wrangler login                          # 浏览器授权 Cloudflare 账号
npx wrangler secret put OPENROUTER_API_KEY  # 粘贴 OpenRouter Key（https://openrouter.ai/keys）
npx wrangler deploy                         # 输出 https://silk-translate-api.<你的子域>.workers.dev
```

正式后端已部署在 `https://silk-translate-api.silktranslate.workers.dev`，并且是 `build.mjs` 的默认地址，直接 `npm run package` 即可。部署到别的地址时，用 `SILK_API_URL=… npm run package` 覆盖。

建议在 OpenRouter 后台给这个 Key 设置**消费上限**，作为全站额度之外的第二道保险。本地调试：`server/.dev.vars` 写入 `OPENROUTER_API_KEY=…` 后运行 `npm run dev`（`http://127.0.0.1:8787`），再用 `SILK_API_URL=http://127.0.0.1:8787 npm run build` 构建连本地后端的扩展。

### 构建参数

| 环境变量 | 说明 |
|---|---|
| `SILK_API_URL` | Silk 后端地址，默认是正式后端；会自动加入 manifest 的 `host_permissions`。只接受 https（本机可用 http） |
| `SILK_CHANNEL` | `beta`（默认：名称带 Beta，云端 AI 默认可用）或 `stable` |
| `SILK_OUTDIR` | 输出目录，默认 `dist` |

### 以后接入内购

付费逻辑只需改后端，扩展基本不用动：

- `src/shared/entitlement.ts` 定义套餐（`beta` / `free` / `pro`）和功能（目前只有 `cloud-ai`）。
- 后端 `server/src/app.ts` 的 `CURRENT_PLAN` 现在固定为 `beta`。接入支付（如 Stripe、Paddle）后，改成按安装 ID 或账户查询付费状态，并给不同套餐不同额度和模型（`PLAN_MODELS`）。
- 后端对没有权限的请求返回 `402`，扩展显示「当前套餐不包含 Silk AI 云端翻译」。扩展本地也会缓存套餐，提前拦下注定失败的请求，但真正的限制以后端为准。
- 正式版用 `SILK_CHANNEL=stable` 构建：服务器回复前默认按免费版处理。

## 隐私

- 待翻译的网页文本会发送到 Silk 后端，再转给 OpenRouter 上所选的模型；后端不保存文本，只按匿名安装 ID 记录当天用了多少字。
- 设置只保存在本机 `chrome.storage.local`；扩展不包含任何统计或第三方请求。
- 所有扩展 UI 渲染在独立的 Shadow DOM 中，不影响页面样式。

## 开发

```bash
npm run dev         # esbuild watch（改 manifest/html/css 后需重新运行）
npm run typecheck   # tsc --noEmit
npm test            # Vitest 单元测试（jsdom）
npm run coverage    # 覆盖率报告
npm run e2e         # Playwright 真浏览器端到端测试（自动构建一份连 mock 后端的版本）
npm run icons       # 重新生成 static/icons 下的 PNG 图标
```

E2E 使用本地 mock 服务器模拟 Silk 后端：SSE 流式响应、429 限流、并发统计、额度查询、匿名安装 ID、按套餐锁定模型（测试版 / 正式版）、额度用完，以及中英文界面切换；不消耗真实 API 额度，截图输出到 `e2e/output/`。
后端的单元测试在 `tests/server.test.ts`，和扩展一起由 `npm test` 运行。
如 Playwright 浏览器装在非默认位置，请设置 `PLAYWRIGHT_BROWSERS_PATH`。

### 目录结构

```
src/
├── background/   Service Worker：Silk 后端调用（SSE + 重试）、匿名安装 ID 与套餐、LRU 缓存、并发池
├── content/      内容脚本：DOM 扫描与分段、翻译单元渲染、懒加载、SPA 监听
│   └── ui/       Shadow DOM UI：悬浮控制条、划词翻译卡片
├── core/         与浏览器无关的纯逻辑：markup 序列化/还原、流式 JSON 解析、SSE、并发池、文本过滤、prompt
├── popup/        工具栏面板
└── shared/       设置（含输入校验与模型列表）、界面文案（i18n）、消息协议、语言表、快捷键、套餐
static/           manifest.json 与图标
server/           Silk 后端（Cloudflare Worker）：OpenRouter 代理、模型白名单、按日限额（Durable Object）、套餐
tests/            单元测试（含后端）
e2e/              端到端测试（fixture 页面 + mock 后端）
```

### 工作原理

1. 内容脚本把页面切成「段落单元」：块级元素内连续的行内内容为一段，行内标签序列化为带编号的标记（格式文本如 `<g0>…</g0>`，代码、图片等原样保留为 `<c1/>`），让模型在保留格式的前提下调整语序。
2. 进入视口的段落以 60ms 为窗口合并成批，通过 `chrome.runtime.Port` 发给后台；后台要求模型输出 JSON 对象并**边流式接收边解析**，每完成一段立即回传渲染。
   - 回复时间和回复长度成正比，所以一屏文字会尽量平均拆到 8 个并发请求里（每批至少 400 字、最多 1800 字 / 12 段），而不是挤在一两个大请求里。
   - 屏幕上看得到的段落先发，下方预加载区域的段落排在后面。
3. 模型漏译的段落单独重试一次；仍失败的段落在悬浮条中显示，可一键重试。
4. 端口断开（标签页关闭或跳转）时会中止对应的 HTTP 请求，不浪费额度。
