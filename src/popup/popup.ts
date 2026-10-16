import { DEV_KEY_STORAGE_KEY, sanitizeDevKey } from '../shared/dev-key'
import { canUseCloudAi, defaultEntitlement, describeQuota, effectiveModel, PLAN_LABELS, sanitizeEntitlement, type Entitlement } from '../shared/entitlement'
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
import { ALL_SITES, hasAllSites, sitePattern } from '../shared/site-access'
import { sendToTab, SHORTCUTS_PAGE, TOGGLE_COMMAND } from '../shared/tab-messaging'
import { segmented } from './segmented'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

let settings: Settings
let tabId: number | null = null
let host = ''
let pageUrl: URL | null = null
/** Last page state, note and non-web scheme, kept so a language switch can re-render them. */
let pageState: PageState | null = null
let pageNote: MessageKey | null = null
let pageScheme: string | null = null
/** Plan as last reported by the backend (cached by the service worker); decides which models are open. */
let entitlement: Entitlement = defaultEntitlement(RELEASE_CHANNEL)

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

function sendToActiveTab(message: TabMessage): Promise<PageState> {
  if (tabId === null) return Promise.reject(new Error('no tab'))
  return sendToTab(tabId, message)
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
  // Silk progress line along the bottom of the page card while paragraphs are being translated.
  const progress = $('page-progress')
  const isBusy = !!state && state.started && state.mode !== 'original' && state.total > state.done + state.failed
  progress.hidden = !isBusy
  if (state && isBusy) (progress.firstElementChild as HTMLElement).style.transform = `scaleX(${(state.done + state.failed) / state.total})`
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
    renderPageState(await sendToActiveTab({ type: 'silk:set-mode', mode }))
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
  pageUrl = url
  $('host').textContent = host
  ruleSeg.setValue(settings.domainRules[host] ?? '')
  try {
    renderPageState(await sendToActiveTab({ type: 'silk:get-state' }))
    pollTimer = setInterval(async () => renderPageState(await sendToActiveTab({ type: 'silk:get-state' }).catch(() => null)), 700)
  } catch {
    renderPageState(null)
  }
}

const ruleSeg = segmented($('rule-seg'), (value) => {
  if (!host) return
  // Ask for this one site while the click still counts as a user gesture, so the page is translated
  // on load next time. Declining keeps the rule: it then applies once the popup injects the script.
  if (value === 'always' && pageUrl) {
    chrome.permissions.request({ origins: [sitePattern(pageUrl)] }).catch((err) => console.error('[silk] site access request failed', err))
  }
  void persist(withDomainRule(settings, host, (value || null) as DomainRule | null))
})

$('translate-btn').addEventListener('click', () => void setPageMode(settings.defaultMode))

// ───────────── preferences ─────────────

const defaultModeSeg = segmented($('default-mode'), (value) => void persist({ defaultMode: value as TranslateMode }))
const styleSeg = segmented($('style-seg'), (value) => void persist({ bilingualStyle: value as BilingualStyle }))

/** Shows the shortcut Chrome has bound to the toggle command (empty when the user removed it). */
async function renderShortcut(): Promise<void> {
  const commands = await chrome.commands.getAll()
  const shortcut = commands.find((c) => c.name === TOGGLE_COMMAND)?.shortcut ?? ''
  const button = $('shortcut')
  if (!shortcut) {
    button.textContent = t('shortcutNone')
    return
  }
  button.replaceChildren(
    ...shortcut.split('+').map((part) => {
      const kbd = document.createElement('kbd')
      kbd.textContent = part
      return kbd
    }),
  )
}

/** Chrome owns the binding: the button opens its shortcut page (extension pages may open chrome:// URLs). */
function initShortcut(): void {
  $('shortcut').addEventListener('click', () => void chrome.tabs.create({ url: SHORTCUTS_PAGE }))
  void renderShortcut()
}

/**
 * "Run on all sites" mirrors the optional all-sites grant. The prompt can close the popup, so the
 * service worker (permissions.onAdded) registers the content script, not this page.
 */
