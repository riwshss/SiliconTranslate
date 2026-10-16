/**
 * Per-Text-node memory: the page's original text and the last value we wrote.
 *
 * Kept in a WeakMap so detached nodes are garbage-collected with the page. Comparing the
 * live nodeValue with `written` tells our own writes apart from framework re-renders
 * (a React/Vue update that changes the text becomes the new original).
 */
interface TextRecord {
  readonly orig: string
  readonly written: string
}

const records = new WeakMap<Text, TextRecord>()

export function originalText(node: Text): string {
  const current = node.nodeValue ?? ''
  const record = records.get(node)
  if (record && current === record.written) return record.orig
  if (record) records.set(node, { orig: current, written: current })
  return current
}

export function writeText(node: Text, value: string): void {
  const orig = originalText(node)
  if (node.nodeValue !== value) node.nodeValue = value
  records.set(node, { orig, written: value })
}

export function restoreText(node: Text): void {
  if (!records.has(node)) return
  writeText(node, originalText(node))
}

/** True when the node still shows exactly what this extension last wrote into it. */
export function isOwnWrite(node: Text): boolean {
  const record = records.get(node)
  return !!record && node.nodeValue === record.written
}
