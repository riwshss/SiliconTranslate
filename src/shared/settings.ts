import { UI_LANG_SETTINGS, type MessageKey, type UiLangSetting } from './i18n'
import { defaultTargetLang, isKnownLanguage } from './languages'
import { isValidShortcut } from './shortcut'

export type DisplayMode = 'original' | 'overlay' | 'bilingual'
export type TranslateMode = Exclude<DisplayMode, 'original'>
export type BilingualStyle = 'dashed' | 'highlight'
export type DomainRule = 'always' | 'never'

/**
 * Models the Silk AI engine offers, as OpenRouter ids. The backend keeps the same list
 * (server/src/app.ts MODELS) and decides which ones each plan may use; the beta only gets the
 * first, cheapest one.
 */
export const CLOUD_MODELS: readonly { id: string; label: string; note: MessageKey }[] = [
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: 'modelCheapest' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', note: 'modelFast' },
  { id: 'openai/gpt-6-sol', label: 'GPT-6 Sol', note: 'modelBest' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash', note: 'modelBalanced' },
]
export const DEFAULT_MODEL = CLOUD_MODELS[0].id

/**
 * Requests in flight at once, across all tabs. Fixed (not a user setting): the Silk backend
 * absorbs it, and 429s still halve it temporarily (see background/translator.ts).
 */
export const MAX_CONCURRENCY = 8
const MODEL_IDS = CLOUD_MODELS.map((m) => m.id)

export interface Settings {
  readonly model: string
  readonly uiLang: UiLangSetting
  readonly targetLang: string
  readonly defaultMode: TranslateMode
  readonly bilingualStyle: BilingualStyle
  readonly shortcut: string
  readonly selectionEnabled: boolean
  readonly domainRules: Readonly<Record<string, DomainRule>>
}

/** Identifies which model produced a translation: part of every cache key. */
export function engineId(settings: Settings): string {
  return `cloud:${settings.model}`
}

/** Defaults; `targetLang` is replaced by the browser's Chinese variant (see defaultTargetLang) when nothing is stored. */
export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  uiLang: 'auto',
  targetLang: 'zh-CN',
  defaultMode: 'overlay',
  bilingualStyle: 'dashed',
  shortcut: 'Alt+T',
  selectionEnabled: true,
  domainRules: {},
}

const STORAGE_KEY = 'settings'
const HOST_RE = /^[a-z0-9.-]{1,253}$/
const MAX_DOMAIN_RULES = 500

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function sanitizeDomainRules(value: unknown): Record<string, DomainRule> {
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([host, rule]) => HOST_RE.test(host) && (rule === 'always' || rule === 'never'))
    .slice(0, MAX_DOMAIN_RULES)
  return Object.fromEntries(entries) as Record<string, DomainRule>
}

/**
 * Storage is external input: every field is validated and falls back to its default. Fields of
 * removed engines (provider, API keys, base URL) and the old concurrency setting are dropped here.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    model: pickEnum(src.model, MODEL_IDS, DEFAULT_MODEL),
    uiLang: pickEnum(src.uiLang, UI_LANG_SETTINGS, DEFAULT_SETTINGS.uiLang),
    targetLang: isKnownLanguage(src.targetLang) ? src.targetLang : defaultTargetLang(),
    defaultMode: pickEnum(src.defaultMode, ['overlay', 'bilingual'] as const, 'overlay'),
    bilingualStyle: pickEnum(src.bilingualStyle, ['dashed', 'highlight'] as const, 'dashed'),
    shortcut: isValidShortcut(src.shortcut) ? src.shortcut : DEFAULT_SETTINGS.shortcut,
    selectionEnabled: typeof src.selectionEnabled === 'boolean' ? src.selectionEnabled : true,
    domainRules: sanitizeDomainRules(src.domainRules),
  }
}

export function withDomainRule(settings: Settings, host: string, rule: DomainRule | null): Settings {
  const rest = Object.fromEntries(Object.entries(settings.domainRules).filter(([key]) => key !== host))
  return { ...settings, domainRules: rule ? { ...rest, [host]: rule } : rest }
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  return sanitizeSettings(stored[STORAGE_KEY])
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = sanitizeSettings({ ...current, ...patch })
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

/**
 * Fields of the engines earlier versions offered (OpenAI-compatible, Google, Chrome on-device), and
 * the concurrency setting that is now fixed.
 */
const LEGACY_KEYS = ['provider', 'apiKey', 'googleApiKey', 'baseUrl', 'maxConcurrency']

/**
 * Rewrites stored settings only when they still hold legacy fields, so API keys from earlier
 * versions do not linger in storage. Writes nothing otherwise (no race with a fresh install).
 */
export async function dropLegacySettings(): Promise<void> {
  const raw = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
  if (!raw || typeof raw !== 'object' || !LEGACY_KEYS.some((key) => key in raw)) return
  await chrome.storage.local.set({ [STORAGE_KEY]: sanitizeSettings(raw) })
}

export function onSettingsChanged(listener: (next: Settings, prev: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const change = changes[STORAGE_KEY]
    if (area !== 'local' || !change) return
    listener(sanitizeSettings(change.newValue), sanitizeSettings(change.oldValue))
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
