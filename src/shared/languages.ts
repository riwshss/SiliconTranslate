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
  { code: 'zh-TW', label: '繁體中文（台灣）', prompt: 'Traditional Chinese as written in Taiwan (臺灣正體中文)', speech: 'zh-TW' },
  { code: 'zh-HK', label: '繁體中文（香港）', prompt: 'Traditional Chinese as written in Hong Kong (香港書面語)', speech: 'zh-HK' },
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

/** navigator.languages where there is one; this file is also compiled for the backend (no DOM types). */
function browserLanguages(): readonly string[] {
  return (globalThis as { navigator?: { languages?: readonly string[] } }).navigator?.languages ?? []
}

/** The Chinese target a browser locale asks for (zh-HK / zh-MO → Hong Kong, zh-TW / zh-Hant → Taiwan), or null. */
export function chineseTargetFor(locale: string): string | null {
  const tag = locale.toLowerCase()
  if (tag !== 'zh' && !tag.startsWith('zh-')) return null
  if (/-(hk|mo)(-|$)/.test(tag)) return 'zh-HK'
  if (/-(tw|hant)(-|$)/.test(tag)) return 'zh-TW'
  return 'zh-CN'
}

/**
 * Default target language for a new install: the first Chinese variant among the browser's
 * languages (many users in Taiwan and Hong Kong run an English browser with Chinese listed
 * second), else Simplified Chinese.
 */
export function defaultTargetLang(locales: readonly string[] = browserLanguages()): string {
  for (const locale of locales) {
    const target = chineseTargetFor(locale)
    if (target) return target
  }
  return 'zh-CN'
}
