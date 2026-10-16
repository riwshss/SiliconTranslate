// String-only half of the markup bridge (see markup.ts): parsing and checking the marker strings
// the model sees. Free of DOM types so the backend can share it.

export type ParsedNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tag'; readonly id: number; readonly frozen: boolean; readonly children: ParsedNode[] }

export type ParsedTag = Extract<ParsedNode, { kind: 'tag' }>

const TAG_RE = /<\s*(\/?)\s*([gc])\s*(\d+)\s*(\/?)\s*>/gi

export function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ')
}

export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function unescapeText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

// ───────────────────────────── parse ─────────────────────────────

/** Lenient parser: unknown closers are ignored, unclosed markers close at the end. */
export function parseMarkup(markup: string): ParsedNode[] {
  const root: ParsedNode[] = []
  const stack: ParsedTag[] = []
  const current = () => (stack.length ? stack[stack.length - 1].children : root)
  const pushText = (raw: string) => {
    if (raw) current().push({ kind: 'text', text: unescapeText(raw) })
  }
  let last = 0
  for (const match of markup.matchAll(TAG_RE)) {
    const index = match.index ?? 0
    pushText(markup.slice(last, index))
    last = index + match[0].length
    const [, closing, kind, num, selfClosing] = match
    const id = Number(num)
    if (closing) {
      const open = stack.map((tag) => tag.id).lastIndexOf(id)
      if (open >= 0) stack.length = open
      continue
    }
    const tag: ParsedTag = { kind: 'tag', id, frozen: kind.toLowerCase() === 'c', children: [] }
    current().push(tag)
    if (!selfClosing) stack.push(tag)
  }
  pushText(markup.slice(last))
  return root
}

export function stripMarkup(markup: string): string {
  const flatten = (nodes: ParsedNode[]): string =>
    nodes.map((node) => (node.kind === 'text' ? node.text : flatten(node.children))).join('')
  return flatten(parseMarkup(markup))
}

/** True when every formatting marker (`<gN>`) of `source` survived in `translated`. */
export function keepsFormattingMarkers(source: string, translated: string): boolean {
  const kept = indexTags(parseMarkup(translated), new Map())
  return [...indexTags(parseMarkup(source), new Map()).values()].every((tag) => tag.frozen || kept.has(tag.id))
}

export function indexTags(nodes: ParsedNode[], out: Map<number, ParsedTag>): Map<number, ParsedTag> {
  for (const node of nodes) {
    if (node.kind !== 'tag') continue
    if (!out.has(node.id)) out.set(node.id, node)
    indexTags(node.children, out)
  }
  return out
}
