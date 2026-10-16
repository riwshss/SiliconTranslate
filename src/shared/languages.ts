export interface Language {
  readonly code: string
  /** Label shown in the UI (native name). */
  readonly label: string
  /** Name used inside the LLM prompt. */
  readonly prompt: string
  /** BCP-47 tag for speechSynthesis. */
  readonly speech: string
}

export const LANGUAGES: readonly Language[] = [
  { code: 'zh-CN', label: '简体中文', prompt: 'Simplified Chinese (简体中文)', speech: 'zh-CN' },
  { code: 'zh-TW', label: '繁體中文', prompt: 'Traditional Chinese (繁體中文, Taiwan usage)', speech: 'zh-TW' },
  { code: 'en', label: 'English', prompt: 'English', speech: 'en-US' },
  { code: 'ja', label: '日本語', prompt: 'Japanese', speech: 'ja-JP' },
  { code: 'ko', label: '한국어', prompt: 'Korean', speech: 'ko-KR' },
  { code: 'fr', label: 'Français', prompt: 'French', speech: 'fr-FR' },
  { code: 'de', label: 'Deutsch', prompt: 'German', speech: 'de-DE' },
  { code: 'es', label: 'Español', prompt: 'Spanish', speech: 'es-ES' },
  { code: 'ru', label: 'Русский', prompt: 'Russian', speech: 'ru-RU' },
  { code: 'pt', label: 'Português', prompt: 'Portuguese', speech: 'pt-BR' },
  { code: 'it', label: 'Italiano', prompt: 'Italian', speech: 'it-IT' },
  { code: 'vi', label: 'Tiếng Việt', prompt: 'Vietnamese', speech: 'vi-VN' },
]

export function getLanguage(code: string): Language {
  return LANGUAGES.find((lang) => lang.code === code) ?? LANGUAGES[0]
}

export function isKnownLanguage(code: unknown): code is string {
  return typeof code === 'string' && LANGUAGES.some((lang) => lang.code === code)
}

/** Chrome's Translator API names Chinese `zh` (Simplified) and `zh-Hant`. */
export function chromeAiLanguage(code: string): string {
  if (code === 'zh-CN') return 'zh'
  if (code === 'zh-TW') return 'zh-Hant'
  return code
}

/** Normalizes a LanguageDetector / tabs.detectLanguage result to a Translator API code. */
export function normalizeDetected(code: string): string | null {
  const lower = code.toLowerCase()
  if (!lower || lower === 'und') return null
  if (lower === 'zh-hant' || lower === 'zh-tw' || lower === 'zh-hk') return 'zh-Hant'
  return lower.split('-')[0]
}
