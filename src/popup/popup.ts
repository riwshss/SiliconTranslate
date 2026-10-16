import { batchSystemPrompt } from '../core/prompt'
import {
  ChromeAiError,
  createDetector,
  createLanguageModel,
  createTranslator,
  detectorAvailability,
  hasLanguageModel,
  hasTranslator,
  isNanoOutputSupported,
  languageModelAvailability,
  translatorAvailability,
  type Availability,
} from '../shared/chrome-ai'
import { describeQuota, PLAN_LABELS } from '../shared/entitlement'
import { chromeAiLanguage, getLanguage, LANGUAGES, normalizeDetected } from '../shared/languages'
import type { AccountRequest, AccountResult, PageState, TabMessage, TestConnectionRequest, TestConnectionResult } from '../shared/messages'
import { RELEASE_CHANNEL } from '../shared/service'
import {
  GOOGLE_TRANSLATE_URL,
  hostPermissionFor,
  isChromeAiProvider,
  loadSettings,
  MODEL_PRESETS,
  PROVIDERS,
  saveSettings,
  withDomainRule,
  type BilingualStyle,
  type DisplayMode,
  type DomainRule,
  type Provider,
  type Settings,
  type TranslateMode,
} from '../shared/settings'
import { eventToShortcut, isValidShortcut } from '../shared/shortcut'
import { segmented } from './segmented'

const CUSTOM_MODEL = '__custom__'
const SAVE_DEBOUNCE_MS = 400

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let settings: Settings
let tabId: number | null = null
let host = ''

// ───────────── persistence ─────────────

let savedTimer: ReturnType<typeof setTimeout> | undefined
async function persist(patch: Partial<Settings>): Promise<void> {
  try {
    settings = await saveSettings(patch)
    const saved = $('saved')
    saved.classList.add('is-visible')
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => saved.classList.remove('is-visible'), 1200)
  } catch (err) {
    console.error('[silk] failed to save settings', err)
    setTestResult('保存设置失败，请重试', 'error')
  }
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: A) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

// ───────────── page (active tab) ─────────────

async function sendToTab(message: TabMessage): Promise<PageState> {
  if (tabId === null) throw new Error('no tab')
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as PageState
  } catch {
    // Tab was open before install/update: inject the content script once (activeTab grant).
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
    return (await chrome.tabs.sendMessage(tabId, message)) as PageState
  }
}

const modeSeg = segmented($('mode-seg'), (value) => void setPageMode(value as DisplayMode))

function renderPageState(state: PageState | null): void {
  const button = $<HTMLButtonElement>('translate-btn')
  const isActive = !!state && state.started
  button.hidden = isActive
  $('mode-seg').hidden = !isActive
  $('host').previousElementSibling?.classList.toggle('is-live', isActive && state.mode !== 'original')
  if (isActive) modeSeg.setValue(state.mode)
  const status = $('page-status')
  if (!state || !state.started) status.textContent = ''
  else if (state.failed) status.textContent = `${state.failed} 段失败`
  else if (state.total > state.done) status.textContent = `翻译中 ${state.done}/${state.total}`
  else status.textContent = state.total ? `已翻译 ${state.done} 段` : ''
}

function disablePage(note: string): void {
  $<HTMLButtonElement>('translate-btn').disabled = true
  $('rule-seg').style.pointerEvents = 'none'
  $('rule-seg').style.opacity = '0.5'
  const el = $('page-note')
  el.textContent = note
  el.hidden = false
}

