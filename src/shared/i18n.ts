// Interface strings in Simplified Chinese and English. `uiLang: 'auto'` follows the browser:
// any Chinese locale gets Chinese, everything else English.

import type { ErrorCode } from './messages'

export type UiLang = 'zh-CN' | 'en'
export type UiLangSetting = 'auto' | UiLang

export const UI_LANG_SETTINGS: readonly UiLangSetting[] = ['auto', 'zh-CN', 'en']

const ZH = {
  appName: '丝译',
  tagline: '无痕网页翻译 · Silk AI 云端引擎',
  translatePage: '翻译此页',
  displayMode: '显示模式',
  modeOriginal: '原文',
  modeOverlayOnly: '仅译文',
  modeBilingual: '双语对照',
  thisSite: '此网站',
  siteRules: '网站规则',
  ruleDefault: '默认',
  ruleAlways: '总是翻译',
  ruleNever: '从不',
  prefsTitle: '翻译偏好',
  targetLang: '目标语言',
  defaultMode: '默认模式',
  modeOverlay: '覆盖原文',
  bilingualStyle: '双语样式',
  styleDashed: '虚线',
  styleHighlight: '高亮',
  selection: '划词翻译',
  allSites: '在所有网站启用',
  allSitesHint: '开启后划词翻译、快捷键和“总是翻译”在每个网页都能直接用；关闭时只在点过“翻译此页”的标签页生效',
  shortcut: '切换快捷键',
  shortcutTitle: '点击后按下新的组合键',
  shortcutHint: '快捷键循环：原文 → 默认模式 → 另一种模式',
  shortcutRecording: '请按下组合键…',
  shortcutInvalid: '需包含 Ctrl / Alt / ⌘',
  uiLanguage: '界面语言',
  uiAuto: '跟随浏览器',
  modelTitle: 'AI 模型',
  modelLabel: '翻译模型',
  modelCheapest: '最便宜 · 中文强',
  modelFast: '快速',
  modelLocked: '正式版开放',
  modelsBetaHint: '测试期间只开放最便宜的 DeepSeek V4 Flash，其他模型将在正式版开放。',
  modelBest: '质量最高',
  modelBalanced: '均衡',
  modelNote: 'Silk AI 通过 OpenRouter 调用所选模型，开箱即用，无需 API Key。测试期间免费，每天有免费额度。翻译时网页文本会发送到 Silk 翻译服务处理，不会被保存。',
  checkQuota: '查看额度',
  help: '使用说明 ↗',
  saved: '已保存',
  connIdle: '未连接',
  connChecking: '检查中',
  connReady: '可用',
  connUpgrade: '需升级',
  connQuota: '额度用完',
  connFailed: '连接失败',
  pageFailed: '{n} 段失败',
  pageTranslating: '翻译中 {done}/{total}',
  pageTranslated: '已翻译 {n} 段',
  pageKind: '{kind} 页面',
  pageUnsupported: '浏览器内部页面不支持翻译',
  pageCannotRun: '无法在此页面运行翻译，请刷新页面后重试',
  saveFailed: '保存设置失败，请重试',
  popupFailed: '面板加载失败，请重新打开',
  backgroundUnreachable: '无法连接扩展后台，请重新打开面板',
  checkFailed: '查询失败',
  planBeta: '测试版 · 全部免费',
  planFree: '免费版',
  planPro: '专业版',
  quotaToday: '今日已用 {used} / {limit} 字',
  hudAria: '丝译 翻译控制',
  hudOriginal: '原文',
  hudOverlay: '译文',
  hudBilingual: '双语',
  hudShowingOriginal: '显示原文',
  hudPending: '待翻译',
  retry: '重试',
  hide: '隐藏',
  hideTitle: '隐藏（快捷键可再次唤出）',
  selTrigger: '翻译选中内容',
  selCard: '划词翻译',
  selTranslating: '翻译中…',
  copy: '复制译文',
  speak: '朗读译文',
  close: '关闭',
  closeTitle: '关闭 (Esc)',
  extensionGone: '扩展已更新或被禁用，请刷新页面',
  portLost: '与扩展后台的连接中断，请重试',
  partialFail: '部分段落翻译失败',
  invalidBatch: '无效的翻译请求',
  invalidSelection: '选中的文本为空或过长',
  timeout: '连接超时（20 秒），请检查网络或代理',
  missedItems: '模型漏译了部分段落',
  badAccount: '账户信息格式错误',
  emptyReply: '空响应',
  'error.quota': '今日免费额度已用完，北京时间早上 8 点（UTC 0 点）恢复',
  'error.upgrade': '当前套餐不包含 Silk AI 云端翻译',
  'error.model-locked': '当前套餐不能使用这个模型，已改用可用的模型，请重试',
  'error.auth': '扩展身份校验失败，请重新加载扩展',
  'error.rate-limit': '请求太频繁（429），请稍后再试',
  'error.bad-request': '请求被拒绝',
  'error.network': '网络连接失败，请检查网络或代理',
  'error.server': '翻译服务暂时不可用',
  'error.bad-response': '模型返回内容无法解析',
  'error.aborted': '已取消',
  'error.extension': '扩展已更新，请刷新页面',
} as const

export type MessageKey = keyof typeof ZH

