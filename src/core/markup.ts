/**
 * Markup bridge between a DOM "run" (consecutive inline nodes inside one block) and the LLM.
 *
 *   <p>Click <a href="/x">here</a> to run <code>npm i</code></p>
 *     ⇣ serializeRun
 *   "Click <g0>here</g0> to run <c1>npm i</c1>"
 *     ⇣ LLM
 *   "点击<g0>这里</g0>运行 <c1>npm i</c1>"
 *     ⇣ computeOverlayPlan
 *   Text("Click ") → "点击", Text("here") → "这里", Text(" to run ") → "运行 "
 *
 * Only Text.nodeValue is ever changed in overlay mode, so links, buttons, event listeners and
 * framework-owned nodes all survive untouched.
 */

import { collapseSpaces, escapeText, indexTags, parseMarkup, stripMarkup, type ParsedNode, type ParsedTag } from './markup-text'

export { collapseSpaces, escapeText, keepsFormattingMarkers, parseMarkup, stripMarkup, unescapeText, type ParsedNode } from './markup-text'

export type ElementKind = 'ignore' | 'frozen' | 'opaque' | 'inline' | 'block'
export type Classify = (el: Element) => ElementKind
export type ReadText = (node: Text) => string

export interface TagNode {
  readonly id: number
  readonly el: Element
  readonly frozen: boolean
  readonly children: ReadonlyArray<Text | TagNode>
}

export interface Serialized {
  readonly markup: string
  /** Translatable plain text (frozen content excluded). */
  readonly plain: string
  readonly textNodes: readonly Text[]
  readonly items: ReadonlyArray<Text | TagNode>
  readonly tags: ReadonlyMap<number, TagNode>
}

const MAX_FROZEN_TEXT = 120
const SAFE_FROZEN_CLONE = new Set(['code', 'kbd', 'samp', 'var', 'br', 'wbr'])

export function isTagNode(item: Text | TagNode): item is TagNode {
  return 'children' in item && 'id' in item
}

function hasText(el: Element): boolean {
  return /\S/.test(el.textContent ?? '')
}

// ───────────────────────────── serialize ─────────────────────────────

interface SerializeContext {
  next: number
  readonly textNodes: Text[]
  readonly tags: Map<number, TagNode>
  readonly plain: string[]
  readonly classify: Classify
  readonly readText: ReadText
}

export function serializeRun(nodes: readonly Node[], classify: Classify, readText: ReadText): Serialized {
  const ctx: SerializeContext = { next: 0, textNodes: [], tags: new Map(), plain: [], classify, readText }
  const { items, markup } = serializeList(nodes, ctx)
  return {
    markup: collapseSpaces(markup).trim(),
    plain: collapseSpaces(ctx.plain.join('')).trim(),
    textNodes: ctx.textNodes,
    items,
    tags: ctx.tags,
  }
}

function serializeList(nodes: Iterable<Node>, ctx: SerializeContext): { items: Array<Text | TagNode>; markup: string } {
  const items: Array<Text | TagNode> = []
  let markup = ''
  for (const node of nodes) {
    if (node.nodeType === 3) {
      const text = ctx.readText(node as Text)
      items.push(node as Text)
      ctx.textNodes.push(node as Text)
      ctx.plain.push(text)
      markup += escapeText(text)
      continue
    }
    if (node.nodeType !== 1) continue
    const el = node as Element
    const kind = ctx.classify(el)
    if (kind === 'ignore') continue
    if (kind === 'frozen' || kind === 'opaque') {
      const id = ctx.next++
      const tag: TagNode = { id, el, frozen: true, children: [] }
      ctx.tags.set(id, tag)
      items.push(tag)
      const inner = collapseSpaces(el.textContent ?? '').trim()
      markup += inner && inner.length <= MAX_FROZEN_TEXT ? `<c${id}>${escapeText(inner)}</c${id}>` : `<c${id}/>`
      ctx.plain.push(' ')
      continue
    }
    // Empty decorative wrappers (icon <i>, spacer <span>) carry no text: leave them out entirely.
    if (!hasText(el)) continue
    const id = ctx.next++
    const inner = serializeList(el.childNodes, ctx)
    const tag: TagNode = { id, el, frozen: false, children: inner.items }
    ctx.tags.set(id, tag)
    items.push(tag)
    markup += `<g${id}>${inner.markup}</g${id}>`
  }
  return { items, markup }
}