async function setPageMode(mode: DisplayMode): Promise<void> {
  try {
    renderPageState(await sendToTab({ type: 'silk:set-mode', mode }))
  } catch {
    disablePage('无法在此页面运行翻译，请刷新页面后重试')
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined
async function initPage(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ? new URL(tab.url) : null
  if (!tab?.id || !url || !/^https?:$/.test(url.protocol)) {
    $('host').textContent = url ? url.protocol.replace(':', '') + ' 页面' : '—'
    disablePage('浏览器内部页面不支持翻译')
    return
  }
  tabId = tab.id
  host = url.hostname
  $('host').textContent = host
  ruleSeg.setValue(settings.domainRules[host] ?? '')
  try {
    renderPageState(await sendToTab({ type: 'silk:get-state' }))
    pollTimer = setInterval(async () => renderPageState(await sendToTab({ type: 'silk:get-state' }).catch(() => null)), 700)
  } catch {
    renderPageState(null)
  }
}

const ruleSeg = segmented($('rule-seg'), (value) => {
  if (!host) return
  void persist(withDomainRule(settings, host, (value || null) as DomainRule | null))
})

$('translate-btn').addEventListener('click', () => void setPageMode(settings.defaultMode))

// ───────────── preferences ─────────────

const defaultModeSeg = segmented($('default-mode'), (value) => void persist({ defaultMode: value as TranslateMode }))
const styleSeg = segmented($('style-seg'), (value) => void persist({ bilingualStyle: value as BilingualStyle }))

function renderShortcut(shortcut: string): void {
  const button = $('shortcut')
  button.classList.remove('is-recording')
  button.replaceChildren(
    ...shortcut.split('+').map((part) => {
      const kbd = document.createElement('kbd')
      kbd.textContent = part
      return kbd
    }),
  )
}

function initShortcutRecorder(): void {
  const button = $('shortcut')
  let isRecording = false
  const stop = () => {
    isRecording = false
    renderShortcut(settings.shortcut)
  }
  button.addEventListener('click', () => {
    isRecording = true
    button.classList.add('is-recording')
    button.textContent = '请按下组合键…'
  })
  button.addEventListener('blur', () => isRecording && stop())
  button.addEventListener('keydown', (e) => {
    if (!isRecording) return
    e.preventDefault()
    if (e.key === 'Escape') return stop()
    const shortcut = eventToShortcut(e)
    if (!shortcut) return
    if (!isValidShortcut(shortcut)) {
      button.classList.remove('is-invalid')
      void button.offsetWidth
      button.classList.add('is-invalid')
      button.textContent = '需包含 Ctrl / Alt / ⌘'
      return
    }
    button.classList.remove('is-invalid')
    void persist({ shortcut }).then(stop)
  })
}

// ───────────── API ─────────────

function setTestResult(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const el = $('test-result')
  el.textContent = text
  el.className = `small ${kind}`
}

function setConn(state: 'idle' | 'warn' | 'ok' | 'error', text: string): void {
  const pill = $('conn')
  pill.dataset.state = state
  pill.textContent = text
}

function currentModel(): string {
  const select = $<HTMLSelectElement>('model-select')
  return select.value === CUSTOM_MODEL ? $<HTMLInputElement>('model-custom').value.trim() : select.value
}

function initModelPicker(): void {
  const select = $<HTMLSelectElement>('model-select')
  const custom = $<HTMLInputElement>('model-custom')
  const options = MODEL_PRESETS.map(({ id, note }) => new Option(`${id}（${note}）`, id))
  select.replaceChildren(...options, new Option('自定义模型…', CUSTOM_MODEL))
  const isPreset = MODEL_PRESETS.some((m) => m.id === settings.model)
  select.value = isPreset ? settings.model : CUSTOM_MODEL
  custom.value = isPreset ? '' : settings.model
  custom.hidden = isPreset

  select.addEventListener('change', () => {
    custom.hidden = select.value !== CUSTOM_MODEL
    if (!custom.hidden) custom.focus()
    if (currentModel()) void persist({ model: currentModel() })
  })
  custom.addEventListener('input', debounce(() => currentModel() && void persist({ model: currentModel() }), SAVE_DEBOUNCE_MS))
}

/**
 * Custom endpoints need a host permission, otherwise the call only works if the server sends CORS
 * headers. Must run inside a user gesture; returns false when the user declines.
 */
async function ensureHostPermission(endpoint: string): Promise<boolean> {
  const pattern = hostPermissionFor(endpoint)
  if (!pattern) return true
  try {
    return await chrome.permissions.request({ origins: [pattern] })
  } catch (err) {
    console.error('[silk] host permission request failed', err)
    return false
  }
}

const README_URL = 'https://github.com/riwshss/SiliconTranslate#readme'

const PROVIDER_UI: Record<Provider, { help: [string, string]; test: string; note?: string }> = {
  cloud: {
    help: ['使用说明 ↗', README_URL],
    test: '查看额度',
    note: 'Silk AI 通过 OpenRouter 聚合平台调用大模型，开箱即用，无需 API Key。测试期间所有功能免费，每天有免费额度。翻译时网页文本会发送到 Silk 翻译服务处理，不会被保存。',
  },
  openai: { help: ['获取 API Key ↗', 'https://cloud.siliconflow.cn/account/ak'], test: '测试连接' },
  google: { help: ['获取 Google API Key ↗', 'https://console.cloud.google.com/apis/credentials'], test: '测试连接' },
  'chrome-translator': {
    help: ['关于 Chrome 内置 AI ↗', 'https://developer.chrome.com/docs/ai/translator-api'],
    test: '检查 / 下载模型',
    note: '使用 Chrome 内置的本地翻译模型，网页内容不离开本机，无需 API Key。需桌面版 Chrome 138+；首次使用请点下方按钮，下载当前网页语言与英语到目标语言的模型。',
  },
  'chrome-nano': {
    help: ['关于 Gemini Nano ↗', 'https://developer.chrome.com/docs/ai/prompt-api'],
    test: '检查 / 下载模型',
    note: '使用 Chrome 内置的 Gemini Nano 小模型，网页内容不离开本机。需桌面版 Chrome 138+、22 GB 可用磁盘，以及 4 GB 以上显存或 16 GB 内存。官方目前仅支持英 / 日 / 西 / 德 / 法输出，其他目标语言效果可能不稳定。',
  },
}

function activeKey(): string {
  if (settings.provider === 'openai') return settings.apiKey
  if (settings.provider === 'google') return settings.googleApiKey
  return ''
}

function renderKeyConn(): void {
  setConn(activeKey() ? 'idle' : 'warn', activeKey() ? '已配置' : '未配置')
}

/** Reflects on-device model status without downloading anything. */
async function renderChromeStatus(): Promise<void> {
  const provider = settings.provider
  const target = chromeAiLanguage(settings.targetLang)
  let state: Availability
  try {
    if (provider === 'chrome-translator') {
      const pair = { sourceLanguage: target === 'en' ? 'zh' : 'en', targetLanguage: target }
      const [detector, translator] = await Promise.all([detectorAvailability(), translatorAvailability(pair)])
      // The detector is optional: without it the offscreen document guesses the source by script.
      const isDetectorReady = detector === 'available' || detector === 'unavailable'
      state = translator === 'available' && !isDetectorReady ? 'downloadable' : translator
    } else {
      state = await languageModelAvailability(target)
    }
  } catch {
    state = 'unavailable'
  }
  if (settings.provider !== provider) return
  if (state === 'available') setConn('ok', '已就绪')
  else if (state === 'unavailable') setConn('error', '不可用')
  else setConn('warn', state === 'downloading' ? '下载中' : '需下载')
}

function applyProvider(): void {
  const { provider } = settings
  const ui = PROVIDER_UI[provider]
  $('openai-group').hidden = provider !== 'openai'
  $('google-group').hidden = provider !== 'google'
  $('base-url-field').hidden = provider !== 'openai'
  const note = $('chrome-note')
  note.hidden = !ui.note
  note.textContent = ui.note ?? ''
  $('test-btn').textContent = ui.test
  const link = $<HTMLAnchorElement>('help-link')
  link.textContent = ui.help[0]
  link.href = ui.help[1]
  setTestResult('')
  if (isChromeAiProvider(provider)) void renderChromeStatus()
  else if (provider === 'cloud') void checkAccount()
  else renderKeyConn()
}

/**
 * Chrome only downloads on-device models from a user gesture, which the offscreen document never
 * has: this button creates (and so downloads) every model page translation will need. All
 * create() calls start right away, while the click still counts as user activation.
 */
async function prepareChromeModels(): Promise<void> {
  const target = chromeAiLanguage(settings.targetLang)
  const progress = new Map<string, number>()
  const track = (label: string) => (loaded: number) => {
    progress.set(label, loaded)
    const pct = Math.round(([...progress.values()].reduce((a, b) => a + b, 0) / progress.size) * 100)
    setTestResult(`正在下载模型 ${pct}%（请保持面板打开）`)
  }

  if (settings.provider === 'chrome-nano') {
    if (!hasLanguageModel()) throw new ChromeAiError('unavailable', '当前浏览器不支持 Gemini Nano，需要桌面版 Chrome 138 及以上')
    const session = await createLanguageModel(batchSystemPrompt(getLanguage(settings.targetLang).prompt, ''), target, track('nano'))
    session.destroy()
    setTestResult(isNanoOutputSupported(target) ? 'Gemini Nano 已就绪' : 'Gemini Nano 已就绪（官方暂不支持该目标语言，译文质量可能不稳定）', 'ok')
    return
  }

  if (!hasTranslator()) throw new ChromeAiError('unavailable', '当前浏览器不支持内置翻译，需要桌面版 Chrome 138 及以上')
  const pageLang = tabId === null ? null : normalizeDetected(await chrome.tabs.detectLanguage(tabId).catch(() => 'und'))
  const sources = [...new Set([pageLang, target === 'en' ? 'zh' : 'en'])].filter((lang): lang is string => !!lang && lang !== target)
  const [detector, ...translators] = await Promise.all([
    createDetector(track('detector')).catch((err: unknown) => {
      if (err instanceof ChromeAiError && err.code === 'unavailable') return null
      throw err
    }),
    ...sources.map((source) => createTranslator({ sourceLanguage: source, targetLanguage: target }, track(source))),
  ])
  detector?.destroy()
  translators.forEach((translator) => translator.destroy())
  setTestResult(`本地模型已就绪：${sources.map((source) => `${source} → ${target}`).join('、')}`, 'ok')
}

const DOWNLOAD_STALL_MS = 20_000

async function testChromeModels(): Promise<void> {
  const checking = '正在检查本地模型…'
  setTestResult(checking)
  // Chrome reports no progress while it queues the download: say where to look instead of spinning silently.
  const internals = settings.provider === 'chrome-nano' ? 'chrome://on-device-internals' : 'chrome://on-device-translation-internals'
  const stall = setTimeout(() => {
    if ($('test-result').textContent === checking) setTestResult(`Chrome 仍在准备下载模型，可在 ${internals} 查看进度`)
  }, DOWNLOAD_STALL_MS)
  try {
    await prepareChromeModels()
    setConn('ok', '已就绪')
  } catch (err) {
    const needsGesture = err instanceof ChromeAiError && err.code === 'model-download'
    setTestResult(needsGesture ? '模型下载未能开始，请再点一次按钮' : err instanceof Error ? err.message : '本地模型不可用', 'error')
    setConn('error', needsGesture ? '需下载' : '不可用')
  } finally {
    clearTimeout(stall)
  }
}

/** Silk AI: plan and today's quota, straight from the backend. */
async function checkAccount(): Promise<void> {
  setConn('idle', '检查中')
  const result = (await chrome.runtime.sendMessage({ type: 'silk:account' } satisfies AccountRequest).catch((err: unknown) => {
    console.error('[silk] account check failed', err)
    return { ok: false, message: '无法连接扩展后台，请重新打开面板' }
  })) as AccountResult
  if (settings.provider !== 'cloud') return
  if (!result.ok) {
    setTestResult(result.message, 'error')
    setConn('error', '连接失败')
    return
  }
  const { plan, features, quota } = result.entitlement
  const isEnabled = features.includes('cloud-ai')
  const isExhausted = !!quota && quota.used >= quota.limit
  setTestResult([PLAN_LABELS[plan], quota ? describeQuota(quota) : ''].filter(Boolean).join(' · '), isEnabled && !isExhausted ? 'ok' : 'error')
  if (!isEnabled) setConn('warn', '需升级')
  else if (isExhausted) setConn('warn', '额度用完')
  else setConn('ok', '可用')
}

async function testRemote(provider: 'openai' | 'google'): Promise<void> {
  const isGoogle = provider === 'google'
  const baseUrl = $<HTMLInputElement>('base-url').value
  setTestResult('正在连接…')
  const request: TestConnectionRequest = {
    type: 'silk:test-connection',
    provider,
    apiKey: $<HTMLInputElement>(isGoogle ? 'google-key' : 'api-key').value,
    baseUrl,
    model: currentModel(),
  }
  if (!(await ensureHostPermission(isGoogle ? GOOGLE_TRANSLATE_URL : baseUrl))) {
    setTestResult('未授予该接口地址的访问权限', 'error')
    setConn('error', '连接失败')
    return
  }
  const result = (await chrome.runtime.sendMessage(request)) as TestConnectionResult
  if (result.ok) {
    setTestResult(`连接成功 · ${result.latencyMs} ms`, 'ok')
    setConn('ok', '已连接')
    if (!isGoogle) $('model-list').replaceChildren(...result.models.map((id) => new Option(id, id)))
  } else {
    setTestResult(result.message, 'error')
    setConn('error', '连接失败')
  }
}

async function testConnection(): Promise<void> {
  const button = $('test-btn')
  const { provider } = settings
  button.classList.add('is-loading')
  try {
    if (isChromeAiProvider(provider)) await testChromeModels()
    else if (provider === 'cloud') await checkAccount()
    else await testRemote(provider)
  } catch (err) {
    setTestResult(err instanceof Error ? err.message : '测试失败', 'error')
  } finally {
    button.classList.remove('is-loading')
  }
}

function bindKeyInput(id: string, field: 'apiKey' | 'googleApiKey'): void {
  const input = $<HTMLInputElement>(id)
  input.value = settings[field]
  input.addEventListener(
    'input',
    debounce(async () => {
      await persist({ [field]: input.value })
      renderKeyConn()
    }, SAVE_DEBOUNCE_MS),
  )
}

function initApiSection(): void {
  const provider = $<HTMLSelectElement>('provider')
  provider.replaceChildren(...PROVIDERS.map(({ id, label }) => new Option(label, id)))
  provider.value = settings.provider
  provider.addEventListener('change', async () => {
    const next = provider.value as Provider
    // Ask while the change still counts as a user gesture; without it the call relies on CORS.
    if (next === 'google') void ensureHostPermission(GOOGLE_TRANSLATE_URL)
    await persist({ provider: next })
    applyProvider()
  })

  bindKeyInput('api-key', 'apiKey')
  bindKeyInput('google-key', 'googleApiKey')
  document.querySelectorAll<HTMLButtonElement>('.toggle-key').forEach((button) =>
    button.addEventListener('click', () => {
      const input = button.previousElementSibling as HTMLInputElement
      input.type = input.type === 'password' ? 'text' : 'password'
    }),
  )
  $('test-btn').addEventListener('click', () => void testConnection())

  const baseUrl = $<HTMLInputElement>('base-url')
  baseUrl.value = settings.baseUrl
  baseUrl.addEventListener('change', async () => {
    if (!(await ensureHostPermission(baseUrl.value))) setTestResult('未授予该接口地址的访问权限，翻译请求可能失败', 'error')
    await persist({ baseUrl: baseUrl.value })
    baseUrl.value = settings.baseUrl
  })
  const concurrency = $<HTMLInputElement>('concurrency')
  concurrency.value = String(settings.maxConcurrency)
  concurrency.addEventListener('change', async () => {
    await persist({ maxConcurrency: Number(concurrency.value) })
    concurrency.value = String(settings.maxConcurrency)
  })
  applyProvider()
}

// ───────────── boot ─────────────

async function init(): Promise<void> {
  settings = await loadSettings()
  $('beta-badge').hidden = RELEASE_CHANNEL !== 'beta'

  const lang = $<HTMLSelectElement>('lang')
  lang.replaceChildren(...LANGUAGES.map((l) => new Option(l.label, l.code)))
  lang.value = settings.targetLang
  lang.addEventListener('change', async () => {
    await persist({ targetLang: lang.value })
    if (isChromeAiProvider(settings.provider)) void renderChromeStatus()
  })

  defaultModeSeg.setValue(settings.defaultMode)
  styleSeg.setValue(settings.bilingualStyle)

  const selection = $<HTMLInputElement>('selection')
  selection.checked = settings.selectionEnabled
  selection.addEventListener('change', () => void persist({ selectionEnabled: selection.checked }))

  renderShortcut(settings.shortcut)
  initShortcutRecorder()
  initModelPicker()
  initApiSection()
  await initPage()
}

addEventListener('unload', () => clearInterval(pollTimer))
init().catch((err) => {
  console.error('[silk] popup failed', err)
  setTestResult('面板加载失败，请重新打开', 'error')
})
