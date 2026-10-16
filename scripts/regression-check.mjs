// Checks for the translation quality regression set (tests/fixtures/regression). Plain
// JavaScript so scripts/regression.mjs runs without a build; typed by regression-check.d.mts.

const MARKER_RE = /<\s*\/?\s*([gc])\s*(\d+)\s*\/?\s*>/gi

/** Marker names (`g0`, `c1`, …) in a markup string. */
export function markersOf(markup) {
  return new Set([...markup.matchAll(MARKER_RE)].map(([, kind, id]) => `${kind.toLowerCase()}${id}`))
}

/**
 * Problems with one translation: missing formatting markers, text that had to stay unchanged
 * (`keep`), and the target's required / forbidden terms. Empty when everything holds.
 */
export function checkTranslation(item, target, translation) {
  if (typeof translation !== 'string' || !translation.trim()) return ['no translation']
  const problems = []
  const kept = markersOf(translation)
  const lost = [...markersOf(item.source)].filter((marker) => !kept.has(marker))
  if (lost.length) problems.push(`lost markers: ${lost.join(', ')}`)
  for (const text of item.keep ?? []) if (!translation.includes(text)) problems.push(`changed: ${text}`)
  const expect = item.expect?.[target]
  for (const term of expect?.must ?? []) if (!translation.includes(term)) problems.push(`missing term: ${term}`)
  for (const term of expect?.mustNot ?? []) if (translation.includes(term)) problems.push(`forbidden term: ${term}`)
  return problems
}

/** Structural errors in the fixture file; empty when it is valid. */
export function validateFixture(fixture, targets) {
  const errors = []
  const ids = new Set()
  for (const item of fixture.items ?? []) {
    if (!item.id || ids.has(item.id)) errors.push(`duplicate or missing id: ${item.id}`)
    ids.add(item.id)
    if (typeof item.source !== 'string' || !item.source.trim()) errors.push(`${item.id}: empty source`)
    for (const text of item.keep ?? []) {
      const plain = item.source.replace(MARKER_RE, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      if (!plain.includes(text)) errors.push(`${item.id}: keep "${text}" is not in the source`)
    }
    for (const [target, expect] of Object.entries(item.expect ?? {})) {
      if (!targets.includes(target)) errors.push(`${item.id}: unknown target ${target}`)
      const overlap = (expect.must ?? []).filter((term) => (expect.mustNot ?? []).some((bad) => term.includes(bad) || bad.includes(term)))
      if (overlap.length) errors.push(`${item.id}: ${target} must and mustNot overlap: ${overlap.join(', ')}`)
    }
  }
  return errors
}
