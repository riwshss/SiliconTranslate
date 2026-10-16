import { describe, expect, it } from 'vitest'
import manifest from '../static/manifest.json'
import en from '../static/_locales/en/messages.json'
import zhCN from '../static/_locales/zh_CN/messages.json'
import zhTW from '../static/_locales/zh_TW/messages.json'

const locales: Record<string, Record<string, { message: string }>> = { en, zh_CN: zhCN, zh_TW: zhTW }

describe('store name and description (_locales)', () => {
  it('defines every message the manifest (and the beta build) uses, in every locale', () => {
    const used = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(([, key]) => key)
    expect(used).toContain('appName')
    expect(manifest.default_locale).toBe('en')
    for (const [locale, messages] of Object.entries(locales)) {
      for (const key of [...used, 'appNameBeta']) expect(messages[key]?.message, `${locale}.${key}`).toBeTruthy()
    }
  })

  it('stays within Chrome limits and names the brand per language', () => {
    for (const messages of Object.values(locales)) {
      expect(messages.appName.message.length).toBeLessThanOrEqual(75)
      expect(messages.appNameBeta.message.length).toBeLessThanOrEqual(75)
      expect(messages.appShortName.message.length).toBeLessThanOrEqual(12)
      expect(messages.appDescription.message.length).toBeLessThanOrEqual(132)
      // Models that are locked during the beta must not be advertised.
      expect(messages.appDescription.message).not.toMatch(/Claude|GPT|Gemini/)
    }
    expect(zhTW.appName.message).toContain('絲譯')
    expect(zhCN.appName.message).toContain('丝译')
  })
})
