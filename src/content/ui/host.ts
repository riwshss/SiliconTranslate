import { UI_CSS } from './styles'

export interface UiHost {
  readonly layer: HTMLElement
  /** Interface language: picks the font stack (Traditional / Simplified glyph forms). */
  setLang(lang: string): void
  /** Re-attaches the host if a SPA wiped it from the document. */
  ensureAttached(): void
  /** Whether an event originated inside our shadow UI. */
  isInside(event: Event): boolean
}

/** Single zero-size host on <html>; all extension UI renders inside its shadow root. */
export function createUiHost(lang: string): UiHost {
  const host = document.createElement('silk-ui')
  host.setAttribute('style', 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = UI_CSS
  const layer = document.createElement('div')
  layer.className = 'layer'
  layer.lang = lang
  shadow.append(style, layer)

  const ensureAttached = () => {
    if (!host.isConnected) document.documentElement.append(host)
  }
  ensureAttached()
  return {
    layer,
    setLang: (next) => (layer.lang = next),
    ensureAttached,
    isInside: (event) => event.composedPath().includes(host),
  }
}

export function html(markup: string): HTMLElement {
  const template = document.createElement('template')
  template.innerHTML = markup.trim()
  return template.content.firstElementChild as HTMLElement
}
