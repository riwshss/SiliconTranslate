# 丝译 Silk Translate · Beta

面向大众的 Chrome 网页翻译扩展（Manifest V3）。只使用 **Silk AI 云端翻译**：经 Silk 后端调用 [OpenRouter](https://openrouter.ai) 上的大模型，装好即用，无需 API Key。**测试版期间免费，每天 10 万字额度。**
界面支持**繁體中文（台湾用语）、简体中文与 English**（默认跟随浏览器语言，可在面板中切换）。产品定位和路线图见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。
扩展：TypeScript + esbuild，无前端框架、无运行时依赖。后端：Cloudflare Worker（`server/`）。

*English: a Chrome extension for in-place web page translation. It only uses the Silk AI cloud engine (no API key needed; free during the beta with 100,000 characters per day). During the beta it runs DeepSeek V4 Flash, the cheapest model; Claude Haiku 5.5, GPT-6 Sol and Gemini 3.8 Flash open after the beta. The interface is available in Traditional Chinese (Taiwan), Simplified Chinese and English.*

## 功能

- **四个 AI 模型**（面板「AI 模型」中切换，译文按模型分开缓存；商店描述在正式版开放前不写其他模型的名字）。**测试期间只开放最便宜的 DeepSeek V4 Flash**，其余三个在面板中显示为「正式版开放」，无法选择；后端同样只放行 DeepSeek V4 Flash。

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
- **13 种目标语言**：简体中文、繁體中文（台灣用語）、繁體中文（香港書面語）、English、日本語、한국어、Français、Deutsch、Español、Русский、Português、Italiano、Tiếng Việt。
- **繁中在地化**：繁體中文分台湾、香港两种目标语言。后端在提示词里附上当地用语指引（如台湾「影片、軟體、程式、資料、網路、品質」，香港「軟件、網絡、質素、的士」），不只是简体转字形；指引不计额度。新安装的默认目标语言取浏览器语言列表里第一个中文变体（zh-TW → 台湾，zh-HK / zh-MO → 香港，其他中文 → 简体），没有中文时为简体中文。
- **三种界面语言**：面板、悬浮控制条、划词卡片和错误提示都有繁體中文（台湾用语，人工撰写而非转字形）、简体中文和英文版本；「界面语言」默认跟随浏览器（zh-TW / zh-HK / zh-MO / zh-Hant → 繁體，其他中文 → 简体，其余 → English）。
- **按语言显示品牌名**：扩展名称和商店描述用 Chrome 的 `_locales`（`static/_locales/`）：繁中浏览器显示「絲譯」，简中显示「丝译」，其他语言显示「Silk Translate」。

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
| 界面语言 | 跟随浏览器 / 繁體中文 / 简体中文 / English |
| 并发数 | 固定为 8，不能修改（所有标签页共用）。遇到 429 限流时并发自动减半、按 `Retry-After` 退避重试，之后逐步恢复；「今日额度用完」不会重试 |

从旧版本（带自定义 AI 接口、Google 翻译、Chrome 本地模型）升级时，扩展会在更新后自动删除本机保存的旧 API Key 和引擎设置。

## Silk AI 后端（`server/`）

Cloudflare Worker，作用是**把 OpenRouter 的 Key 留在服务器上**（写进扩展的 Key 一定会被人拆出来盗用），并给每个安装按日限额。

- **安装令牌由服务器签发：** 扩展第一次需要时调用 `POST /v1/install`，后端生成安装 ID，返回 `token = id + "." + base64url(HMAC-SHA256(INSTALL_SECRET, id))`，扩展保存在本机，之后每个请求放在 `X-Silk-Install` 头里。后端每次用 `crypto.subtle` 验签（纯计算，不访问存储），伪造或篡改的令牌一律 `401`。每个 IP 每天最多签发 `INSTALLS_PER_IP_DAILY`（默认 3）个令牌，防止换 ID 刷额度；超出时返回 `429 install_limited`，扩展提示「所在网络今天新安装次数已达上限」。令牌不含任何个人信息；后端返回 `401` 时扩展丢掉旧令牌，下次请求自动申请新的。
- **客户端只发数据，提示词由后端拼：** `POST /v1/translate` 的请求体是 `{ model?, target, title?, kind: "page" | "selection", texts }`。`target` 必须是 12 个语言代码之一，`title` ≤ 200 字；`page` 每次 1–12 段、每段 ≤ 6000 字（与扩展 `MAX_MARKUP_CHARS` 一致），`selection` 恰好 1 段、≤ 5000 字。提示词用的是扩展同一份 `src/core/prompt.ts`（wrangler 会一起打包），所以这个接口不能被当成通用的大模型 API 用。
- **只按原文字数扣额度**，没有最低收费；输出上限仍按 `原文字数 × 2 + 256` token 封顶。UTC 0 点重置。限额都在 `server/wrangler.toml` 里调：
  - 每个安装：`INSTALL_DAILY_CHARS`（默认 10 万字，与正式版免费档准备给的水平一致）
  - 每个 IP：`IP_DAILY_CHARS`（默认 30 万字）
  - 全站：`GLOBAL_DAILY_CHARS`（默认 2 亿字，钱包保护）。拆成 16 个分片计数（每片上限是总数的 1/16），每次随机选一片，**在响应返回后**用 `ctx.waitUntil` 异步扣，不阻塞请求；任何一片报告超额，这个 Worker 实例当天剩下的时间里拒绝新请求。安装和 IP 两层仍然同步扣（两个 DO 并行调用）。
- **共享翻译缓存：** 每一段的译文按 `sha256(模型|目标语言|kind|原文)` 存进 Cloudflare 缓存（`caches.default`，7 天）。请求进来先逐段查缓存，命中的段落立刻流式返回、不扣额度，只把没命中的发给 OpenRouter。看起来被截断或丢了格式标记的译文不进缓存。⚠️ `caches.default` 只在挂了自定义域名的 Worker 上可靠生效，`*.workers.dev` 上可能是空操作，上线后请用指标里的 `cacheHits` 确认。
- **响应格式：** `text/event-stream`，每行一个事件：`{"index":0,"text":"…"}`（整页，一段译完一行）、`{"delta":"…"}`（划词，流式片段）、`{"error":{"code","message"}}`，最后是 `[DONE]`。没有缓存命中时，上游失败直接返回 HTTP 错误（`502 upstream_error`，扩展会自动重试）；已经先发了缓存段落时，上游失败以 `error` 事件结束，只退还没送达段落的额度。
- 模型由客户端在请求的 `model` 字段中指定。`server/src/app.ts` 的 `MODELS` 是全部已知模型（与扩展的 `CLOUD_MODELS` 一致），未知模型返回 `400`；`PLAN_MODELS` 决定每个套餐能用哪些：测试版只有 `deepseek/deepseek-v4-flash`，`pro` 全部可用。请求套餐外的模型返回 `403` 并带 `X-Silk-Error: model_locked`，不扣额度；不传模型时用套餐的第一个。
- **请求体只能有这五个字段**，带 `messages`、`system` 等任何其他字段一律 `400`。
- **共享缓存和扩展缓存的键都包含 `PROMPT_VERSION`**（`src/core/prompt.ts`）：改了会影响译文的提示词（比如用语指引）时把它加 1，否则 7 天内仍会拿到旧译文。
- `GET /v1/entitlement` 会返回套餐可用的 `models`，扩展据此锁定面板里的其他模型；用户之前选了锁定的模型时，自动改用套餐默认模型。
- 同一个模型在 OpenRouter 上由多家服务商提供，速度差很多（DeepSeek V4 Flash 约 5–80 token/秒）。后端请求时带上 `provider.preferred_min_throughput`（`MIN_PROVIDER_THROUGHPUT`，默认 50）：达不到这个速度的服务商排到后面，只在其他都不可用时才用，所以总是先用「够快的里面最便宜的」。
- DeepSeek V4 Flash 支持推理模式，后端请求时带 `reasoning: { effort: "none" }` 关闭思考，避免多花输出 token（`MODEL_OPTIONS`）。
- 系统提示词是常量，目标语言和页面标题放在 user 消息里，服务商的前缀缓存可以跨语言、跨页面、跨用户命中。
- **性能指标：** 每个 `/v1/translate` 请求往 Workers Analytics Engine（绑定 `METRICS`，数据集 `silk_translate_requests`）写一个数据点：`blobs = [模型, 服务商, 错误码, kind]`，`doubles = [原文字数, 首个 token 耗时 ms, 总耗时 ms, 命中提示词缓存的 token 数, 共享缓存命中段数]`。服务商和缓存 token 数取自 OpenRouter 流的 `provider` 字段和最后一个 chunk 的 `usage.prompt_tokens_details.cached_tokens`（OpenRouter 现在默认在每个响应里返回 usage，不需要再传参数）。
- 额度按字数计，不区分模型；正式版开放贵的模型时，建议按模型设不同额度（GPT-6 Sol 的价格约是 DeepSeek V4 Flash 的 30–50 倍）。
- OpenRouter 出错时会退还本次扣的额度，客户端的自动重试不会白扣额度。
- 接口：`POST /v1/install`（签发安装令牌）、`GET /v1/entitlement`（套餐与今日额度）、`POST /v1/translate`（翻译，流式）。JSON 响应统一为 `{ success, data, error, meta }`；额度用完返回 `429` 并带 `X-Silk-Error: quota_exceeded`。
- **旧版过渡：** v2.2 及更早的扩展用自己生成的 UUID 调用 `POST /v1/chat/completions`。在 `LEGACY_UNTIL`（默认 2026-10-31）之前，这个接口和未签名的 UUID 继续可用，但它们发来的所有请求共用每天 `LEGACY_DAILY_CHARS`（默认 20 万字）；之后 `/v1/chat/completions` 返回 `410`，未签名的 UUID 返回 `401`。

### 部署

```bash
cd server
npm install
npx wrangler login                          # 浏览器授权 Cloudflare 账号
npx wrangler secret put OPENROUTER_API_KEY  # 粘贴 OpenRouter Key（https://openrouter.ai/keys）
npx wrangler secret put INSTALL_SECRET      # 签发安装令牌的密钥，例如 `openssl rand -base64 32` 的输出；更换后所有安装会自动重新申请令牌
npx wrangler deploy                         # 输出 https://silk-translate-api.<你的子域>.workers.dev
```

**先部署后端，再发布 v2.3 扩展**：新版扩展只用 `/v1/install` 和 `/v1/translate`，旧后端没有这两个接口。

推送 `server-v*` 标签（如 `git tag server-v2.3.0 && git push origin server-v2.3.0`）时，GitHub Actions 会在测试通过后自动 `wrangler deploy`，需要在仓库 Secrets 里配置 `CLOUDFLARE_API_TOKEN`（Cloudflare 的「Edit Cloudflare Workers」模板即可）。

正式后端已部署在 `https://silk-translate-api.silktranslate.workers.dev`，并且是 `build.mjs` 的默认地址，直接 `npm run package` 即可。部署到别的地址时，用 `SILK_API_URL=… npm run package` 覆盖。

建议在 OpenRouter 后台给这个 Key 设置**消费上限**，作为全站额度之外的第二道保险。本地调试：`server/.dev.vars` 写入 `OPENROUTER_API_KEY=…` 和 `INSTALL_SECRET=…` 后运行 `npm run dev`（`http://127.0.0.1:8787`），再用 `SILK_API_URL=http://127.0.0.1:8787 npm run build` 构建连本地后端的扩展。

### 构建参数

| 环境变量 | 说明 |
|---|---|
| `SILK_API_URL` | Silk 后端地址，默认是正式后端；会自动加入 manifest 的 `host_permissions`。只接受 https（本机可用 http） |
| `SILK_CHANNEL` | `beta`（默认：名称带 Beta，云端 AI 默认可用）或 `stable` |
| `SILK_OUTDIR` | 输出目录，默认 `dist` |

### 开发者账号

给自己用的安装可以设成 `dev` 套餐：**四个模型都能选，没有每日额度，也不受全站熔断限制**（用量仍计入全站统计，指标里 `plan = dev`，方便和真实用户分开看）。

1. 在自己的浏览器里装好扩展，打开面板点一次「查看额度」（会自动申请安装令牌）。
2. 打开 `chrome://extensions` → 丝译 →「Service Worker」→ 控制台，执行：
   ```js
   (await chrome.storage.local.get('installToken')).installToken.split('.')[0]
   ```
   输出的 UUID 就是你的安装 ID。
3. 把它写进后端 secret（多个设备用逗号分隔），不需要重新部署代码：
   ```bash
   cd server && npx wrangler secret put DEV_INSTALL_IDS
   ```
4. 回到面板点「查看额度」：显示「开发者 · 无限制」，所有模型解锁。

安装 ID 跟着扩展的本地存储走：卸载重装、换浏览器配置文件都会得到新的 ID，需要重新加进去。本地调试时写进 `server/.dev.vars` 的 `DEV_INSTALL_IDS=…`。

### 以后接入内购

付费逻辑只需改后端，扩展基本不用动：

- `src/shared/entitlement.ts` 定义套餐（`beta` / `free` / `pro`）和功能（目前只有 `cloud-ai`）。
- 后端 `server/src/app.ts` 的 `resolvePlan(installId)` 先查 KV（绑定 `PLANS`，键 `plan:<id>`），查不到就用 `DEFAULT_PLAN`（测试期是 `beta`，没设置时是 `free`）。`/v1/entitlement` 和 `/v1/translate` 都走这个函数，以后支付回调只需要写 KV；`wrangler.toml` 里留了 KV 绑定的注释。正式上线时把 `DEFAULT_PLAN` 改成 `free`。
- 后端对没有权限的请求返回 `402`，扩展显示「当前套餐不包含 Silk AI 云端翻译」。扩展本地也会缓存套餐，提前拦下注定失败的请求，但真正的限制以后端为准。
- **免费层用 Chrome 内置翻译：** 套餐不含云端 AI 时，内容脚本检测 `'Translator' in self`：可用就用浏览器自带的本地翻译（Translator API，源语言用 LanguageDetector 或页面 `lang` 判断；本地翻译不保留链接等格式标记，按纯文本显示），本地翻不了的段落再交给云端（以后给免费档少量 AI 额度）。Translator API 要求的 Chrome 版本比 `minimum_chrome_version: 116` 高，所以只做特性检测，不提高最低版本。目前只用于整页翻译，划词翻译仍走云端。
- 正式版用 `SILK_CHANNEL=stable` 构建：服务器回复前默认按免费版处理。

## 隐私

- 待翻译的网页文本会发送到 Silk 后端，再转给 OpenRouter 上所选的模型；后端只按匿名安装 ID 记录当天用了多少字。
- **共享翻译缓存：** 为了更快、更省，后端把每一段的译文按「模型 + 目标语言 + 原文」的哈希缓存 7 天，其他用户翻译**完全相同的原文**时直接复用。缓存的键是原文的 SHA-256，拿到某段译文的前提是已经拥有一字不差的原文，所以不会泄露别人页面的内容；缓存里不记录是谁、在哪个网页翻译的。（发布前请把这一条写进商店的隐私政策。）
- 扩展把译文缓存在本机（内存 + IndexedDB，最多 5 万条，超出删最旧的），不上传。
- 设置和安装令牌只保存在本机 `chrome.storage.local`；扩展不包含任何统计或第三方请求。后端的性能指标只记录模型、服务商、字数和耗时，不记录文本和安装 ID。
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

E2E 使用本地 mock 服务器模拟 Silk 后端：签发安装令牌、`/v1/translate` 事件流、429 限流、并发统计、额度查询、按套餐锁定模型（测试版 / 正式版 / 开发者）、额度用完，以及繁中、简中、英文界面切换；不消耗真实 API 额度，截图输出到 `e2e/output/`。
后端的单元测试在 `tests/server.test.ts`，和扩展一起由 `npm test` 运行。

**译文质量回归集**（不在 CI 里跑，会消耗真实额度）：`tests/fixtures/regression/paragraphs.json` 有 65 段，覆盖台湾 / 香港用语陷阱、行内标记、技术术语、长句和界面短句，每段可以标注必须出现、不能出现、必须原样保留的文字。

```bash
npm run regression -- --target zh-TW                          # 调用正式后端，结果写到 regression-output/
npm run regression -- --target zh-HK --model openai/gpt-6-sol  # 指定模型（需要开发者账号或对应套餐）
npm run regression -- --target zh-TW --baseline regression-output/<上一次>.json   # 和上一次逐段对比
```

报告（`.md`）列出没通过检查的段落、和基线相比有变化的段落（前后对照，供人工判断），以及首段耗时。改提示词前后各跑一次再对比；别忘了先把 `PROMPT_VERSION` 加 1，否则后端共享缓存会直接返回旧译文。安装令牌优先读 `SILK_TOKEN`，其次是 `regression-output/token.txt`，都没有时申请一个并保存。用开发者账号的令牌跑就不受每日额度限制。
如 Playwright 浏览器装在非默认位置，请设置 `PLAYWRIGHT_BROWSERS_PATH`；要用一个现成的 Chromium（版本和 Playwright 期望的不同也行），设置 `SILK_E2E_CHROMIUM=<chrome 可执行文件路径>`。
每次 push 和 PR 都会在 GitHub Actions（`.github/workflows/ci.yml`）里跑 `npm ci`、两边的类型检查和 `npm test`。

### 目录结构

```
src/
├── background/   Service Worker：Silk 后端调用（SSE + 重试）、安装令牌与套餐、内存 LRU + IndexedDB 缓存、并发池
├── content/      内容脚本：DOM 扫描与分段、翻译单元渲染、懒加载、SPA 监听、Chrome 内置翻译（免费层）
│   └── ui/       Shadow DOM UI：悬浮控制条、划词翻译卡片
├── core/         与浏览器无关的纯逻辑：markup 序列化/还原、流式 JSON 解析、SSE、并发池、文本过滤、prompt、译文检查（后端也复用其中不依赖 DOM 的部分）
├── popup/        工具栏面板
└── shared/       设置（含输入校验与模型列表）、界面文案（i18n）、消息协议、语言表、快捷键、套餐
static/           manifest.json 与图标
server/           Silk 后端（Cloudflare Worker）：安装令牌、翻译接口（后端拼提示词）、共享缓存、模型白名单、按日限额（Durable Object）、套餐、性能指标
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
