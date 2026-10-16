# 丝译 Silk Translate

Chrome 网页翻译扩展（Manifest V3），支持多种翻译引擎：[硅基流动 SiliconFlow](https://siliconflow.cn) 或任意 OpenAI 兼容接口、Google 翻译 API，以及 Chrome 内置的本地模型（Translator API / Gemini Nano）。
TypeScript + esbuild，无前端框架、无运行时依赖。

## 功能

- **四种翻译引擎**（面板「翻译服务」中切换，译文按引擎分开缓存）

  | 引擎 | 说明 |
  |---|---|
  | 硅基流动 / OpenAI 兼容 | 大模型翻译，可改接口地址接入任意 OpenAI 兼容服务 |
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
   - **硅基流动**：填入 API Key（在 [硅基流动控制台](https://cloud.siliconflow.cn/account/ak) 创建），点「测试连接」。
   - **Google 翻译 API**：在 [Google Cloud 控制台](https://console.cloud.google.com/apis/credentials) 启用 Cloud Translation API 并创建 API Key，填入后点「测试连接」。
   - **Chrome 内置**：点「检查 / 下载模型」，等待模型下载完成。

扩展安装前已打开的标签页无需刷新：在面板中点「翻译此页」时会自动注入脚本。

## 设置说明

| 项目 | 说明 |
|---|---|
| 目标语言 | 整页翻译与划词翻译的目标语言 |
| 默认模式 | 点「翻译此页」或按快捷键时首先使用的模式 |
| 双语样式 | 虚线下划线 / 高亮 |
| 模型 | 预设 `Qwen/Qwen2.5-7B-Instruct`（免费、快），也可从「测试连接」拉取的列表中选择或手动输入。Qwen3 系列会自动关闭思考模式 |
| 并发数 | 1–8，默认 4。免费额度遇到 429 时会自动按 `Retry-After` 退避重试 |
| 接口地址 | 默认 `https://api.siliconflow.cn/v1`，可改为任意 OpenAI 兼容接口 |

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

- API Key 与设置只保存在本机 `chrome.storage.local`，仅发送给对应的接口（硅基流动 / 你配置的地址 / Google）。
- 选择 Chrome 内置引擎时，网页内容完全在本机处理，不发出任何翻译请求。
- 网页内容只在翻译时发送给该接口；扩展不包含任何统计或第三方请求。
- 所有扩展 UI 渲染在独立的 Shadow DOM 中，不影响页面样式。

## 开发

```bash
npm run dev         # esbuild watch（改 manifest/html/css 后需重新运行）
npm run typecheck   # tsc --noEmit
npm test            # Vitest 单元测试（jsdom）
npm run coverage    # 覆盖率报告
npm run e2e         # Playwright 真浏览器端到端测试（需先 npm run build）
npm run icons       # 重新生成 static/icons 下的 PNG 图标
```

E2E 使用本地 mock 服务器模拟 SSE 流式响应、429 限流和并发统计，不消耗真实 API 额度；截图输出到 `e2e/output/`。
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
tests/            单元测试
e2e/              端到端测试（fixture 页面 + mock API）
```

### 工作原理

1. 内容脚本把页面切成「段落单元」：块级元素内连续的行内内容为一段，行内标签序列化为带编号的标记（格式文本如 `<g0>…</g0>`，代码、图片等原样保留为 `<c1/>`），让模型在保留格式的前提下调整语序。
2. 进入视口的段落以 60ms 为窗口合并成批，通过 `chrome.runtime.Port` 发给后台；后台要求模型输出 JSON 对象并**边流式接收边解析**，每完成一段立即回传渲染。
3. 模型漏译的段落单独重试一次；仍失败的段落在悬浮条中显示，可一键重试。
4. 端口断开（标签页关闭或跳转）时会中止对应的 HTTP 请求，不浪费额度。
