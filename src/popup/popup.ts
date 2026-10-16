import { canUseCloudAi, describeQuota, PLAN_LABELS } from '../shared/entitlement'
import { resolveUiLang, translator, UI_LANG_SETTINGS, type MessageKey, type Translate, type UiLangSetting } from '../shared/i18n'
import { LANGUAGES } from '../shared/languages'
import type { AccountRequest, AccountResult, PageState, TabMessage } from '../shared/messages'
import { RELEASE_CHANNEL } from '../shared/service'
import {
  CLOUD_MODELS,
  loadSettings,
  saveSettings,
  withDomainRule,
  type BilingualStyle,
  type DisplayMode,
  type DomainRule,
  type Settings,
  type TranslateMode,
} from '../shared/settings'
import { eventToShortcut, isValidShortcut } from '../shared/shortcut'
import { segmented } from './segmented'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let settings: Settings
let tabId: number | null = null
let host = ''
/** Last page state, note and non-web scheme, kept so a language switch can re-render them. */
let pageState: PageState | null = null
let pageNote: MessageKey | null = null
let pageScheme: string | null = null

const t: Translate = (key, params) => translator(resolveUiLang(settings?.uiLang ?? 'auto'))(key, params)

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
    setTestResult(t('saveFailed'), 'error')
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
  pageState = state
  const button = $<HTMLButtonElement>('translate-btn')
  const isActive = !!state && state.started
  button.hidden = isActive
  $('mode-seg').hidden = !isActive
  $('host').previousElementSibling?.classList.toggle('is-live', isActive && state.mode !== 'original')
  if (isActive) modeSeg.setValue(state.mode)
  const status = $('page-status')
  if (!state || !state.started) status.textContent = ''
  else if (state.failed) status.textContent = t('pageFailed', { n: state.failed })
  else if (state.total > state.done) status.textContent = t('pageTranslating', { done: state.done, total: state.total })
  else status.textContent = state.total ? t('pageTranslated', { n: state.done }) : ''
}

function disablePage(note: MessageKey): void {
  pageNote = note
  $<HTMLButtonElement>('translate-btn').disabled = true
  $('rule-seg').style.pointerEvents = 'none'
  $('rule-seg').style.opacity = '0.5'
  const el = $('page-note')
  el.textContent = t(note)
  el.hidden = false
}

async function setPageMode(mode: DisplayMode): Promise<void> {
  try {
    renderPageState(await sendToTab({ type: 'silk:set-mode', mode }))
  } catch {
    disablePage('pageCannotRun')
  }
}

let pollTimer: ReturnType<typeof setInterval> | undefined
async function initPage(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = tab?.url ? new URL(tab.url) : null
  if (!tab?.id || !url || !/^https?:$/.test(url.protocol)) {
    pageScheme = url ? url.protocol.replace(':', '') : null
    $('host').textContent = pageScheme ? t('pageKind', { kind: pageScheme }) : '—'
    disablePage('pageUnsupported')
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
    button.textContent = t('shortcutRecording')
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
      button.textContent = t('shortcutInvalid')
      return
    }
    button.classList.remove('is-invalid')
    void persist({ shortcut }).then(stop)
  })
}

// ───────────── Silk AI ─────────────

function setTestResult(text: string, kind: 'ok' | 'error' | '' = ''): void {
  const el = $('test-result')
  el.textContent = text
  el.className = `small ${kind}`
}

function setConn(state: 'idle' | 'warn' | 'ok' | 'error', key: MessageKey): void {
  const pill = $('conn')
  pill.dataset.state = state
  pill.textContent = t(key)
}

/** One radio card per model; arrow keys move the choice like a native radio group. */
function initModelPicker(): void {
  const root = $('models')
  const cards = CLOUD_MODELS.map(({ id, label }) => {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'model'
    card.setAttribute('role', 'radio')
    card.dataset.value = id
    const name = document.createElement('span')
    name.className = 'model-name'
    name.textContent = label
    const note = document.createElement('span')
    note.className = 'model-note'
    card.append(name, note)
    return card
  })
  root.replaceChildren(...cards)

  const paint = () =>
    cards.forEach((card) => {
      const isActive = card.dataset.value === settings.model
      card.setAttribute('aria-checked', String(isActive))
      card.tabIndex = isActive ? 0 : -1
    })
  const select = async (card: HTMLButtonElement) => {
    if (card.dataset.value === settings.model) return
    await persist({ model: card.dataset.value })
    paint()
  }
  cards.forEach((card, i) => {
    card.addEventListener('click', () => void select(card))
    card.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      e.preventDefault()
      const next = cards[(i + step + cards.length) % cards.length]
      next.focus()
      void select(next)
    })
  })
  paint()
}

