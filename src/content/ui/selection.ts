import type { Translate } from '../../shared/i18n'
import { PORT_STREAM, type StreamEvent, type StreamRequest } from '../../shared/messages'
import { html, type UiHost } from './host'
import { ICONS } from './icons'

const MAX_SELECTION_CHARS = 5000
const CARD_ESTIMATED_HEIGHT = 260
const EDGE = 12
const HAS_LETTER = /\p{L}/u

interface Point {
  readonly x: number
  readonly y: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  return !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName ?? ''))
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('style', 'position:fixed;opacity:0;')
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
}

/** Selection → small trigger icon → streamed translation card (all inside the shadow UI). */
export function createSelectionTranslator(ui: UiHost, isEnabled: () => boolean, getT: () => Translate): void {
  const trigger = html(`<button class="trigger glass" hidden>${ICONS.translate}</button>`)
  const card = html(`
    <div class="card glass" hidden role="dialog">
      <div class="card-head">
        <span class="chip"></span>
        <button class="icon-btn close">${ICONS.close}</button>
      </div>
      <div class="source"></div>
      <div class="silk-rule"></div>
      <div class="result" aria-live="polite"></div>
      <div class="card-foot">
        <button class="icon-btn copy">${ICONS.copy}</button>
        <button class="icon-btn speak">${ICONS.speak}</button>
        <button class="icon-btn swap">${ICONS.swap}</button>
      </div>
    </div>`)
  ui.layer.append(trigger, card)

  const chip = card.querySelector('.chip') as HTMLElement
  const source = card.querySelector('.source') as HTMLElement
  const result = card.querySelector('.result') as HTMLElement
  const copyBtn = card.querySelector('.copy') as HTMLButtonElement
  const speakBtn = card.querySelector('.speak') as HTMLButtonElement
  const closeBtn = card.querySelector('.close') as HTMLButtonElement
  const swapBtn = card.querySelector('.swap') as HTMLButtonElement

  /** Labels follow the interface language, which may change while the page is open. */
  const applyLabels = () => {
    const t = getT()
    const label = (el: HTMLElement, title: string, aria = title) => {
      el.title = title
      el.setAttribute('aria-label', aria)
    }
    label(trigger, t('selTrigger'))
    card.setAttribute('aria-label', t('selCard'))
    label(copyBtn, t('copy'))
    label(speakBtn, t('speak'))
    label(swapBtn, t('swapDirection'))
    label(closeBtn, t('closeTitle'), t('close'))
  }

  let selectedText = ''
  let anchorRect: DOMRect | null = null
  let translated = ''
  let speechLang = 'zh-CN'
  /** Translate the other way round (e.g. into English instead of Chinese). */
  let isReversed = false
  let port: chrome.runtime.Port | null = null

  const hideTrigger = () => {
    trigger.hidden = true
  }

  const closeCard = () => {
    card.hidden = true
    port?.disconnect()
    port = null
    speechSynthesis.cancel()
  }

  const showTrigger = (at: Point) => {
    ui.ensureAttached()
    applyLabels()
    trigger.style.left = `${clamp(at.x + 8, EDGE, innerWidth - 30 - EDGE)}px`
    trigger.style.top = `${clamp(at.y + 10, EDGE, innerHeight - 30 - EDGE)}px`
    trigger.hidden = false
  }

  const placeCard = (rect: DOMRect) => {
    const width = Math.min(368, innerWidth - EDGE * 2)
    card.style.left = `${clamp(rect.left, EDGE, innerWidth - width - EDGE)}px`
    const fitsBelow = rect.bottom + 10 + CARD_ESTIMATED_HEIGHT < innerHeight
    card.style.top = fitsBelow ? `${rect.bottom + 10}px` : ''
    card.style.bottom = fitsBelow ? '' : `${clamp(innerHeight - rect.top + 10, EDGE, innerHeight - 120)}px`
    // Grows out of the selection: from its top edge when the card sits above it.
    card.classList.toggle('is-above', !fitsBelow)
  }

  const renderResult = (isStreaming: boolean) => {
    result.classList.remove('is-error')
    result.textContent = translated
    if (isStreaming) result.append(html('<span class="caret"></span>'))
  }

  const showError = (message: string) => {
    result.classList.add('is-error')
    result.textContent = message
  }

  const handleEvent = (event: StreamEvent) => {
    if (event.type === 'meta') {
      chip.textContent = `→ ${event.targetLabel}`
      speechLang = event.speech
      // Font follows the translation's language (Traditional vs Simplified glyph forms).
      result.lang = event.lang
    } else if (event.type === 'delta') {
      translated += event.text
      renderResult(true)
    } else {
      port?.disconnect()
      port = null
      if (event.error) showError(event.error.message)
      else renderResult(false)
    }
  }

  const openCard = () => {
    hideTrigger()
    port?.disconnect()
    speechSynthesis.cancel()
    speakBtn.innerHTML = ICONS.speak
    translated = ''
    applyLabels()
    chip.textContent = getT()('selTranslating')
    source.textContent = selectedText
    result.classList.remove('is-error')
    result.removeAttribute('lang')
    result.replaceChildren(html('<div class="loader"></div>'))
    if (anchorRect) placeCard(anchorRect)
    card.hidden = false
    try {
      port = chrome.runtime.connect({ name: PORT_STREAM })
    } catch {
      showError(getT()('extensionGone'))
      return
    }
    port.onMessage.addListener(handleEvent)
    port.onDisconnect.addListener(() => {
      if (port && !translated) showError(getT()('portLost'))
      port = null
    })
    const request: StreamRequest = { text: selectedText, isReversed }
    port.postMessage(request)
  }

  // Keep the page selection alive when pressing our button.
  trigger.addEventListener('mousedown', (e) => e.preventDefault())
  trigger.addEventListener('click', () => {
    isReversed = false
    swapBtn.classList.remove('is-on')
    openCard()
  })
  swapBtn.addEventListener('click', () => {
    if (!selectedText) return
    isReversed = !isReversed
    swapBtn.classList.toggle('is-on', isReversed)
    openCard()
  })
  closeBtn.addEventListener('click', closeCard)
  copyBtn.addEventListener('click', async () => {
    if (!translated) return
    await copyText(translated)
    copyBtn.innerHTML = ICONS.check
    copyBtn.classList.add('is-ok')
    setTimeout(() => {
      copyBtn.innerHTML = ICONS.copy
      copyBtn.classList.remove('is-ok')
    }, 1400)
  })
  speakBtn.addEventListener('click', () => {
    if (speechSynthesis.speaking) {
      speechSynthesis.cancel()
      return
    }
    if (!translated) return
    const utterance = new SpeechSynthesisUtterance(translated)
    utterance.lang = speechLang
    utterance.onend = () => (speakBtn.innerHTML = ICONS.speak)
    speakBtn.innerHTML = ICONS.stop
    speechSynthesis.speak(utterance)
  })

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || ui.isInside(e) || !isEnabled() || isEditableTarget(e.target)) return
    const at = { x: e.clientX, y: e.clientY }
    // Let the browser finalise the selection (double/triple click) first.
    setTimeout(() => {
      const selection = getSelection()
      const text = selection?.toString().trim() ?? ''
      if (!selection || !selection.rangeCount || !text || text.length > MAX_SELECTION_CHARS || !HAS_LETTER.test(text)) {
        hideTrigger()
        return
      }
      selectedText = text
      anchorRect = selection.getRangeAt(0).getBoundingClientRect()
      showTrigger(at)
    }, 0)
  })
  document.addEventListener('mousedown', (e) => {
    if (ui.isInside(e)) return
    hideTrigger()
    if (!card.hidden) closeCard()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    hideTrigger()
    if (!card.hidden) closeCard()
  })
  addEventListener('scroll', hideTrigger, { passive: true, capture: true })
}
