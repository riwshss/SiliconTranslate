import { buildTranslationFragment, computeOverlayPlan, serializeRun, type Serialized } from '../core/markup'
import { isLikelyInLanguage, shouldTranslateText } from '../core/text-filter'
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

function innerStyle(style: BilingualStyle): string {
  return style === 'highlight'
    ? 'all:unset;display:inline;background:color-mix(in srgb,#f6c445 28%,transparent);border-radius:.25em;padding:.04em .22em;-webkit-box-decoration-break:clone;box-decoration-break:clone;'
    : 'all:unset;display:inline;text-decoration:underline dashed color-mix(in srgb,currentColor 45%,transparent);text-decoration-thickness:1px;text-underline-offset:.32em;'
}

function ensureTranslationElement(unit: Unit, translation: string, style: BilingualStyle): void {
  if (unit.transEl?.isConnected) {
    ;(unit.transEl.firstElementChild as HTMLElement | null)?.setAttribute('style', innerStyle(style))
    return
  }
  const last = unit.run.nodes[unit.run.nodes.length - 1]
  if (!last?.isConnected || last.parentNode !== unit.run.parent) return
  const doc = last.ownerDocument ?? document
  const outer = doc.createElement(TRANSLATION_TAG)
  outer.setAttribute('translate', 'no')
  outer.className = 'notranslate'
  outer.setAttribute('style', outerStyle(prefersInline(unit)))
  const inner = doc.createElement(TRANSLATION_INNER_TAG)
  inner.setAttribute('style', innerStyle(style))
  inner.append(buildTranslationFragment(unit.ser, translation, doc))
  outer.append(inner)
  unit.run.parent.insertBefore(outer, last.nextSibling)
  unit.transEl = outer
}

/** Renders a unit for `mode` purely from cached data. */
export function renderUnit(unit: Unit, mode: DisplayMode, style: BilingualStyle): void {
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
  ensureTranslationElement(unit, translation, style)
}

export function isUnitAttached(unit: Unit): boolean {
  return unit.run.nodes.some((node) => node.isConnected)
}