/** Plan and today's quota, straight from the backend. */
async function checkAccount(): Promise<void> {
  setConn('idle', 'connChecking')
  const result = (await chrome.runtime.sendMessage({ type: 'silk:account' } satisfies AccountRequest).catch((err: unknown) => {
    console.error('[silk] account check failed', err)
    return { ok: false, message: t('backgroundUnreachable') }
  })) as AccountResult
  if (!result.ok) {
    setTestResult(result.message, 'error')
    setConn('error', 'connFailed')
    return
  }
  const { entitlement } = result
  const isEnabled = canUseCloudAi(entitlement)
  const isExhausted = !!entitlement.quota && entitlement.quota.used >= entitlement.quota.limit
  const summary = [t(PLAN_LABELS[entitlement.plan]), entitlement.quota ? describeQuota(entitlement.quota, resolveUiLang(settings.uiLang)) : '']
  setTestResult(summary.filter(Boolean).join(' · '), isEnabled && !isExhausted ? 'ok' : 'error')
  if (!isEnabled) setConn('warn', 'connUpgrade')
  else if (isExhausted) setConn('warn', 'connQuota')
  else setConn('ok', 'connReady')
}

async function runAccountCheck(): Promise<void> {
  const button = $('test-btn')
  button.classList.add('is-loading')
  try {
    await checkAccount()
  } catch (err) {
    console.error('[silk] account check failed', err)
    setTestResult(t('checkFailed'), 'error')
  } finally {
    button.classList.remove('is-loading')
  }
}

// ───────────── interface language ─────────────

/** Fills every static label; called again whenever the interface language changes. */
function applyLanguage(): void {
  document.documentElement.lang = resolveUiLang(settings.uiLang)
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as MessageKey)))
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria as MessageKey)))
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle as MessageKey)))
  document.querySelectorAll<HTMLElement>('.model').forEach((card) => {
    const model = CLOUD_MODELS.find((m) => m.id === card.dataset.value)
    const note = card.querySelector('.model-note')
    if (model && note) note.textContent = t(model.note)
  })
  const uiLang = $<HTMLSelectElement>('ui-lang')
  const names: Record<UiLangSetting, string> = { auto: t('uiAuto'), 'zh-CN': '简体中文', en: 'English' }
  uiLang.replaceChildren(...UI_LANG_SETTINGS.map((value) => new Option(names[value], value)))
  uiLang.value = settings.uiLang
  if (pageNote) $('page-note').textContent = t(pageNote)
  if (pageScheme) $('host').textContent = t('pageKind', { kind: pageScheme })
  if (pageState) renderPageState(pageState)
  ;[modeSeg, ruleSeg, defaultModeSeg, styleSeg].forEach((seg) => seg.repaint())
}

// ───────────── boot ─────────────

async function init(): Promise<void> {
  settings = await loadSettings()
  $('beta-badge').hidden = RELEASE_CHANNEL !== 'beta'

  const lang = $<HTMLSelectElement>('lang')
  lang.replaceChildren(...LANGUAGES.map((l) => new Option(l.label, l.code)))
  lang.value = settings.targetLang
  lang.addEventListener('change', () => void persist({ targetLang: lang.value }))

  defaultModeSeg.setValue(settings.defaultMode)
  styleSeg.setValue(settings.bilingualStyle)

  const selection = $<HTMLInputElement>('selection')
  selection.checked = settings.selectionEnabled
  selection.addEventListener('change', () => void persist({ selectionEnabled: selection.checked }))

  const concurrency = $<HTMLInputElement>('concurrency')
  concurrency.value = String(settings.maxConcurrency)
  concurrency.addEventListener('change', async () => {
    await persist({ maxConcurrency: Number(concurrency.value) })
    concurrency.value = String(settings.maxConcurrency)
  })

  initModelPicker()
  applyLanguage()
  $('ui-lang').addEventListener('change', async (e) => {
    await persist({ uiLang: (e.target as HTMLSelectElement).value as UiLangSetting })
    applyLanguage()
    renderShortcut(settings.shortcut)
    void runAccountCheck()
  })
  renderShortcut(settings.shortcut)
  initShortcutRecorder()
  $('test-btn').addEventListener('click', () => void runAccountCheck())
  void runAccountCheck()
  await initPage()
}

addEventListener('unload', () => clearInterval(pollTimer))
init().catch((err) => {
  console.error('[silk] popup failed', err)
  setTestResult(t('popupFailed'), 'error')
})
