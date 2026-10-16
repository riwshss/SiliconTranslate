import { describe, expect, it } from 'vitest'
import { canUseProvider, defaultEntitlement, describeQuota, requiredFeature, sanitizeEntitlement } from '../src/shared/entitlement'

describe('entitlement', () => {
  it('unlocks cloud AI by default in beta builds but not in stable builds', () => {
    expect(defaultEntitlement('beta')).toEqual({ plan: 'beta', features: ['cloud-ai'], quota: null })
    expect(defaultEntitlement('stable').features).toEqual([])
  })

  it('gates only the paid cloud engine; engines on the user own key or device stay free', () => {
    const free = defaultEntitlement('stable')
    expect(requiredFeature('cloud')).toBe('cloud-ai')
    expect(canUseProvider(free, 'cloud')).toBe(false)
    expect(canUseProvider(defaultEntitlement('beta'), 'cloud')).toBe(true)
    for (const provider of ['openai', 'google', 'chrome-translator', 'chrome-nano'] as const) {
      expect(canUseProvider(free, provider)).toBe(true)
    }
  })

  it('accepts a well-formed server answer and drops unknown features', () => {
    const quota = { used: 1200, limit: 200000, resetAt: '2026-10-18T00:00:00.000Z' }
    expect(sanitizeEntitlement({ plan: 'pro', features: ['cloud-ai', 'teleport'], quota })).toEqual({ plan: 'pro', features: ['cloud-ai'], quota })
  })

  it('rejects unknown plans and ignores a malformed quota', () => {
    expect(sanitizeEntitlement(null)).toBeNull()
    expect(sanitizeEntitlement({ plan: 'enterprise', features: [] })).toBeNull()
    expect(sanitizeEntitlement({ plan: 'beta', features: 'cloud-ai', quota: { used: 'x' } })).toEqual({ plan: 'beta', features: [], quota: null })
  })

  it('summarises quota in 万 above ten thousand characters', () => {
    expect(describeQuota({ used: 800, limit: 200000, resetAt: '' })).toBe('今日已用 800 / 20 万字')
    expect(describeQuota({ used: 12345, limit: 200000, resetAt: '' })).toBe('今日已用 1.2 万 / 20 万字')
  })
})