// ───────────────────────────── overlay plan ─────────────────────────────

/** Maps every original Text node to the string it should display in overlay mode. */
export function computeOverlayPlan(ser: Serialized, translated: string): Map<Text, string> {
  const parsed = parseMarkup(translated)
  const byId = indexTags(parsed, new Map())
  const plan = new Map<Text, string>()
  const markersIntact = [...ser.tags.values()].every((tag) => tag.frozen || byId.has(tag.id))
  if (!markersIntact) return flatPlan(ser, stripMarkup(translated))

  const orphan = assignContainer(ser.items, parsed, plan, byId)
  if (orphan.trim()) {
    const first = ser.textNodes[0]
    if (first) plan.set(first, orphan + (plan.get(first) ?? ''))
  }
  return plan
}

/** Fallback when the model dropped markers: whole translation into the first text node. */
function flatPlan(ser: Serialized, text: string): Map<Text, string> {
  return new Map(ser.textNodes.map((node, i) => [node, i === 0 ? text : ''] as [Text, string]))
}

function assignContainer(
  items: ReadonlyArray<Text | TagNode>,
  parsedChildren: ParsedNode[],
  plan: Map<Text, string>,
  byId: Map<number, ParsedTag>,
): string {
  // Original layout: text gaps separated by child elements.
  const gaps: Text[][] = [[]]
  const childTags: TagNode[] = []
  for (const item of items) {
    if (isTagNode(item)) {
      childTags.push(item)
      gaps.push([])
    } else {
      gaps[gaps.length - 1].push(item)
    }
  }

  // Translated layout: text between markers, in translated order.
  const translatedGaps = parsedChildren.reduce<string[]>(
    (acc, node) => (node.kind === 'text' ? [...acc.slice(0, -1), acc[acc.length - 1] + node.text] : [...acc, '']),
    [''],
  )
  const values = gaps.map((_, i) => translatedGaps[i] ?? '')
  if (translatedGaps.length > gaps.length) values[values.length - 1] += translatedGaps.slice(gaps.length).join('')

  // Text that landed in a gap without any text node moves forward to the next gap that has one.
  let carry = ''
  let lastWithNodes = -1
  gaps.forEach((nodes, i) => {
    if (nodes.length === 0) {
      carry += values[i]
      return
    }
    plan.set(nodes[0], carry + values[i])
    nodes.slice(1).forEach((extra) => plan.set(extra, ''))
    carry = ''
    lastWithNodes = i
  })
  if (carry && lastWithNodes >= 0) {
    const tail = gaps[lastWithNodes][0]
    plan.set(tail, (plan.get(tail) ?? '') + carry)
    carry = ''
  }

  for (const tag of childTags) {
    if (tag.frozen) continue
    const parsed = byId.get(tag.id)
    if (!parsed || parsed.frozen) continue
    const orphan = assignContainer(tag.children, parsed.children, plan, byId)
    if (orphan.trim()) carry += orphan
  }
  return carry
}

// ───────────────────────────── bilingual fragment ─────────────────────────────

/**
 * Rebuilds the translation with shallow clones of the original inline elements,
 * so links in the bilingual copy stay clickable and styled like the source.
 */
export function buildTranslationFragment(ser: Serialized, translated: string, doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment()
  appendParsed(parseMarkup(translated), fragment, ser, doc)
  return fragment
}

function appendParsed(nodes: ParsedNode[], parent: Node, ser: Serialized, doc: Document): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      parent.appendChild(doc.createTextNode(node.text))
      continue
    }
    const original = ser.tags.get(node.id)
    if (!original) {
      appendParsed(node.children, parent, ser, doc)
      continue
    }
    if (original.frozen) {
      const clone = cloneFrozen(original.el, doc)
      if (clone) parent.appendChild(clone)
      continue
    }
    const clone = original.el.cloneNode(false) as Element
    clone.removeAttribute('id')
    appendParsed(node.children, clone, ser, doc)
    parent.appendChild(clone)
  }
}

function cloneFrozen(el: Element, doc: Document): Node | null {
  if (SAFE_FROZEN_CLONE.has(el.localName)) {
    const clone = el.cloneNode(true) as Element
    clone.removeAttribute('id')
    return clone
  }
  const text = collapseSpaces(el.textContent ?? '').trim()
  return text ? doc.createTextNode(text) : null
}
