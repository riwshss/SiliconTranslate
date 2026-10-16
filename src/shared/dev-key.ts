// Developer key: pasted once in the popup, sent as X-Silk-Dev-Key; the backend answers with the
// developer plan (every model, no quota) when it matches its DEV_KEY secret.

/** chrome.storage.local key of the pasted developer key. */
export const DEV_KEY_STORAGE_KEY = 'devKey'

/** Base64 / base64url characters only, so the key is always a safe header value. */
const DEV_KEY_RE = /^[A-Za-z0-9+/=_-]{32,256}$/

/** The key without surrounding whitespace, or null when it cannot be one. */
export function sanitizeDevKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim()
  return DEV_KEY_RE.test(key) ? key : null
}
