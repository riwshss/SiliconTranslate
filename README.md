# 丝译 Silk Translate · Beta

面向大众的 Chrome 网页翻译扩展（Manifest V3）。默认使用 **Silk AI 云端翻译**：通过 [OpenRouter](https://openrouter.ai) 聚合平台调用大模型，装好即用，无需 API Key。**测试版期间所有功能免费**（每天有免费额度）。
也支持自带 Key 的 OpenAI 兼容接口（如 [硅基流动](https://siliconflow.cn)）、Google 翻译 API，以及 Chrome 内置的本地模型（Translator API / Gemini Nano）。
扩展：TypeScript + esbuild，无前端框架、无运行时依赖。后端：Cloudflare Worker（`server/`）。

## 功能

- **五种翻译引擎**（面板「翻译服务」中切换，译文按引擎分开缓存）

  | 引擎 | 说明 |
  |---|---|
  | Silk AI 云端翻译（默认） | 经 Silk 后端调用 OpenRouter 上的大模型，无需 Key；测试期免费，按日限额。以后作为付费功能 |
  | 自定义 AI 接口（OpenAI 兼容） | 自带 Key，可接硅基流动、OpenRouter 或任意 OpenAI 兼容服务 |
  | Google 翻译 API | Cloud Translation（Basic v2），需要 Google Cloud API Key |
  | Chrome 内置翻译（本地） | Chrome 自带的 Translator API，内容不离开本机，无需 Key |
  | Chrome 内置 Gemini Nano（本地 · 实验） | Chrome 自带的 Prompt API 小模型，内容不离开本机 |

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

## 安装

```bash
npm install
npm run build
```

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择项目下的 `dist/` 目录。
3. 点击工具栏中的丝译图标，在「翻译服务」中选择引擎：
   - **Silk AI 云端翻译**（默认）：无需设置，点「查看额度」可确认服务可用和今日剩余额度。需要先部署后端，见下文「Silk AI 后端」。
   - **自定义 AI 接口**：填入 API Key（例如在 [硅基流动控制台](https://cloud.siliconflow.cn/account/ak) 创建），点「测试连接」。
   - **Google 翻译 API**：在 [Google Cloud 控制台](https://console.cloud.google.com/apis/credentials) 启用 Cloud Translation API 并创建 API Key，填入后点「测试连接」。
   - **Chrome 内置**：点「检查 / 下载模型」，等待模型下载完成。

扩展安装前已打开的标签页无需刷新：在面板中点「翻译此页」时会自动注入脚本。

## 设置说明

| 项目 | 说明 |
|---|---|
| 目标语言 | 整页翻译与划词翻译的目标语言 |
| 默认模式 | 点「翻译此页」或按快捷键时首先使用的模式 |
| 双语样式 | 虚线下划线 / 高亮 |
| 模型（自定义接口） | 预设 `Qwen/Qwen2.5-7B-Instruct`（免费、快），也可从「测试连接」拉取的列表中选择或手动输入。Qwen3 系列会自动关闭思考模式 |
| 并发数 | 1–8，默认 4。遇到 429 限流时会自动按 `Retry-After` 退避重试；Silk AI 的「今日额度用完」不会重试 |
| 接口地址（自定义接口） | 默认 `https://api.siliconflow.cn/v1`，可改为任意 OpenAI 兼容接口 |

## Silk AI 后端（`server/`）

Cloudflare Worker，作用是**把 OpenRouter 的 Key 留在服务器上**（写进扩展的 Key 一定会被人拆出来盗用），并给每个安装按日限额。

- 扩展首次使用时生成一个随机 UUID（安装 ID），请求时放在 `X-Silk-Install` 头里；不含任何个人信息。
- 每次请求按提示词字符数扣额度，UTC 0 点重置。三层限额都在 `server/wrangler.toml` 里调：
  - 每个安装：`INSTALL_DAILY_CHARS`（默认 20 万字）
  - 每个 IP：`IP_DAILY_CHARS`（防止反复重装刷额度）
  - 全站：`GLOBAL_DAILY_CHARS`（钱包保护，超出后当天所有人暂停）
- 模型由服务器决定（`OPENROUTER_MODEL`，默认 `google/gemini-2.5-flash-lite`，输入 $0.10 / 输出 $0.40 每百万 token），客户端传什么模型都会被忽略。
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

- `src/shared/entitlement.ts` 定义套餐（`beta` / `free` / `pro`）和功能（目前只有 `cloud-ai`）。只有 Silk AI 这种要花钱的引擎受套餐限制；自带 Key 和本地模型永远免费。
- 后端 `server/src/app.ts` 的 `CURRENT_PLAN` 现在固定为 `beta`。接入支付（如 Stripe、Paddle）后，改成按安装 ID 或账户查询付费状态，并给不同套餐不同额度。
- 后端对没有权限的请求返回 `402`，扩展显示「当前套餐不包含 Silk AI 云端翻译」。扩展本地也会缓存套餐，提前拦下注定失败的请求，但真正的限制以后端为准。
- 正式版用 `SILK_CHANNEL=stable` 构建：服务器回复前默认按免费版处理。

### Google 翻译 API

- 使用 Cloud Translation Basic（v2）。按字符计费，每月前 50 万字符免费。
- API Key 不要设置「HTTP 引荐来源」限制，因为扩展发出的请求不带网页 Referer。可以改为限制「仅允许 Cloud Translation API」。
- 首次选择或测试 Google 引擎时，Chrome 会请求 `translation.googleapis.com` 的访问权限。

### Chrome 内置模型

- 需要桌面版 Chrome 138 及以上；不支持移动端。
- 第一次使用前，需要在面板中点「检查 / 下载模型」：Chrome 只允许在用户点击时开始下载模型。
  - 「Chrome 内置翻译」会下载语言检测模型，以及「当前网页语言 → 目标语言」「英语 → 目标语言」两个翻译模型。翻译其他语言的网页前，在该网页上再点一次即可。
  - 下载进度也可以在 `chrome://on-device-translation-internals`（翻译）或 `chrome://on-device-internals`（Gemini Nano）中查看。
- Gemini Nano 的硬件要求：22 GB 可用磁盘空间，以及 4 GB 以上显存，或 16 GB 内存加 4 核 CPU。官方目前只支持英、日、西、德、法输出，中文等其他目标语言请优先使用「Chrome 内置翻译」。
- 本地模型在扩展的 offscreen 文档中运行，因为 Service Worker 里没有这些 API；切回云端引擎后会自动关闭。

### 自定义接口地址

- 只接受 `https://`；`http://` 仅允许 `localhost` / `127.0.0.1`，避免 API Key 以明文传输。
- 本机服务（Ollama、LM Studio、one-api 等）已在 manifest 中授权，直接可用。
- 其他 https 域名（如国际站 `api.siliconflow.com`、自建代理）在修改地址或点「测试连接」时，Chrome 会弹窗请求该域名的访问权限，同意后即可使用。

## 隐私

- 使用 Silk AI 时，待翻译的网页文本会发送到 Silk 后端，再转给 OpenRouter 上的模型；后端不保存文本，只按匿名安装 ID 记录当天用了多少字。
- API Key 与设置只保存在本机 `chrome.storage.local`，仅发送给对应的接口（你配置的地址 / Google）。
- 选择 Chrome 内置引擎时，网页内容完全在本机处理，不发出任何翻译请求。
- 网页内容只在翻译时发送给该接口；扩展不包含任何统计或第三方请求。
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

E2E 使用本地 mock 服务器模拟 SSE 流式响应、429 限流、并发统计，以及 Silk 后端（额度查询、匿名安装 ID、额度用完），不消耗真实 API 额度；截图输出到 `e2e/output/`。
后端的单元测试在 `tests/server.test.ts`，和扩展一起由 `npm test` 运行。
如 Playwright 浏览器装在非默认位置，请设置 `PLAYWRIGHT_BROWSERS_PATH`。

### 目录结构

```
src/
├── background/   Service Worker：API 调用（SSE + 重试）、Google 翻译、引擎分发、LRU 缓存、并发池
├── content/      内容脚本：DOM 扫描与分段、翻译单元渲染、懒加载、SPA 监听
│   └── ui/       Shadow DOM UI：悬浮控制条、划词翻译卡片
├── core/         与浏览器无关的纯逻辑：markup 序列化/还原、流式 JSON 解析、SSE、并发池、文本过滤、prompt
├── offscreen/    offscreen 文档：承载 Chrome 内置 AI（Translator / LanguageDetector / Gemini Nano）
├── popup/        工具栏面板
└── shared/       设置（含输入校验）、消息协议、语言表、快捷键、Chrome 内置 AI 封装
static/           manifest.json 与图标
server/           Silk 后端（Cloudflare Worker）：OpenRouter 代理、按日限额（Durable Object）、套餐
tests/            单元测试（含后端）
e2e/              端到端测试（fixture 页面 + mock API）
```

### 工作原理

1. 内容脚本把页面切成「段落单元」：块级元素内连续的行内内容为一段，行内标签序列化为带编号的标记（格式文本如 `<g0>…</g0>`，代码、图片等原样保留为 `<c1/>`），让模型在保留格式的前提下调整语序。
2. 进入视口的段落以 60ms 为窗口合并成批，通过 `chrome.runtime.Port` 发给后台；后台要求模型输出 JSON 对象并**边流式接收边解析**，每完成一段立即回传渲染。
3. 模型漏译的段落单独重试一次；仍失败的段落在悬浮条中显示，可一键重试。
4. 端口断开（标签页关闭或跳转）时会中止对应的 HTTP 请求，不浪费额度。