async function initSiteAccess(): Promise<void> {
  const allSites = $<HTMLInputElement>('all-sites')
  const render = async () => (allSites.checked = await hasAllSites())
  await render()
  allSites.addEventListener('change', () => {
    const origins = [...ALL_SITES]
    const change = allSites.checked ? chrome.permissions.request({ origins }) : chrome.permissions.remove({ origins })
    change.catch((err) => console.error('[silk] site access change failed', err)).finally(() => void render())
  })
  chrome.permissions.onAdded.addListener(() => void render())
  chrome.permissions.onRemoved.addListener(() => void render())
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

function modelCards(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('.model')]
}

const isLocked = (card: HTMLElement) => !entitlement.models.includes(card.dataset.value ?? '')

/**
 * Marks the model actually used (a locked choice shows its fallback) and greys out models the
 * plan does not include. Safe to call again after the plan or the language changed.
 */
function renderModels(): void {
  const active = effectiveModel(entitlement, settings.model) ?? settings.model
  const cards = modelCards()
  cards.forEach((card) => {
    const model = CLOUD_MODELS.find((m) => m.id === card.dataset.value)
    const locked = isLocked(card)
    const isActive = card.dataset.value === active
    card.setAttribute('aria-checked', String(isActive))
    card.setAttribute('aria-disabled', String(locked))
    card.classList.toggle('is-locked', locked)
    card.tabIndex = isActive ? 0 : -1
    const note = card.querySelector('.model-note')
    if (model && note) note.textContent = t(locked ? 'modelLocked' : model.note)
  })
  $('models-hint').hidden = entitlement.plan !== 'beta' || !cards.some(isLocked)
}

/** One radio card per model; arrow keys move the choice like a native radio group, skipping locked ones. */
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

  const select = async (card: HTMLButtonElement) => {
    if (isLocked(card) || card.dataset.value === settings.model) return
    await persist({ model: card.dataset.value })
    renderModels()
  }
  cards.forEach((card, i) => {
    card.addEventListener('click', () => void select(card))
    card.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
      if (!step) return
      e.preventDefault()
      for (let k = 1; k < cards.length; k++) {
        const next = cards[(i + step * k + cards.length * k) % cards.length]
        if (isLocked(next)) continue
        next.focus()
        void select(next)
        return
      }
    })
  })
  renderModels()
}

/** Plan and today's quota, straight from the backend; false when the backend could not be asked. */
async function checkAccount(): Promise<boolean> {
  setConn('idle', 'connChecking')
  const result = (await chrome.runtime.sendMessage({ type: 'silk:account' } satisfies AccountRequest).catch((err: unknown) => {
    console.error('[silk] account check failed', err)
    return { ok: false, message: t('backgroundUnreachable') }
  })) as AccountResult
  if (!result.ok) {
    setTestResult(result.message, 'error')
    setConn('error', 'connFailed')
    return false
  }
  entitlement = result.entitlement
  renderModels()
  const isEnabled = canUseCloudAi(entitlement)
  const isExhausted = !!entitlement.quota && entitlement.quota.used >= entitlement.quota.limit
  const summary = [t(PLAN_LABELS[entitlement.plan]), entitlement.quota ? describeQuota(entitlement.quota, resolveUiLang(settings.uiLang)) : '']
  setTestResult(summary.filter(Boolean).join(' · '), isEnabled && !isExhausted ? 'ok' : 'error')
  renderQuotaMeter(entitlement.quota)
  if (!isEnabled) setConn('warn', 'connUpgrade')
  else if (isExhausted) setConn('warn', 'connQuota')
  else setConn('ok', 'connReady')
  return true
}

