import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, engineId, GOOGLE_TRANSLATE_URL, hostPermissionFor, sanitizeSettings, withDomainRule } from '../src/shared/settings'
import { eventToShortcut, isValidShortcut, matchesShortcut } from '../src/shared/shortcut'
import { chromeAiLanguage, getLanguage, normalizeDetected } from '../src/shared/languages'

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
      provider: 'google',
      apiKey: '  sk-123  ',
      googleApiKey: ' AIza-1 ',
      baseUrl: 'https://proxy.example.com/v1/',
      model: 'deepseek-ai/DeepSeek-V3',
      targetLang: 'ja',
      defaultMode: 'bilingual',
      bilingualStyle: 'highlight',
      shortcut: 'Ctrl+Shift+Y',
      selectionEnabled: false,
      maxConcurrency: 6,
      domainRules: { 'example.com': 'always', 'bad host!': 'always', 'x.org': 'sometimes' },
    })
    expect(result).toEqual({
      provider: 'google',
      apiKey: 'sk-123',
      googleApiKey: 'AIza-1',
      baseUrl: 'https://proxy.example.com/v1',
      model: 'deepseek-ai/DeepSeek-V3',
      targetLang: 'ja',
      defaultMode: 'bilingual',
      bilingualStyle: 'highlight',
      shortcut: 'Ctrl+Shift+Y',
      selectionEnabled: false,
      maxConcurrency: 6,
      domainRules: { 'example.com': 'always' },
    })
  })

  it('rejects unsafe or invalid values', () => {
    const result = sanitizeSettings({
      baseUrl: 'javascript:alert(1)',
      targetLang: 'xx',
      defaultMode: 'original',
      shortcut: 'T',
      maxConcurrency: 99,
      model: '   ',
      provider: 'bing',
    })
    expect(result.provider).toBe('openai')
    expect(result.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(result.targetLang).toBe('zh-CN')
    expect(result.defaultMode).toBe('overlay')
    expect(result.shortcut).toBe('Alt+T')
    expect(result.maxConcurrency).toBe(4)
    expect(result.model).toBe(DEFAULT_SETTINGS.model)
    expect(sanitizeSettings({ baseUrl: 'not a url' }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
  })

  it('allows plain http only for loopback hosts so the API key never travels in cleartext', () => {
    expect(sanitizeSettings({ baseUrl: 'http://api.example.com/v1' }).baseUrl).toBe(DEFAULT_SETTINGS.baseUrl)
    expect(sanitizeSettings({ baseUrl: 'http://127.0.0.1:8080/v1' }).baseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(sanitizeSettings({ baseUrl: 'http://localhost:3000/v1/' }).baseUrl).toBe('http://localhost:3000/v1')
  })

  it('hostPermissionFor returns a match pattern only for endpoints not covered by the manifest', () => {
    expect(hostPermissionFor(DEFAULT_SETTINGS.baseUrl)).toBeNull()
    expect(hostPermissionFor('https://api.siliconflow.com/v1')).toBe('https://api.siliconflow.com/*')
    expect(hostPermissionFor('http://127.0.0.1:8080/v1')).toBeNull()
    expect(hostPermissionFor('http://evil.example.com/v1')).toBeNull()
    expect(hostPermissionFor(GOOGLE_TRANSLATE_URL)).toBe('https://translation.googleapis.com/*')
  })

  it('engineId separates cached translations per engine and model', () => {
    expect(engineId(DEFAULT_SETTINGS)).toBe(`openai:${DEFAULT_SETTINGS.model}`)
    expect(engineId({ ...DEFAULT_SETTINGS, provider: 'google', model: 'x' })).toBe('google')
    expect(engineId({ ...DEFAULT_SETTINGS, provider: 'chrome-nano' })).toBe('chrome-nano')
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

  it('maps codes to and from Chrome built-in AI language tags', () => {
    expect(chromeAiLanguage('zh-CN')).toBe('zh')
    expect(chromeAiLanguage('zh-TW')).toBe('zh-Hant')
    expect(chromeAiLanguage('ja')).toBe('ja')
    expect(normalizeDetected('und')).toBeNull()
    expect(normalizeDetected('zh-CN')).toBe('zh')
    expect(normalizeDetected('zh-Hant')).toBe('zh-Hant')
    expect(normalizeDetected('pt-BR')).toBe('pt')
  })
})
