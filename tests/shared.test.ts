import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compactNumber, errorText, MESSAGE_KEYS, resolveUiLang, translator } from '../src/shared/i18n'
import { CLOUD_MODELS, DEFAULT_SETTINGS, dropLegacySettings, engineId, MAX_CONCURRENCY, sanitizeSettings, withDomainRule } from '../src/shared/settings'
import { handleCommand, TOGGLE_COMMAND } from '../src/shared/tab-messaging'
import manifest from '../static/manifest.json'
import { chineseTargetFor, defaultTargetLang, getLanguage } from '../src/shared/languages'
import { contentScriptMatches, sitePattern } from '../src/shared/site-access'
import { sanitizeDevKey } from '../src/shared/dev-key'

describe('sanitizeSettings', () => {
  // The default target follows navigator.languages, which Node fills from the machine locale.
  beforeEach(() => vi.stubGlobal('navigator', { languages: ['en-US'] }))
  afterEach(() => vi.unstubAllGlobals())

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
      animateTranslations: false,
      selectionEnabled: false,
      domainRules: { 'example.com': 'always', 'bad host!': 'always', 'x.org': 'sometimes' },
    })
    expect(result).toEqual({
      model: 'openai/gpt-6-sol',
      uiLang: 'en',
      targetLang: 'ja',
      defaultMode: 'bilingual',
      bilingualStyle: 'highlight',
      animateTranslations: false,
      selectionEnabled: false,
      domainRules: { 'example.com': 'always' },
    })
  })

  it('gives new installs the silk bilingual style but keeps the style earlier installs chose', () => {
    expect(DEFAULT_SETTINGS.bilingualStyle).toBe('silk')
    expect(sanitizeSettings({}).bilingualStyle).toBe('silk')
    expect(sanitizeSettings({ bilingualStyle: 'dashed' }).bilingualStyle).toBe('dashed')
    expect(sanitizeSettings({ bilingualStyle: 'highlight' }).bilingualStyle).toBe('highlight')
    expect(sanitizeSettings({ bilingualStyle: 'neon' }).bilingualStyle).toBe('silk')
    expect(sanitizeSettings({}).animateTranslations).toBe(true)
    expect(sanitizeSettings({ animateTranslations: 'no' }).animateTranslations).toBe(true)
  })

  it('rejects unsafe or invalid values', () => {
    const result = sanitizeSettings({
      targetLang: 'xx',
      defaultMode: 'original',
      model: 'deepseek-ai/DeepSeek-V3',
      uiLang: 'fr',
    })
    expect(result.targetLang).toBe('zh-CN')
    expect(result.defaultMode).toBe('overlay')
    expect(result.model).toBe(DEFAULT_SETTINGS.model)
    expect(result.uiLang).toBe('auto')
  })

  it('defaults the target to the browser’s Chinese variant when none is stored', () => {
    vi.stubGlobal('navigator', { languages: ['zh-TW'] })
    expect(sanitizeSettings({}).targetLang).toBe('zh-TW')
    expect(sanitizeSettings({ targetLang: 'ja' }).targetLang).toBe('ja')
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
    const store: Record<string, unknown> = { settings: { provider: 'openai', apiKey: 'sk-1', shortcut: 'Alt+Y', targetLang: 'ja' } }
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
  it('is a browser command (works without site access), Alt+T by default', () => {
    expect(manifest.commands).toEqual({ [TOGGLE_COMMAND]: { suggested_key: { default: 'Alt+T' }, description: '__MSG_commandToggle__' } })
  })

  it('toggles the tab it was pressed in, injecting the content script where it is not running', async () => {
    let isInjected = false
    const sendMessage = vi.fn(async () => {
      if (!isInjected) throw new Error('Receiving end does not exist')
      return { mode: 'overlay' }
    })
    const executeScript = vi.fn(async () => {
      isInjected = true
    })
    vi.stubGlobal('chrome', { tabs: { sendMessage }, scripting: { executeScript } })
    await handleCommand(TOGGLE_COMMAND, { id: 7 } as chrome.tabs.Tab)
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, files: ['content.js'] })
    expect(sendMessage).toHaveBeenLastCalledWith(7, { type: 'silk:toggle' })
    await handleCommand(TOGGLE_COMMAND, { id: 7 } as chrome.tabs.Tab)
    expect(executeScript).toHaveBeenCalledTimes(1)
    await handleCommand('other-command', { id: 7 } as chrome.tabs.Tab)
    await handleCommand(TOGGLE_COMMAND, undefined)
    expect(sendMessage).toHaveBeenCalledTimes(3)
    vi.unstubAllGlobals()
  })

  it('drops the old in-page shortcut setting', () => {
    expect(sanitizeSettings({ shortcut: 'Ctrl+Shift+Y' })).toEqual(DEFAULT_SETTINGS)
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
    expect(resolveUiLang('auto', 'zh-CN')).toBe('zh-CN')
    expect(resolveUiLang('auto', 'zh')).toBe('zh-CN')
    expect(resolveUiLang('auto', 'zh-SG')).toBe('zh-CN')
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW']) expect(resolveUiLang('auto', tag)).toBe('zh-TW')
    expect(resolveUiLang('auto', 'zhx')).toBe('en')
    expect(resolveUiLang('auto', 'en-US')).toBe('en')
    expect(resolveUiLang('auto', 'ja')).toBe('en')
    expect(resolveUiLang('en', 'zh-CN')).toBe('en')
  })

  it('fills placeholders', () => {
    expect(translator('en')('pageTranslating', { done: 3, total: 9 })).toBe('Translating 3/9')
    expect(translator('zh-CN')('pageFailed', { n: 2 })).toBe('2 段失败')
    expect(translator('zh-TW')('pageFailed', { n: 2 })).toBe('2 段失敗')
  })

  it('writes the Traditional Chinese interface in Taiwan wording, not converted Simplified', () => {
    const zhTw = translator('zh-TW')
    expect(zhTw('appName')).toBe('絲譯')
    expect(errorText('zh-TW', 'bad-response', 'missedItems')).toBe('無法解讀模型回傳的內容：模型漏翻了部分段落')
    expect(compactNumber('zh-TW', 100000)).toBe('10萬')
    // Characters that only exist in Simplified Chinese, and Mainland terms Taiwan readers notice.
    const simplifiedOnly = /[译页网设语启键时间这线务据账号关闭显载连读户复认击态择]/
    const mainlandTerms = ['视频', '軟件', '默認', '設置', '信息', '界面', '用戶', '登錄', '鏈接', '質量', '網絡']
    for (const key of MESSAGE_KEYS) {
      const text = zhTw(key)
      expect(text, key).not.toMatch(simplifiedOnly)
      for (const term of mainlandTerms) expect(text, `${key}: ${term}`).not.toContain(term)
    }
  })

  it('picks the default target from the first Chinese variant among the browser languages', () => {
    expect(chineseTargetFor('zh-TW')).toBe('zh-TW')
    expect(chineseTargetFor('zh-Hant-HK')).toBe('zh-HK')
    expect(chineseTargetFor('zh-MO')).toBe('zh-HK')
    expect(chineseTargetFor('zh-Hant')).toBe('zh-TW')
    expect(chineseTargetFor('zh')).toBe('zh-CN')
    expect(chineseTargetFor('en-US')).toBeNull()
    expect(defaultTargetLang(['en-US', 'zh-TW', 'zh-CN'])).toBe('zh-TW')
    expect(defaultTargetLang(['zh-HK', 'en'])).toBe('zh-HK')
    expect(defaultTargetLang(['en-US', 'ja'])).toBe('zh-CN')
    expect(defaultTargetLang([])).toBe('zh-CN')
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

describe('developer key', () => {
  it('keeps a pasted key without the surrounding whitespace', () => {
    const key = 'Ab3-_+/='.repeat(5) + 'xyz'
    expect(sanitizeDevKey(`  ${key}\n`)).toBe(key)
  })

  it('rejects anything that cannot be a key or a safe header value', () => {
    expect(sanitizeDevKey('short')).toBeNull()
    expect(sanitizeDevKey('k'.repeat(257))).toBeNull()
    expect(sanitizeDevKey(`${'k'.repeat(40)}\r\nX-Evil: 1`)).toBeNull()
    expect(sanitizeDevKey(`${'k'.repeat(20)} ${'k'.repeat(20)}`)).toBeNull()
    expect(sanitizeDevKey(undefined)).toBeNull()
    expect(sanitizeDevKey(42)).toBeNull()
  })
})