/** Thin usage bar: indigo below 80 %, warning colour from 80 %, danger when used up (the text says the same). */
function renderQuotaMeter(quota: Entitlement['quota']): void {
  const meter = $('quota-meter')
  meter.hidden = !quota
  if (!quota) return
  const share = quota.limit > 0 ? Math.min(quota.used / quota.limit, 1) : 1
  meter.dataset.level = share >= 1 ? 'full' : share >= 0.8 ? 'high' : 'ok'
  ;(meter.firstElementChild as HTMLElement).style.transform = `scaleX(${share})`
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

// ───────────── developer mode ─────────────

/** Clicks on the logo that reveal the developer card (it stays visible while a key is stored). */
const DEV_UNLOCK_CLICKS = 5

function setDevStatus(key: MessageKey | null, kind: 'ok' | 'error' | '' = ''): void {
  const status = $('dev-status')
  status.textContent = key ? t(key) : ''
  status.className = `small ${kind}`
}

async function storedDevKey(): Promise<string | null> {
  return sanitizeDevKey((await chrome.storage.local.get(DEV_KEY_STORAGE_KEY))[DEV_KEY_STORAGE_KEY])
}

/** Stores the key, then keeps it only if the backend answers with the developer plan. */
async function saveDevKey(raw: string): Promise<void> {
  const key = sanitizeDevKey(raw)
  if (!key) return setDevStatus('devKeyInvalid', 'error')
  await chrome.storage.local.set({ [DEV_KEY_STORAGE_KEY]: key })
  if (!(await checkAccount())) return setDevStatus('devKeyUnverified', 'error')
  if (entitlement.plan !== 'dev') {
    await chrome.storage.local.remove(DEV_KEY_STORAGE_KEY)
    void checkAccount()
    return setDevStatus('devKeyInvalid', 'error')
  }
  $<HTMLInputElement>('dev-key').value = ''
  $('dev-remove').hidden = false
  setDevStatus('devKeyActive', 'ok')
}

async function removeDevKey(): Promise<void> {
  await chrome.storage.local.remove(DEV_KEY_STORAGE_KEY)
  $('dev-remove').hidden = true
  setDevStatus(null)
  await checkAccount()
}

async function initDevMode(): Promise<void> {
  const isActive = !!(await storedDevKey())
  $('dev-card').hidden = !isActive
  $('dev-remove').hidden = !isActive
  if (isActive) setDevStatus('devKeyActive', 'ok')
  let clicks = 0
  document.querySelector('.logo')?.addEventListener('click', () => {
    if (++clicks < DEV_UNLOCK_CLICKS) return
    $('dev-card').hidden = false
    $('dev-key').focus()
  })
  $('dev-save').addEventListener('click', () => void saveDevKey($<HTMLInputElement>('dev-key').value))
  $('dev-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void saveDevKey($<HTMLInputElement>('dev-key').value)
  })
  $('dev-remove').addEventListener('click', () => void removeDevKey())
}

// ───────────── interface language ─────────────

/** Fills every static label; called again whenever the interface language changes. */
function applyLanguage(): void {
  document.documentElement.lang = resolveUiLang(settings.uiLang)
  document.title = resolveUiLang(settings.uiLang) === 'en' ? 'Silk Translate' : `${t('appName')} Silk Translate`
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as MessageKey)))
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria as MessageKey)))
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle as MessageKey)))
  renderModels()
  const uiLang = $<HTMLSelectElement>('ui-lang')
  const names: Record<UiLangSetting, string> = { auto: t('uiAuto'), 'zh-TW': '繁體中文', 'zh-CN': '简体中文', en: 'English' }
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
  const stored = (await chrome.storage.local.get('entitlement')).entitlement
  entitlement = sanitizeEntitlement(stored) ?? entitlement
  $('beta-badge').hidden = RELEASE_CHANNEL !== 'beta'

  const lang = $<HTMLSelectElement>('lang')
  lang.replaceChildren(...LANGUAGES.map((l) => new Option(l.label, l.code)))
  lang.value = settings.targetLang
  lang.addEventListener('change', () => void persist({ targetLang: lang.value }))

  defaultModeSeg.setValue(settings.defaultMode)
  styleSeg.setValue(settings.bilingualStyle)

  const animate = $<HTMLInputElement>('animate')
  animate.checked = settings.animateTranslations
  animate.addEventListener('change', () => void persist({ animateTranslations: animate.checked }))

  const selection = $<HTMLInputElement>('selection')
  selection.checked = settings.selectionEnabled
  selection.addEventListener('change', () => void persist({ selectionEnabled: selection.checked }))
  await initSiteAccess()

  initModelPicker()
  applyLanguage()
  $('ui-lang').addEventListener('change', async (e) => {
    await persist({ uiLang: (e.target as HTMLSelectElement).value as UiLangSetting })
    applyLanguage()
    void renderShortcut()
    void runAccountCheck()
  })
  initShortcut()
  $('test-btn').addEventListener('click', () => void runAccountCheck())
  await initDevMode()
  void runAccountCheck()
  await initPage()
}

addEventListener('unload', () => clearInterval(pollTimer))
init().catch((err) => {
  console.error('[silk] popup failed', err)
  setTestResult(t('popupFailed'), 'error')
})
