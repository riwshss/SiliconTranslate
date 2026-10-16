import { resolveUiLang, translator } from '../shared/i18n'
import type { PageState, TabMessage } from '../shared/messages'
import { loadSettings, onSettingsChanged, type DisplayMode, type TranslateMode } from '../shared/settings'
import { PageTranslator } from './page-translator'
import { createUiHost } from './ui/host'
import { createHud } from './ui/hud'
import { createSelectionTranslator } from './ui/selection'

declare global {
  interface Window {
    __silkTranslateLoaded?: boolean
  }
}

const DISPLAY_MODES: readonly DisplayMode[] = ['original', 'overlay', 'bilingual']

function isDisplayMode(value: unknown): value is DisplayMode {
  return DISPLAY_MODES.includes(value as DisplayMode)
}

/** Shortcut cycle: 原文 → 默认模式 → 另一种模式 → 原文 */
function nextMode(current: DisplayMode, preferred: TranslateMode): DisplayMode {
  const other: TranslateMode = preferred === 'overlay' ? 'bilingual' : 'overlay'
  const order: DisplayMode[] = ['original', preferred, other]
  return order[(order.indexOf(current) + 1) % order.length]
}

interface PageControls {
  getState(): PageState
  setMode(mode: DisplayMode): void
  toggle(): void
}

async function main(): Promise<PageControls> {
  let settings = await loadSettings()
  const host = location.hostname
  const ui = createUiHost(resolveUiLang(settings.uiLang))
  const t = () => translator(resolveUiLang(settings.uiLang))
  const pageTranslator = new PageTranslator(settings)
  const hud = createHud(
    ui,
    {
      onMode: (mode) => pageTranslator.setMode(mode),
      onRetry: () => pageTranslator.retryFailed(),
    },
    t(),
  )
  pageTranslator.subscribe((state) => hud.update(state))
  createSelectionTranslator(ui, () => settings.selectionEnabled && settings.domainRules[host] !== 'never', t)

  onSettingsChanged((next) => {
    const isLangChanged = next.uiLang !== settings.uiLang
    settings = next
    pageTranslator.updateSettings(next)
    if (isLangChanged) {
      ui.setLang(resolveUiLang(next.uiLang))
      hud.setTranslate(t())
    }
  })

  const setMode = (mode: DisplayMode) => {
    hud.reveal()
    pageTranslator.setMode(mode)
  }

  if (settings.domainRules[host] === 'always') setMode(settings.defaultMode)
  return {
    getState: () => pageTranslator.getState(),
    setMode,
    toggle: () => setMode(nextMode(pageTranslator.getState().mode, settings.defaultMode)),
  }
}

function handleMessage(controls: PageControls, message: TabMessage): PageState {
  if (message.type === 'silk:set-mode' && isDisplayMode(message.mode)) controls.setMode(message.mode)
  if (message.type === 'silk:toggle') controls.toggle()
  return controls.getState()
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set(['silk:get-state', 'silk:set-mode', 'silk:toggle'])

// Guard against double injection (registered content script + injection from the popup or the
// shortcut).
if (!window.__silkTranslateLoaded && document.documentElement instanceof HTMLHtmlElement && document.body) {
  window.__silkTranslateLoaded = true
  const ready = main()
  ready.catch((err) => console.error('[silk] content script failed to start', err))
  // Listening right away, not after settings have loaded: whoever just injected this script
  // sends its message as soon as the injection returns.
  chrome.runtime.onMessage.addListener((message: TabMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !MESSAGE_TYPES.has(message?.type)) return false
    ready.then((controls) => sendResponse(handleMessage(controls, message))).catch(() => sendResponse(null))
    return true
  })
}
