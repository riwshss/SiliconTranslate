import { describe, expect, it } from 'vitest'
import { canUseCloudAi, defaultEntitlement, describeQuota, effectiveModel, sanitizeEntitlement } from '../src/shared/entitlement'

describe('entitlement', () => {
  it('unlocks cloud AI by default in beta builds but not in stable builds', () => {
    expect(defaultEntitlement('beta')).toEqual({ plan: 'beta', features: ['cloud-ai'], models: ['deepseek/deepseek-v4-flash'], quota: null })
    expect(defaultEntitlement('stable')).toMatchObject({ features: [], models: [] })
  })

  it('gates the cloud engine on the cloud-ai feature', () => {
    expect(canUseCloudAi(defaultEntitlement('stable'))).toBe(false)
    expect(canUseCloudAi(defaultEntitlement('beta'))).toBe(true)
  })

  it('accepts a well-formed server answer and drops unknown features and models', () => {
    const quota = { used: 1200, limit: 200000, resetAt: '2026-10-18T00:00:00.000Z' }
    const raw = { plan: 'pro', features: ['cloud-ai', 'teleport'], models: ['openai/gpt-6-sol', 'x/unknown', 'deepseek/deepseek-v4-flash'], quota }
    expect(sanitizeEntitlement(raw)).toEqual({ plan: 'pro', features: ['cloud-ai'], models: ['deepseek/deepseek-v4-flash', 'openai/gpt-6-sol'], quota })
  })

  it('gives an answer without a model list (older backend) the plan defaults', () => {
    expect(sanitizeEntitlement({ plan: 'beta', features: ['cloud-ai'] })?.models).toEqual(['deepseek/deepseek-v4-flash'])
    expect(sanitizeEntitlement({ plan: 'pro', features: ['cloud-ai'] })?.models).toHaveLength(4)
  })

  it('picks the chosen model only when the plan allows it', () => {
    const beta = defaultEntitlement('beta')
    expect(effectiveModel(beta, 'openai/gpt-6-sol')).toBe('deepseek/deepseek-v4-flash')
    expect(effectiveModel(beta, 'deepseek/deepseek-v4-flash')).toBe('deepseek/deepseek-v4-flash')
    expect(effectiveModel({ ...beta, models: ['deepseek/deepseek-v4-flash', 'openai/gpt-6-sol'] }, 'openai/gpt-6-sol')).toBe('openai/gpt-6-sol')
    expect(effectiveModel(defaultEntitlement('stable'), 'deepseek/deepseek-v4-flash')).toBeNull()
  })

  it('rejects unknown plans and ignores a malformed quota', () => {
    expect(sanitizeEntitlement(null)).toBeNull()
    expect(sanitizeEntitlement({ plan: 'enterprise', features: [] })).toBeNull()
    expect(sanitizeEntitlement({ plan: 'beta', features: 'cloud-ai', models: [], quota: { used: 'x' } })).toEqual({ plan: 'beta', features: [], models: [], quota: null })
  })

  it('summarises quota compactly in the interface language', () => {
    expect(describeQuota({ used: 800, limit: 2_000_000, resetAt: '' }, 'zh-CN')).toBe('今日已用 800 / 200万 字')
    expect(describeQuota({ used: 12345, limit: 2_000_000, resetAt: '' }, 'zh-CN')).toBe('今日已用 1.2万 / 200万 字')
    expect(describeQuota({ used: 12345, limit: 2_000_000, resetAt: '' }, 'en')).toBe('Used today: 12.3K / 2M characters')
  })
})
