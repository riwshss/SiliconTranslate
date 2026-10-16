import { describe, expect, it } from 'vitest'
import { createStagger, REVEAL_MAX_STEPS, REVEAL_STAGGER_MS } from '../src/core/stagger'
import { DARK, FONT_UI_TC, LIGHT, tokenCss } from '../src/shared/design-tokens.mjs'

/** WCAG contrast ratio of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('Silk & Ink tokens', () => {
  it('meet the contrast ratios of docs/DESIGN.md §3 against the white card', () => {
    const table: Record<string, number> = { ink: 15.9, muted: 6.2, faint: 3.2, accent: 8.0, silk: 3.8, seal: 5.1, danger: 6.6, ok: 5.0 }
    for (const [name, ratio] of Object.entries(table)) expect(contrast(LIGHT[name], LIGHT.card), name).toBeCloseTo(ratio, 1)
    expect(contrast(LIGHT['accent-ink'], LIGHT.accent)).toBeGreaterThanOrEqual(8)
  })

  it('keep text readable (WCAG AA, 4.5:1) in dark mode too', () => {
    for (const name of ['ink', 'muted', 'accent', 'danger', 'warn', 'ok']) expect(contrast(DARK[name], DARK.card), name).toBeGreaterThanOrEqual(4.5)
    expect(contrast(DARK['accent-ink'], DARK.accent)).toBeGreaterThanOrEqual(4.5)
  })

  it('define the same tokens in both themes and switch fonts by language', () => {
    expect(Object.keys(DARK).sort()).toEqual(Object.keys(LIGHT).sort())
    const css = tokenCss('.layer')
    expect(css).toContain('--silk: #A87A32;')
    expect(css).toContain('@media (prefers-color-scheme: dark)')
    expect(css).toContain(`.layer:lang(zh-TW), .layer:lang(zh-HK), .layer :lang(zh-TW), .layer :lang(zh-HK) { --font-ui: ${FONT_UI_TC}; }`)
    expect(FONT_UI_TC.indexOf('PingFang TC')).toBeLessThan(FONT_UI_TC.indexOf('Microsoft JhengHei'))
    expect(FONT_UI_TC).not.toMatch(/ SC"|YaHei/)
  })
})

describe('translation reveal stagger', () => {
  it('delays each reveal of a burst by 30 ms more, up to 10 steps, and restarts after a pause', () => {
    let now = 0
    const next = createStagger(() => now)
    const delays = Array.from({ length: 14 }, () => {
      now += 5
      return next()
    })
    expect(delays.slice(0, 4)).toEqual([0, 30, 60, 90])
    expect(Math.max(...delays)).toBe(REVEAL_MAX_STEPS * REVEAL_STAGGER_MS)
    now += 1000
    expect(next()).toBe(0)
  })
})
