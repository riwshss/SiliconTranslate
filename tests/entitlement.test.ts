import { describe, expect, it } from 'vitest'
import { canUseCloudAi, defaultEntitlement, describeQuota, sanitizeEntitlement } from '../src/shared/entitlement'

describe('entitlement', () => {
  it('unlocks cloud AI by default in beta builds but not in stable builds', () => {
    expect(defaultEntitlement('beta')).toEqual({ plan: 'beta', features: ['cloud-ai'], quota: null })
    expect(defaultEntitlement('stable').features).toEqual([])
  })

  it('gates the cloud engine on the cloud-ai feature', () => {
    expect(canUseCloudAi(defaultEntitlement('stable'))).toBe(false)
    expect(canUseCloudAi(defaultEntitlement('beta'))).toBe(true)
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

  it('summarises quota compactly in the interface language', () => {
    expect(describeQuota({ used: 800, limit: 2_000_000, resetAt: '' }, 'zh-CN')).toBe('今日已用 800 / 200万 字')
    expect(describeQuota({ used: 12345, limit: 2_000_000, resetAt: '' }, 'zh-CN')).toBe('今日已用 1.2万 / 200万 字')
    expect(describeQuota({ used: 12345, limit: 2_000_000, resetAt: '' }, 'en')).toBe('Used today: 12.3K / 2M characters')
  })
})
