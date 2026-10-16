import { describe, expect, it, vi } from 'vitest'
import { resolveUiLang, translator } from '../src/shared/i18n'
import { CLOUD_MODELS, DEFAULT_SETTINGS, dropLegacySettings, engineId, MAX_CONCURRENCY, sanitizeSettings, withDomainRule } from '../src/shared/settings'
import { eventToShortcut, isValidShortcut, matchesShortcut } from '../src/shared/shortcut'
import { getLanguage } from '../src/shared/languages'
import { contentScriptMatches, sitePattern } from '../src/shared/site-access'

const key = (code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
})

describe('sanitizeSettings', () => {
  it('returns defaults for garbage input', () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(sanitizeSettings('x')).toEqual(DEFAULT_SETTINGS)
  })

  it('validates every field and keeps valid values', () => {
    const result = sanitizeSettings({
      model: 'openai/gpt-6-sol',
      uiLang: 'en',
      targetLang: 'ja',
      defaultMode: 'bilingual',
      bilingualStyle: 'highlight',
      shortcut: 'Ctrl+Shift+Y',
      selectionEnabled: false,
      domainRules: { 'example.com': 'always', 'bad host!': 'always', 'x.org': 'sometimes' },
    })
    expect(result).toEqual({
      model: 'openai/gpt-6-sol',
      uiLang: 'en',
      targetLang: 'ja',
      defaultMode: 'bilingual',
      bilingualStyle: 'highlight',
      shortcut: 'Ctrl+Shift+Y',
      selectionEnabled: false,
      domainRules: { 'example.com': 'always' },
    })
  })

  it('rejects unsafe or invalid values', () => {
    const result = sanitizeSettings({
      targetLang: 'xx',
      defaultMode: 'original',
      shortcut: 'T',
      model: 'deepseek-ai/DeepSeek-V3',
      uiLang: 'fr',
    })
    expect(result.targetLang).toBe('zh-CN')
    expect(result.defaultMode).toBe('overlay')
    expect(result.shortcut).toBe('Alt+T')
    expect(result.model).toBe(DEFAULT_SETTINGS.model)
    expect(result.uiLang).toBe('auto')
  })

  it('offers the four Silk AI models and defaults to the cheapest', () => {
    expect(CLOUD_MODELS.map((m) => m.id)).toEqual(['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash'])
    expect(DEFAULT_SETTINGS.model).toBe('deepseek/deepseek-v4-flash')
  })

  it('runs 8 requests at once and ignores the old concurrency setting', () => {
    expect(MAX_CONCURRENCY).toBe(8)
    expect(sanitizeSettings({ maxConcurrency: 2 })).toEqual(DEFAULT_SETTINGS)
  })

  it('drops settings of removed engines (provider, API keys, endpoint)', () => {
    const result = sanitizeSettings({ provider: 'openai', apiKey: 'sk-1', googleApiKey: 'AIza', baseUrl: 'https://x.test/v1', model: 'google/gemini-3.8-flash' })
    expect(result).toEqual({ ...DEFAULT_SETTINGS, model: 'google/gemini-3.8-flash' })
  })

  it('dropLegacySettings removes stored API keys once and leaves clean settings untouched', async () => {
    const store: Record<string, unknown> = { settings: { provider: 'openai', apiKey: 'sk-1', targetLang: 'ja' } }
    const set = vi.fn(async (items: Record<string, unknown>) => Object.assign(store, items))
    vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => ({ [key]: store[key] }), set } } })
    await dropLegacySettings()
    expect(store.settings).toEqual({ ...DEFAULT_SETTINGS, targetLang: 'ja' })
    await dropLegacySettings()
    expect(set).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it('engineId separates cached translations per model', () => {
    expect(engineId(DEFAULT_SETTINGS)).toBe('cloud:deepseek/deepseek-v4-flash')
    expect(engineId({ ...DEFAULT_SETTINGS, model: 'openai/gpt-6-sol' })).toBe('cloud:openai/gpt-6-sol')
  })

  it('withDomainRule adds, replaces and removes rules immutably', () => {
    const a = withDomainRule(DEFAULT_SETTINGS, 'a.com', 'always')
    const b = withDomainRule(a, 'a.com', 'never')
    const c = withDomainRule(b, 'a.com', null)
    expect(a.domainRules).toEqual({ 'a.com': 'always' })
    expect(b.domainRules).toEqual({ 'a.com': 'never' })
    expect(c.domainRules).toEqual({})
    expect(DEFAULT_SETTINGS.domainRules).toEqual({})
  })
})

describe('shortcut', () => {
  it('formats physical keys with modifiers', () => {
    expect(eventToShortcut(key('KeyT', { altKey: true }))).toBe('Alt+T')
    expect(eventToShortcut(key('Digit1', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+1')
    expect(eventToShortcut(key('F2'))).toBe('F2')
    expect(eventToShortcut(key('AltLeft', { altKey: true }))).toBeNull()
    expect(eventToShortcut(key('IntlRo'))).toBeNull()
  })

  it('validates that a shortcut cannot fire during normal typing', () => {
    expect(isValidShortcut('Alt+T')).toBe(true)
    expect(isValidShortcut('F8')).toBe(true)
    expect(isValidShortcut('Shift+T')).toBe(false)
    expect(isValidShortcut('T')).toBe(false)
    expect(isValidShortcut('Hyper+T')).toBe(false)
    expect(isValidShortcut(42)).toBe(false)
  })

  it('matches events against a stored shortcut', () => {
    expect(matchesShortcut(key('KeyT', { altKey: true }), 'Alt+T')).toBe(true)
    expect(matchesShortcut(key('KeyT', { altKey: true, shiftKey: true }), 'Alt+T')).toBe(false)
  })
})

describe('languages', () => {
  it('falls back to the first language for unknown codes', () => {
    expect(getLanguage('ja').label).toBe('日本語')
    expect(getLanguage('??').code).toBe('zh-CN')
  })

})

describe('i18n', () => {
  it('follows the browser for auto: Chinese locales get Chinese, everything else English', () => {
    expect(resolveUiLang('auto', 'zh-TW')).toBe('zh-CN')
    expect(resolveUiLang('auto', 'en-US')).toBe('en')
    expect(resolveUiLang('auto', 'ja')).toBe('en')
    expect(resolveUiLang('en', 'zh-CN')).toBe('en')
  })

  it('fills placeholders', () => {
    expect(translator('en')('pageTranslating', { done: 3, total: 9 })).toBe('Translating 3/9')
    expect(translator('zh-CN')('pageFailed', { n: 2 })).toBe('2 段失败')
  })
})

describe('site access', () => {
  it('builds a per-host pattern without the port', () => {
    expect(sitePattern(new URL('https://example.com:8443/a?b'))).toBe('https://example.com/*')
  })

  it('runs the content script on granted web origins but never on the backend', () => {
    const origins = ['https://*/*', 'http://*/*', 'https://news.example/*', 'https://api.silk.dev/*', 'chrome://favicon/*']
    expect(contentScriptMatches(origins, 'https://api.silk.dev')).toEqual(['https://*/*', 'http://*/*', 'https://news.example/*'])
    expect(contentScriptMatches(['https://api.silk.dev/*'], 'https://api.silk.dev')).toEqual([])
  })
})
