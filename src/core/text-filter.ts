const HAS_LETTER = /\p{L}/u
const LETTERS = /\p{L}/gu
const HAN = /\p{Script=Han}/gu
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu
const HANGUL = /\p{Script=Hangul}/gu
const URL_ONLY = /^(https?:\/\/|www\.)\S+$/i
const EMAIL_ONLY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const ASCII_TEXT = /^[\x20-\x7E‘-”–—… ]*$/
const ENGLISH_HINT = /\b(the|and|is|are|of|to|in|for|with|that|this|you|your|it)\b/i

/** Skips pure numbers / symbols / single characters / bare URLs and e-mails. */
export function shouldTranslateText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2 || !HAS_LETTER.test(trimmed)) return false
  return !URL_ONLY.test(trimmed) && !EMAIL_ONLY.test(trimmed)
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0
}

/** Cheap script-based guess whether `text` is already written in `lang` (no API call needed). */
export function isLikelyInLanguage(text: string, lang: string): boolean {
  const letters = count(LETTERS, text)
  if (letters === 0) return true
  const han = count(HAN, text)
  const kana = count(KANA, text)
  switch (lang.split('-')[0]) {
    case 'zh':
      return kana === 0 && han / letters >= 0.5
    case 'ja':
      return kana > 0 && (han + kana) / letters >= 0.5
    case 'ko':
      return count(HANGUL, text) / letters >= 0.5
    case 'en':
      return ASCII_TEXT.test(text) && ENGLISH_HINT.test(text)
    default:
      return false
  }
}

const CYRILLIC = /\p{Script=Cyrillic}/gu

/**
 * Script-based source-language guess for when no language-detection model is available.
 * Returns a Translator API code, or null for Latin and other scripts it cannot tell apart.
 */
export function guessLanguageByScript(text: string): string | null {
  const letters = count(LETTERS, text)
  if (letters === 0) return null
  if (count(KANA, text) > 0) return 'ja'
  if (count(HANGUL, text) / letters >= 0.3) return 'ko'
  if (count(HAN, text) / letters >= 0.3) return 'zh'
  if (count(CYRILLIC, text) / letters >= 0.5) return 'ru'
  return null
}
