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
}

const MODES: ReadonlyArray<[DisplayMode, string]> = [
  ['original', '原文'],
  ['overlay', '译文'],
  ['bilingual', '双语'],
]

function statusText(state: PageState): string {
  if (state.failed > 0) return `${state.failed} 段失败`
  if (state.total > state.done) return `翻译中 ${state.done}/${state.total}`
  if (state.mode === 'original') return '显示原文'
  return state.total ? `已翻译 ${state.done} 段` : '待翻译'
}

export function createHud(ui: UiHost, handlers: HudHandlers): Hud {
  const root = html(`
    <div class="hud glass" hidden role="toolbar" aria-label="丝译 翻译控制">
      <div class="badge" title="丝译">${ICONS.translate}<svg class="ring" viewBox="0 0 38 38"><circle cx="19" cy="19" r="17"/></svg></div>
      <div class="hud-body">
        <span class="status" aria-live="polite"></span>
        <button class="retry-btn" hidden>${ICONS.retry}<span>重试</span></button>
        <div class="seg" role="radiogroup" aria-label="显示模式">
          <span class="thumb"></span>
          ${MODES.map(([mode, label]) => `<button role="radio" data-mode="${mode}">${label}</button>`).join('')}
        </div>
        <button class="icon-btn close" title="隐藏（快捷键可再次唤出）" aria-label="隐藏">${ICONS.close}</button>
      </div>
    </div>`)
  ui.layer.append(root)

  const status = root.querySelector('.status') as HTMLElement
  const retry = root.querySelector('.retry-btn') as HTMLButtonElement
  const thumb = root.querySelector('.thumb') as HTMLElement
  const ring = root.querySelector('.ring circle') as SVGCircleElement
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('.seg button')]
  ring.style.strokeDasharray = String(RING_LENGTH)

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
    status.textContent = statusText(state)
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
  }
}
