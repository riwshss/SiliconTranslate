import type { MessageKey, Translate } from '../../shared/i18n'
import type { PageState } from '../../shared/messages'
import type { DisplayMode } from '../../shared/settings'
import { html, type UiHost } from './host'
import { ICONS } from './icons'

const COLLAPSE_DELAY_MS = 2600
const RING_LENGTH = 2 * Math.PI * 17

export interface HudHandlers {
  onMode(mode: DisplayMode): void
  onRetry(): void
}

export interface Hud {
  update(state: PageState): void
  /** Un-dismisses the HUD (after a shortcut / popup action). */
  reveal(): void
  /** Re-labels everything after the interface language changed. */
  setTranslate(t: Translate): void
}

const MODES: ReadonlyArray<[DisplayMode, MessageKey]> = [
  ['original', 'hudOriginal'],
  ['overlay', 'hudOverlay'],
  ['bilingual', 'hudBilingual'],
]

function statusText(state: PageState, t: Translate): string {
  if (state.failed > 0) return t('pageFailed', { n: state.failed })
  if (state.total > state.done) return t('pageTranslating', { done: state.done, total: state.total })
  if (state.mode === 'original') return t('hudShowingOriginal')
  return state.total ? t('pageTranslated', { n: state.done }) : t('hudPending')
}

export function createHud(ui: UiHost, handlers: HudHandlers, initialT: Translate): Hud {
  const root = html(`
    <div class="hud glass" hidden role="toolbar">
      <div class="badge">${ICONS.translate}<svg class="ring" viewBox="0 0 38 38"><circle cx="19" cy="19" r="17"/></svg></div>
      <div class="hud-body">
        <span class="status" aria-live="polite"></span>
        <button class="retry-btn" hidden>${ICONS.retry}<span></span></button>
        <div class="seg" role="radiogroup">
          <span class="thumb"></span>
          ${MODES.map(([mode]) => `<button role="radio" data-mode="${mode}"></button>`).join('')}
        </div>
        <button class="icon-btn close">${ICONS.close}</button>
      </div>
    </div>`)
  ui.layer.append(root)
  let t = initialT

  const status = root.querySelector('.status') as HTMLElement
  const retry = root.querySelector('.retry-btn') as HTMLButtonElement
  const thumb = root.querySelector('.thumb') as HTMLElement
  const ring = root.querySelector('.ring circle') as SVGCircleElement
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.seg button')]
  ring.style.strokeDasharray = String(RING_LENGTH)

  const applyLabels = () => {
    root.setAttribute('aria-label', t('hudAria'))
    root.querySelector('.badge')?.setAttribute('title', t('appName'))
    ;(retry.querySelector('span') as HTMLElement).textContent = t('retry')
    root.querySelector('.seg')?.setAttribute('aria-label', t('displayMode'))
    buttons.forEach((button) => (button.textContent = t(MODES.find(([mode]) => mode === button.dataset.mode)?.[1] ?? 'hudOriginal')))
    const close = root.querySelector('.close') as HTMLElement
    close.title = t('hideTitle')
    close.setAttribute('aria-label', t('hide'))
  }
  applyLabels()

  let isDismissed = false
  let collapseTimer: ReturnType<typeof setTimeout> | null = null
  let lastState: PageState | null = null

  const moveThumb = (mode: DisplayMode) => {
    const active = buttons.find((b) => b.dataset.mode === mode)
    if (!active) return
    thumb.style.width = `${active.offsetWidth}px`
    thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`
  }

  const scheduleCollapse = (isBusy: boolean) => {
    if (collapseTimer) clearTimeout(collapseTimer)
    collapseTimer = null
    root.classList.remove('is-collapsed')
    if (!isBusy) collapseTimer = setTimeout(() => root.classList.add('is-collapsed'), COLLAPSE_DELAY_MS)
  }

  buttons.forEach((button) =>
    button.addEventListener('click', () => handlers.onMode(button.dataset.mode as DisplayMode)),
  )
  retry.addEventListener('click', () => handlers.onRetry())
  root.querySelector('.close')?.addEventListener('click', () => {
    isDismissed = true
    root.hidden = true
  })

  const update = (state: PageState) => {
    lastState = state
    ui.ensureAttached()
    root.hidden = isDismissed || !state.started
    if (root.hidden) return
    const isBusy = state.total > state.done + state.failed && state.mode !== 'original'
    status.textContent = statusText(state, t)
    status.title = state.error ?? ''
    status.classList.toggle('is-error', state.failed > 0)
    retry.hidden = state.failed === 0
    root.classList.toggle('is-working', isBusy)
    const progress = state.total ? (state.done + state.failed) / state.total : 1
    ring.style.strokeDashoffset = String(RING_LENGTH * (1 - progress))
    buttons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === state.mode)))
    requestAnimationFrame(() => moveThumb(state.mode))
    scheduleCollapse(isBusy || state.failed > 0)
  }

  return {
    update,
    reveal: () => {
      isDismissed = false
      if (lastState) update(lastState)
    },
    setTranslate: (next) => {
      t = next
      applyLabels()
      if (lastState) update(lastState)
    },
  }
}
