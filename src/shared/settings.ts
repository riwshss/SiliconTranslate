import { isKnownLanguage } from './languages'
import { isValidShortcut } from './shortcut'

export type DisplayMode = 'original' | 'overlay' | 'bilingual'
export type TranslateMode = Exclude<DisplayMode, 'original'>
export type BilingualStyle = 'dashed' | 'highlight'
export type DomainRule = 'always' | 'never'
/**
 * Translation engine. `openai`: SiliconFlow or any OpenAI-compatible endpoint; `google`: Cloud
 * Translation API (v2); `chrome-translator` / `chrome-nano`: Chrome's on-device Translator API and
 * Gemini Nano (Prompt API), run in the offscreen document.
 */
export type Provider = 'openai' | 'google' | 'chrome-translator' | 'chrome-nano'

export interface Settings {
  readonly provider: Provider
  readonly apiKey: string
  readonly googleApiKey: string
  readonly baseUrl: string
  readonly model: string
  readonly targetLang: string
  readonly defaultMode: TranslateMode
  readonly bilingualStyle: BilingualStyle
  readonly shortcut: string
  readonly selectionEnabled: boolean
  readonly maxConcurrency: number
  readonly domainRules: Readonly<Record<string, DomainRule>>
}

export const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1'
export const DEFAULT_MODEL = 'Qwen/Qwen2.5-7B-Instruct'

export const MODEL_PRESETS: readonly { id: string; note: string }[] = [
  { id: 'Qwen/Qwen2.5-7B-Instruct', note: '免费 · 快' },
  { id: 'deepseek-ai/DeepSeek-V3', note: '质量高' },
  { id: 'Qwen/Qwen2.5-72B-Instruct', note: '质量高' },
  { id: 'Qwen/Qwen2.5-32B-Instruct', note: '均衡' },
  { id: 'THUDM/glm-4-9b-chat', note: '免费' },
]

export const PROVIDERS: readonly { id: Provider; label: string }[] = [
  { id: 'openai', label: '硅基流动 / OpenAI 兼容' },
  { id: 'google', label: 'Google 翻译 API' },
  { id: 'chrome-translator', label: 'Chrome 内置翻译（本地）' },
  { id: 'chrome-nano', label: 'Chrome 内置 Gemini Nano（本地 · 实验）' },
]
const PROVIDER_IDS = PROVIDERS.map((p) => p.id)

export const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2'

export function isChromeAiProvider(provider: Provider): provider is 'chrome-translator' | 'chrome-nano' {
  return provider === 'chrome-translator' || provider === 'chrome-nano'
}

/** Identifies which engine produced a translation: part of every cache key. */
export function engineId(settings: Settings): string {
  return settings.provider === 'openai' ? `openai:${settings.model}` : settings.provider
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai',
  apiKey: '',
  googleApiKey: '',
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  targetLang: 'zh-CN',
  defaultMode: 'overlay',
  bilingualStyle: 'dashed',
  shortcut: 'Alt+T',
  selectionEnabled: true,
  maxConcurrency: 4,
  domainRules: {},
}

const STORAGE_KEY = 'settings'
const HOST_RE = /^[a-z0-9.-]{1,253}$/
const MAX_DOMAIN_RULES = 500

function pickString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : fallback
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1']

/** https anywhere; plain http only on loopback, so the API key never crosses the network in cleartext. */
function parseEndpoint(value: unknown): URL | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value.trim())
    const isAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))
    return isAllowed ? url : null
  } catch {
    return null
  }
}

function sanitizeBaseUrl(value: unknown): string {
  const url = parseEndpoint(value)
  return url ? url.href.replace(/\/+$/, '') : DEFAULT_BASE_URL
}

/** Hosts granted in manifest `host_permissions`: the default API plus local OpenAI-compatible servers. */
const GRANTED_HOSTS = [new URL(DEFAULT_BASE_URL).hostname, ...LOOPBACK_HOSTS]

/**
 * Match pattern the extension must request (optional_host_permissions) to call `baseUrl`
 * without relying on CORS; null when the manifest already covers it or the endpoint is invalid.
 */
export function hostPermissionFor(baseUrl: string): string | null {
  const url = parseEndpoint(baseUrl)
  if (!url || GRANTED_HOSTS.includes(url.hostname)) return null
  return `${url.protocol}//${url.hostname}/*`
}

function sanitizeDomainRules(value: unknown): Record<string, DomainRule> {
  if (!value || typeof value !== 'object') return {}
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([host, rule]) => HOST_RE.test(host) && (rule === 'always' || rule === 'never'))
    .slice(0, MAX_DOMAIN_RULES)
  return Object.fromEntries(entries) as Record<string, DomainRule>
}

/** Storage is external input: every field is validated and falls back to its default. */
export function sanitizeSettings(raw: unknown): Settings {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const concurrency = Number(src.maxConcurrency)
  return {
    provider: pickEnum(src.provider, PROVIDER_IDS, 'openai'),
    apiKey: typeof src.apiKey === 'string' ? src.apiKey.trim().slice(0, 300) : '',
    googleApiKey: typeof src.googleApiKey === 'string' ? src.googleApiKey.trim().slice(0, 300) : '',
    baseUrl: sanitizeBaseUrl(src.baseUrl),
    model: pickString(src.model, DEFAULT_MODEL, 200),
    targetLang: isKnownLanguage(src.targetLang) ? src.targetLang : DEFAULT_SETTINGS.targetLang,
    defaultMode: pickEnum(src.defaultMode, ['overlay', 'bilingual'] as const, 'overlay'),
    bilingualStyle: pickEnum(src.bilingualStyle, ['dashed', 'highlight'] as const, 'dashed'),
    shortcut: isValidShortcut(src.shortcut) ? src.shortcut : DEFAULT_SETTINGS.shortcut,
    selectionEnabled: typeof src.selectionEnabled === 'boolean' ? src.selectionEnabled : true,
    maxConcurrency: Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 ? concurrency : 4,
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

export function onSettingsChanged(listener: (next: Settings, prev: Settings) => void): () => void {
  const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    const change = changes[STORAGE_KEY]
    if (area !== 'local' || !change) return
    listener(sanitizeSettings(change.newValue), sanitizeSettings(change.oldValue))
  }
  chrome.storage.onChanged.addListener(handler)
  return () => chrome.storage.onChanged.removeListener(handler)
}
