import type { TabMessage } from '../shared/messages'
import { loadSettings, onSettingsChanged, type DisplayMode, type TranslateMode } from '../shared/settings'
import { matchesShortcut } from '../shared/shortcut'
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

async function main(): Promise<void> {
  let settings = await loadSettings()
  const host = location.hostname
  const ui = createUiHost()
  const translator = new PageTranslator(settings)
  const hud = createHud(ui, {
    onMode: (mode) => translator.setMode(mode),
    onRetry: () => translator.retryFailed(),
  })
  translator.subscribe((state) => hud.update(state))
  createSelectionTranslator(ui, () => settings.selectionEnabled && settings.domainRules[host] !== 'never')

  onSettingsChanged((next) => {
    settings = next
    translator.updateSettings(next)
  })

  const setMode = (mode: DisplayMode) => {
    hud.reveal()
    translator.setMode(mode)
  }

  chrome.runtime.onMessage.addListener((message: TabMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false
    if (message?.type === 'silk:set-mode' && isDisplayMode(message.mode)) setMode(message.mode)
    if (message?.type === 'silk:get-state' || message?.type === 'silk:set-mode') sendResponse(translator.getState())
    return false
  })

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || !matchesShortcut(e, settings.shortcut)) return
      e.preventDefault()
      e.stopPropagation()
      setMode(nextMode(translator.getState().mode, settings.defaultMode))
    },
    true,
  )

  if (settings.domainRules[host] === 'always') setMode(settings.defaultMode)
}

// Guard against double injection (manifest + scripting fallback from the popup).
if (!window.__silkTranslateLoaded && document.documentElement instanceof HTMLHtmlElement && document.body) {
  window.__silkTranslateLoaded = true
  main().catch((err) => console.error('[silk] content script failed to start', err))
}
