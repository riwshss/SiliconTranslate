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
