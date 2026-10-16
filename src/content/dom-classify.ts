import type { ElementKind } from '../core/markup'

/** Never rendered / never content. */
const IGNORE_TAGS = new Set([
  'script', 'style', 'noscript', 'template', 'link', 'meta', 'head', 'title', 'base', 'param', 'source', 'track',
])
/** Kept verbatim and treated as a positional placeholder. */
const FROZEN_TAGS = new Set([
  'code', 'kbd', 'samp', 'pre', 'tt', 'img', 'picture', 'br', 'wbr', 'svg', 'math', 'canvas', 'video', 'audio',
  'iframe', 'object', 'embed', 'input', 'textarea', 'select', 'meter', 'progress',
])
const ICON_CLASS = /(^|\s)(material-icons[\w-]*|material-symbols[\w-]*|google-symbols|icon|icons|iconfont|glyphicon|fa|fas|far|fab|fa-solid|codicon)(\s|$)/
export const OWN_TAG_PREFIX = 'silk-'

export function isOwnElement(el: Element): boolean {
  return el.localName.startsWith(OWN_TAG_PREFIX)
}

function isNoTranslate(el: Element): boolean {
  if (FROZEN_TAGS.has(el.localName)) return true
  if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true
  if ((el as HTMLElement).isContentEditable) return true
  return ICON_CLASS.test(el.getAttribute('class') ?? '')
}

/**
 * Classifies an element for run building. Uses computed `display`, so flex/grid children
 * (which the browser blockifies) correctly become their own paragraphs.
 * Hidden (display:none) subtrees count as blocks: IntersectionObserver ignores them until shown.
 */
export function classifyElement(el: Element): ElementKind {
  const tag = el.localName
  if (IGNORE_TAGS.has(tag) || isOwnElement(el)) return 'ignore'
  const display = getComputedStyle(el).display
  const isInline = display.startsWith('inline') || display === 'contents' || display === 'ruby'
  if (isNoTranslate(el)) return isInline ? 'frozen' : 'opaque'
  return isInline ? 'inline' : 'block'
}

const blockDescendantCache = new WeakMap<Element, boolean>()

export function hasBlockDescendant(el: Element, classify = classifyElement): boolean {
  const cached = blockDescendantCache.get(el)
  if (cached !== undefined) return cached
  let result = false
  for (const child of Array.from(el.children)) {
    const kind = classify(child)
    if (kind === 'block' || kind === 'opaque' || (kind === 'inline' && hasBlockDescendant(child, classify))) {
      result = true
      break
    }
  }
  blockDescendantCache.set(el, result)
  return result
}

export function forgetLayout(el: Element): void {
  blockDescendantCache.delete(el)
}

/** Consecutive inline nodes sharing one parent: the unit of translation. */
export interface Run {
  readonly parent: Element | ShadowRoot
  readonly nodes: readonly Node[]
}

export type ScanRoot = Element | ShadowRoot

export interface ScanCallbacks {
  /** All runs whose nearest block container is `root` (replaces any previous scan of it). */
  onRoot(root: ScanRoot, runs: Run[]): void
  onShadowRoot?(shadow: ShadowRoot): void
}

/**
 * Splits `root` into runs. `deep` also scans nested blocks (each reported as its own root);
 * a shallow scan only re-reads `root`'s own inline flow (used after mutations).
 */
export function scanContainer(root: ScanRoot, deep: boolean, callbacks: ScanCallbacks, classify = classifyElement): void {
  const runs: Run[] = []
  walkFlow(root, runs, deep, callbacks, classify)
  callbacks.onRoot(root, runs)
}

function walkFlow(el: ScanRoot, runs: Run[], deep: boolean, callbacks: ScanCallbacks, classify: typeof classifyElement): void {
  let current: Node[] = []
  const flush = () => {
    if (current.length) runs.push({ parent: el, nodes: current })
    current = []
  }
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      current.push(child)
      continue
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const element = child as Element
    if (deep && element.shadowRoot && !isOwnElement(element)) {
      callbacks.onShadowRoot?.(element.shadowRoot)
      scanContainer(element.shadowRoot, true, callbacks, classify)
    }
    const kind = classify(element)
    if (kind === 'ignore') continue
    if (kind === 'frozen') {
      current.push(element)
    } else if (kind === 'opaque') {
      flush()
    } else if (kind === 'block') {
      flush()
      if (deep) scanContainer(element, true, callbacks, classify)
    } else if (hasBlockDescendant(element, classify)) {
      // An inline wrapper around blocks (e.g. <a class="card"><div>…</div></a>) belongs to this root's flow.
      flush()
      walkFlow(element, runs, deep, callbacks, classify)
    } else {
      current.push(element)
    }
  }
  flush()
}

/** Deep-scans the block containers inside a freshly inserted inline subtree. */
export function scanNestedBlocks(el: Element, callbacks: ScanCallbacks, classify = classifyElement): void {
  for (const child of Array.from(el.children)) {
    const kind = classify(child)
    if (kind === 'block') scanContainer(child, true, callbacks, classify)
    else if (kind === 'inline') scanNestedBlocks(child, callbacks, classify)
  }
}

/**
 * The block container whose shallow scan covers `node`, or null when the node lives in a
 * skipped zone (code, editors, our own UI…).
 */
export function nearestScanRoot(node: Node, classify = classifyElement): ScanRoot | null {
  let candidate: ScanRoot | null = null
  let cur: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode
  while (cur) {
    if (cur instanceof ShadowRoot) return candidate ?? cur
    if (!(cur instanceof Element)) return candidate
    const kind = classify(cur)
    if (kind === 'ignore' || kind === 'frozen' || kind === 'opaque') return null
    if (kind === 'block' && !candidate) candidate = cur
    if (cur === document.body || cur === document.documentElement) return candidate ?? document.body
    cur = cur.parentNode
  }
  return candidate
}
