import { buildTranslationFragment, computeOverlayPlan, serializeRun, type Serialized } from '../core/markup'
import { isLikelyInLanguage, shouldTranslateText } from '../core/text-filter'
import { DARK, LIGHT } from '../shared/design-tokens.mjs'
import type { BilingualStyle, DisplayMode } from '../shared/settings'
import { classifyElement, type Run } from './dom-classify'
import { originalText, restoreText, writeText } from './text-state'

const MAX_MARKUP_CHARS = 6000
const SHORT_LABEL_CHARS = 24
export const TRANSLATION_TAG = 'silk-trans'
const TRANSLATION_INNER_TAG = 'silk-t'

/** One translatable run plus everything needed to switch display modes without an API call. */
export interface Unit {
  readonly run: Run
  /** Element watched by IntersectionObserver. */
  readonly target: Element
  readonly ser: Serialized
  readonly key: string
  translation?: string
  plan?: Map<Text, string>
  transEl?: HTMLElement
  requested: boolean
  failed: boolean
}

export function createUnit(run: Run, targetLang: string): Unit | null {
  const ser = serializeRun(run.nodes, classifyElement, originalText)
  if (!ser.markup || ser.markup.length > MAX_MARKUP_CHARS) return null
  if (!shouldTranslateText(ser.plain) || isLikelyInLanguage(ser.plain, targetLang)) return null
  const target = run.parent instanceof ShadowRoot ? run.parent.host : run.parent
  return { run, target, ser, key: ser.markup, requested: false, failed: false }
}

export function setTranslation(unit: Unit, translation: string): void {
  unit.translation = translation
  unit.plan = undefined
  unit.failed = false
}

export function clearTranslation(unit: Unit): void {
  unit.translation = undefined
  unit.plan = undefined
  unit.requested = false
  unit.failed = false
}

function restoreUnit(unit: Unit): void {
  unit.ser.textNodes.forEach(restoreText)
}

export function removeTranslationElement(unit: Unit): void {
  unit.transEl?.remove()
  unit.transEl = undefined
}

function applyOverlay(unit: Unit, translation: string): void {
  unit.plan ??= computeOverlayPlan(unit.ser, translation)
  const plan = unit.plan
  unit.ser.textNodes.forEach((node) => {
    const value = plan.get(node)
    if (value === undefined) restoreText(node)
    else writeText(node, value)
  })
}

function isShortLabel(unit: Unit): boolean {
  if (unit.ser.plain.length >= SHORT_LABEL_CHARS || /[.!?。！？]/.test(unit.ser.plain)) return false
  return true
}

function prefersInline(unit: Unit): boolean {
  if (isShortLabel(unit)) return true
  const display = getComputedStyle(unit.target).display
  return display.includes('flex') || display.includes('grid')
}

/** Inline styles (not a stylesheet) so they also apply inside open shadow roots. */
function outerStyle(isInline: boolean): string {
  return isInline
    ? 'all:unset;display:inline;margin-inline-start:.5em;'
    : 'all:unset;display:block;margin-block-start:.3em;white-space:normal;'
}

/** Halfway between two #RRGGBB colours. */
function midpoint(a: string, b: string): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map((i) => Math.round((channel(a, i) + channel(b, i)) / 2).toString(16).padStart(2, '0')).join('')}`
}

/**
 * The silk colour for someone else's page, where our CSS variables don't exist: halfway between
 * the light and dark silk tokens, mixed with the page's own text colour so it reads on light and
 * dark pages alike.
 */
const SILK_MID = midpoint(LIGHT.silk, DARK.silk)
const PAGE_SILK = `color-mix(in srgb,${SILK_MID} 70%,currentColor)`
const PAGE_SILK_SOFT = `color-mix(in srgb,${SILK_MID} 18%,transparent)`

/** Page font, size, weight and colour are inherited; only a very light mark is added. */
function innerStyle(style: BilingualStyle): string {
  const base = 'all:unset;display:inline;'
  if (style === 'highlight') {
    return `${base}background:${PAGE_SILK_SOFT};border-radius:.25em;padding:.04em .22em;-webkit-box-decoration-break:clone;box-decoration-break:clone;`
  }
  if (style === 'dashed') {
    return `${base}text-decoration:underline dashed color-mix(in srgb,currentColor 45%,transparent);text-decoration-thickness:1px;text-underline-offset:.32em;`
  }
  return `${base}text-decoration:underline dotted ${PAGE_SILK};text-decoration-thickness:1px;text-underline-offset:.32em;`
}

export interface RenderOptions {
  readonly style: BilingualStyle
  /** Target language code, set as `lang` so the browser picks matching glyphs (Traditional / Simplified). */
  readonly lang?: string
  /** Start delay for the fade-in of a newly created bilingual translation; undefined = no animation. */
  readonly revealDelay?: number
}

const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Fade in, rising 2 px (only opacity and transform). Reduced motion: a short fade only. */
function reveal(el: HTMLElement, delay: number): void {
  if (typeof el.animate !== 'function') return
  const isReduced = prefersReducedMotion()
  el.animate(isReduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(2px)' }, { opacity: 1, transform: 'none' }], {
    duration: isReduced ? 120 : 180,
    delay: isReduced ? 0 : delay,
    easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    fill: 'backwards',
  })
}

function ensureTranslationElement(unit: Unit, translation: string, options: RenderOptions): void {
  if (unit.transEl?.isConnected) {
    ;(unit.transEl.firstElementChild as HTMLElement | null)?.setAttribute('style', innerStyle(options.style))
    return
  }
  const last = unit.run.nodes[unit.run.nodes.length - 1]
  if (!last?.isConnected || last.parentNode !== unit.run.parent) return
  const doc = last.ownerDocument ?? document
  const outer = doc.createElement(TRANSLATION_TAG)
  outer.setAttribute('translate', 'no')
  outer.className = 'notranslate'
  outer.setAttribute('style', outerStyle(prefersInline(unit)))
  if (options.lang) outer.setAttribute('lang', options.lang)
  const inner = doc.createElement(TRANSLATION_INNER_TAG)
  inner.setAttribute('style', innerStyle(options.style))
  inner.append(buildTranslationFragment(unit.ser, translation, doc))
  outer.append(inner)
  unit.run.parent.insertBefore(outer, last.nextSibling)
  unit.transEl = outer
  if (options.revealDelay !== undefined) reveal(outer, options.revealDelay)
}

/** Renders a unit for `mode` purely from cached data. */
export function renderUnit(unit: Unit, mode: DisplayMode, options: RenderOptions): void {
  const translation = unit.translation
  if (mode === 'original' || !translation) {
    restoreUnit(unit)
    removeTranslationElement(unit)
    return
  }
  if (mode === 'overlay') {
    removeTranslationElement(unit)
    applyOverlay(unit, translation)
    return
  }
  restoreUnit(unit)
  ensureTranslationElement(unit, translation, options)
}

export function isUnitAttached(unit: Unit): boolean {
  return unit.run.nodes.some((node) => node.isConnected)
}