const EN: Record<MessageKey, string> = {
  appName: 'Silk Translate',
  tagline: 'Seamless page translation · Silk AI cloud',
  translatePage: 'Translate this page',
  displayMode: 'Display mode',
  modeOriginal: 'Original',
  modeOverlayOnly: 'Translation',
  modeBilingual: 'Bilingual',
  thisSite: 'This site',
  siteRules: 'Site rule',
  ruleDefault: 'Default',
  ruleAlways: 'Always',
  ruleNever: 'Never',
  prefsTitle: 'Preferences',
  targetLang: 'Translate to',
  defaultMode: 'Default mode',
  modeOverlay: 'Replace',
  bilingualStyle: 'Bilingual style',
  styleDashed: 'Dashed',
  styleHighlight: 'Highlight',
  selection: 'Translate selection',
  allSites: 'Run on all sites',
  allSitesHint: 'Selection translation, the shortcut and "Always" then work on every page. Off: only in tabs where you clicked Translate this page',
  shortcut: 'Toggle shortcut',
  shortcutTitle: 'Click, then press a new key combination',
  shortcutHint: 'The shortcut cycles: original → default mode → the other mode',
  shortcutRecording: 'Press a key combination…',
  shortcutInvalid: 'Needs Ctrl / Alt / ⌘',
  uiLanguage: 'Interface language',
  uiAuto: 'Match browser',
  modelTitle: 'AI model',
  modelLabel: 'Translation model',
  modelCheapest: 'Cheapest · strong in Chinese',
  modelFast: 'Fast',
  modelLocked: 'After beta',
  modelsBetaHint: 'During the beta only DeepSeek V4 Flash, the cheapest model, is available. The others open after the beta.',
  modelBest: 'Highest quality',
  modelBalanced: 'Balanced',
  modelNote: 'Silk AI runs the selected model through OpenRouter. No API key needed. Free during the beta, with a daily free quota. Page text is sent to the Silk translation service for processing and is not stored.',
  checkQuota: 'Check quota',
  help: 'Help ↗',
  saved: 'Saved',
  connIdle: 'Offline',
  connChecking: 'Checking',
  connReady: 'Ready',
  connUpgrade: 'Upgrade',
  connQuota: 'Quota used',
  connFailed: 'Offline',
  pageFailed: '{n} failed',
  pageTranslating: 'Translating {done}/{total}',
  pageTranslated: '{n} translated',
  pageKind: '{kind} page',
  pageUnsupported: "Browser pages can't be translated",
  pageCannotRun: "Can't translate this page. Reload it and try again",
  saveFailed: "Couldn't save settings. Try again",
  popupFailed: "The panel didn't load. Reopen it",
  backgroundUnreachable: "Can't reach the extension. Reopen the panel",
  checkFailed: 'Check failed',
  planBeta: 'Beta · everything free',
  planFree: 'Free',
  planPro: 'Pro',
  quotaToday: 'Used today: {used} / {limit} characters',
  hudAria: 'Silk Translate controls',
  hudOriginal: 'Original',
  hudOverlay: 'Translated',
  hudBilingual: 'Bilingual',
  hudShowingOriginal: 'Showing original',
  hudPending: 'Waiting',
  retry: 'Retry',
  hide: 'Hide',
  hideTitle: 'Hide (the shortcut brings it back)',
  selTrigger: 'Translate selection',
  selCard: 'Selection translation',
  selTranslating: 'Translating…',
  copy: 'Copy translation',
  speak: 'Read aloud',
  close: 'Close',
  closeTitle: 'Close (Esc)',
  extensionGone: 'The extension was updated or disabled. Reload the page',
  portLost: 'Lost connection to the extension. Try again',
  partialFail: 'Some paragraphs failed to translate',
  invalidBatch: 'Invalid translation request',
  invalidSelection: 'The selection is empty or too long',
  timeout: 'Timed out after 20 seconds. Check your network or proxy',
  missedItems: 'The model skipped some paragraphs',
  badAccount: 'Unreadable account information',
  emptyReply: 'empty response',
  'error.quota': "Today's free quota is used up. It resets at 00:00 UTC",
  'error.upgrade': 'Your plan does not include Silk AI cloud translation',
  'error.model-locked': 'This model is not available on your plan. Switched to an available one; try again',
  'error.auth': 'The extension could not identify itself. Reload the extension',
  'error.rate-limit': 'Too many requests (429). Please try again later',
  'error.bad-request': 'Request rejected',
  'error.network': 'Network error. Check your network or proxy',
  'error.server': 'The translation service is temporarily unavailable',
  'error.bad-response': "Couldn't read the model's reply",
  'error.aborted': 'Cancelled',
  'error.extension': 'The extension was updated. Reload the page',
}

const MESSAGES: Record<UiLang, Record<MessageKey, string>> = { 'zh-CN': ZH, en: EN }

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(ZH, value)
}

/** `auto` resolves against the browser language (popup, content script and service worker alike). */
export function resolveUiLang(setting: UiLangSetting, browserLang: string = globalThis.navigator?.language ?? ''): UiLang {
  if (setting !== 'auto') return setting
  return browserLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string

export function translator(lang: UiLang): Translate {
  return (key, params) => MESSAGES[lang][key].replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match))
}

/** Friendly text for an error code; `detail` may itself be a message key. */
export function errorText(lang: UiLang, code: ErrorCode, detail = ''): string {
  const t = translator(lang)
  const base = t(`error.${code}`)
  const extra = detail && isMessageKey(detail) ? t(detail) : detail
  return extra ? `${base}${lang === 'zh-CN' ? '：' : ': '}${extra}` : base
}

/** "200万" / "2M" style counts. */
export function compactNumber(lang: UiLang, n: number): string {
  return new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}
