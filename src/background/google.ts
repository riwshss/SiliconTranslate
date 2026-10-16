import { ApiError } from '../core/errors'
import { GOOGLE_TRANSLATE_URL } from '../shared/settings'
import { fetchWithRetry } from './api'

interface GoogleResponse {
  data?: { translations?: Array<{ translatedText?: unknown }> }
}

/**
 * Cloud Translation API (Basic, v2). The key goes in a header rather than the query string so it
 * never shows up in URLs. Language codes in LANGUAGES are valid Google targets as-is.
 */
export async function googleTranslate(
  apiKey: string,
  texts: readonly string[],
  target: string,
  format: 'html' | 'text',
  signal?: AbortSignal,
): Promise<string[]> {
  let res: Response
  try {
    res = await fetchWithRetry(
      GOOGLE_TRANSLATE_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify({ q: texts, target, format }),
      },
      signal,
    )
  } catch (err) {
    // An invalid key is a 400 (API_KEY_INVALID), not a 401.
    if (err instanceof ApiError && err.code === 'bad-request' && /api key/i.test(err.detail)) throw new ApiError('auth', err.detail)
    throw err
  }
  const json = (await res.json().catch(() => ({}))) as GoogleResponse
  const translations = json.data?.translations
  if (!Array.isArray(translations) || translations.length !== texts.length) throw new ApiError('bad-response', '译文数量不匹配')
  return translations.map((t) => (typeof t.translatedText === 'string' ? t.translatedText : ''))
}
