// Silk & Ink design tokens (docs/DESIGN.md §3–6): the one place colour, type, shape and motion
// values live. Plain JavaScript so build.mjs can write the popup's tokens.css from it while the
// content script's shadow-DOM styles import the same module; typed by design-tokens.d.mts.

export const LIGHT = {
  bg: '#F6F3EC',
  card: '#FFFFFF',
  solid: '#FFFFFF',
  surface: 'rgba(255, 253, 248, 0.86)',
  field: '#F1EEE6',
  ink: '#1B2230',
  muted: '#5B6170',
  faint: '#8A8F9A',
  line: 'rgba(27, 34, 48, 0.10)',
  hover: 'rgba(27, 34, 48, 0.05)',
  accent: '#2F4C9A',
  'accent-hover': '#273F82',
  'accent-ink': '#FFFFFF',
  'accent-soft': 'rgba(47, 76, 154, 0.10)',
  silk: '#A87A32',
  'silk-soft': 'rgba(168, 122, 50, 0.14)',
  seal: '#C2412D',
  danger: '#B42318',
  warn: '#9A6A12',
  ok: '#2E7D5B',
  shadow: '0 1px 2px rgba(27, 34, 48, 0.06), 0 12px 32px -12px rgba(27, 34, 48, 0.28)',
}

export const DARK = {
  bg: '#121620',
  card: '#1B202B',
  solid: '#1B202B',
  surface: 'rgba(27, 32, 43, 0.84)',
  field: '#232937',
  ink: '#ECEEF3',
  muted: '#A6ACB8',
  faint: '#767D8A',
  line: 'rgba(255, 255, 255, 0.09)',
  hover: 'rgba(255, 255, 255, 0.06)',
  accent: '#9DB2F0',
  'accent-hover': '#B4C4F4',
  'accent-ink': '#0E1630',
  'accent-soft': 'rgba(157, 178, 240, 0.14)',
  silk: '#E0BC7A',
  'silk-soft': 'rgba(224, 188, 122, 0.16)',
  seal: '#E5735F',
  danger: '#FF8A7A',
  warn: '#F0C56A',
  ok: '#6CC79A',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.35), 0 16px 40px -14px rgba(0, 0, 0, 0.65)',
}

/** Shape and motion; the same in both themes. */
export const SHARED = {
  'radius-sm': '8px',
  radius: '12px',
  'ease-silk': 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  'ease-out': 'cubic-bezier(0.3, 0, 0.2, 1)',
  'dur-fast': '120ms',
  dur: '200ms',
  'dur-slow': '320ms',
  'font-mono': 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
}

/** Traditional Chinese interface and text: Traditional glyph forms first. */
export const FONT_UI_TC = 'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif'
/** Everything else (Simplified Chinese and English). */
export const FONT_UI_SC = 'ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif'

const declarations = (tokens) =>
  Object.entries(tokens)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(' ')

/**
 * CSS custom properties for `scope` (`:root` in the popup, `.layer` in the shadow UI): light
 * values, dark ones under prefers-color-scheme, and --font-ui switched by the `lang` of the scope
 * or of any element inside it (e.g. a translation shown in Traditional Chinese).
 */
export function tokenCss(scope) {
  const tc = [`${scope}:lang(zh-TW)`, `${scope}:lang(zh-HK)`, `${scope} :lang(zh-TW)`, `${scope} :lang(zh-HK)`].join(', ')
  return [
    `${scope} { ${declarations(LIGHT)} ${declarations(SHARED)} --font-ui: ${FONT_UI_SC}; color-scheme: light; }`,
    `${scope} :lang(zh-CN) { --font-ui: ${FONT_UI_SC}; }`,
    `${tc} { --font-ui: ${FONT_UI_TC}; }`,
    `@media (prefers-color-scheme: dark) { ${scope} { ${declarations(DARK)} color-scheme: dark; } }`,
  ].join('\n')
}
