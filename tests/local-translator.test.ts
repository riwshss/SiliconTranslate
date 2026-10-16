// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalTranslator, pickPageEngine, toTranslatorLanguage } from '../src/content/local-translator'

let store: Record<string, unknown>
const created: string[] = []

beforeEach(() => {
  store = {}
  created.length = 0
  vi.stubGlobal('chrome', { storage: { local: { get: async (key: string) => (key in store ? { [key]: store[key] } : {}) } } })
})
afterEach(() => vi.unstubAllGlobals())

function stubTranslator(available = true) {
  vi.stubGlobal('Translator', {
    availability: async ({ sourceLanguage }: { sourceLanguage: string }) => (available && sourceLanguage !== 'xx' ? 'available' : 'unavailable'),
    create: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
      created.push(`${sourceLanguage}>${targetLanguage}`)
      return { translate: async (text: string) => `[${targetLanguage}] ${text}` }
    },
  })
}

describe('pickPageEngine', () => {
  it('uses cloud AI whenever the plan includes it', async () => {
    stubTranslator()
    store.entitlement = { plan: 'beta', features: ['cloud-ai'], models: [], quota: null }
    expect(await pickPageEngine()).toBe('cloud')
  })

  it('translates on device on plans without cloud AI, if the browser can', async () => {
    store.entitlement = { plan: 'free', features: [], models: [], quota: null }
    expect(await pickPageEngine()).toBe('cloud')
    stubTranslator()
    expect(await pickPageEngine()).toBe('local')
  })
})

describe('LocalTranslator', () => {
  it('maps language codes to the tags the Translator API expects', () => {
    expect(toTranslatorLanguage('zh-CN')).toBe('zh')
    expect(toTranslatorLanguage('zh-TW')).toBe('zh-Hant')
    expect(toTranslatorLanguage('ja')).toBe('ja')
  })

  it('translates the plain text of the markup, reusing one translator per language pair', async () => {
    stubTranslator()
    document.documentElement.lang = 'en-US'
    const local = new LocalTranslator('zh-CN')
    expect(await local.translate('Click <g0>here</g0> &amp; go')).toBe('[zh] Click here & go')
    await local.translate('Again')
    expect(created).toEqual(['en-US>zh'])
  })

  it('returns text already in the target language as is, and null for pairs it cannot do', async () => {
    stubTranslator()
    document.documentElement.lang = 'zh-CN'
    expect(await new LocalTranslator('zh-CN').translate('你好')).toBe('你好')
    expect(await new LocalTranslator('zh-TW').translate('你好')).toBe('[zh-Hant] 你好')
    document.documentElement.lang = 'xx'
    expect(await new LocalTranslator('ja').translate('abc')).toBeNull()
  })
})
