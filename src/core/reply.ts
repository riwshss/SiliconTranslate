// Checks on what the model sent back, shared by the extension and the backend (DOM-free).

import { keepsFormattingMarkers, stripMarkup } from './markup-text'

/**
 * A reply to a single-item request that is plain text instead of JSON (small models do that):
 * the text itself is the translation. Null when it looks like JSON the parser could not read.
 */
export function plainReply(reply: string): string | null {
  const text = reply
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*```[a-z]*\s*|\s*```\s*$/gi, '')
    .trim()
  return text && !/^[{[]/.test(text) ? text : null
}

const SUSPECT_MIN_SOURCE = 40
const SUSPECT_RATIO = 0.1

/** A translation far shorter than its source was most likely cut off (e.g. at a stray quote). */
export function looksTruncated(source: string, translation: string): boolean {
  const src = stripMarkup(source).trim().length
  return src >= SUSPECT_MIN_SOURCE && stripMarkup(translation).trim().length < src * SUSPECT_RATIO
}

/**
 * A translation worth one more try: cut off, or missing formatting markers (links, bold text),
 * which would make the page fall back to plain text. Never cached by the backend.
 */
export function isSuspectTranslation(source: string, translation: string): boolean {
  return looksTruncated(source, translation) || !keepsFormattingMarkers(source, translation)
}
