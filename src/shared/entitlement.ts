// What the current install may use. The backend is the authority (it enforces quotas and, later,
// paid plans); the client copy only drives the UI and fails fast before a doomed request.

import { compactNumber, translator, type MessageKey, type UiLang } from './i18n'
import type { ReleaseChannel } from './service'
import { CLOUD_MODELS } from './settings'

export type Plan = 'beta' | 'free' | 'pro'
/** Features that cost money to serve. */
export type Feature = 'cloud-ai'

export interface Quota {
  readonly used: number
  readonly limit: number
  readonly resetAt: string
}

export interface Entitlement {
  readonly plan: Plan
  readonly features: readonly Feature[]
  /** CLOUD_MODELS ids the plan may use, in CLOUD_MODELS order; the first is the plan default. */
  readonly models: readonly string[]
  readonly quota: Quota | null
}

/** chrome.storage.local key of the last entitlement the backend reported. */
export const ENTITLEMENT_KEY = 'entitlement'

const PLANS: readonly Plan[] = ['beta', 'free', 'pro']
const FEATURES: readonly Feature[] = ['cloud-ai']
const MODEL_IDS = CLOUD_MODELS.map((m) => m.id)

/** Mirrors server/src/app.ts PLAN_MODELS; used until the backend says otherwise. */
const PLAN_MODELS: Record<Plan, readonly string[]> = { beta: [MODEL_IDS[0]], free: [], pro: MODEL_IDS }

export const PLAN_LABELS: Record<Plan, MessageKey> = {
  beta: 'planBeta',
  free: 'planFree',
  pro: 'planPro',
}

/** Used until the backend has answered: beta builds unlock everything, stable builds start free. */
export function defaultEntitlement(channel: ReleaseChannel): Entitlement {
  return channel === 'beta'
    ? { plan: 'beta', features: ['cloud-ai'], models: PLAN_MODELS.beta, quota: null }
    : { plan: 'free', features: [], models: PLAN_MODELS.free, quota: null }
}

export function canUseCloudAi(entitlement: Entitlement): boolean {
  return entitlement.features.includes('cloud-ai')
}

/** The model to call: the chosen one when the plan allows it, else the plan default; null without any. */
export function effectiveModel(entitlement: Entitlement, chosen: string): string | null {
  if (!canUseCloudAi(entitlement)) return null
  return entitlement.models.includes(chosen) ? chosen : (entitlement.models[0] ?? null)
}

function toQuota(raw: unknown): Quota | null {
  if (!raw || typeof raw !== 'object') return null
  const { used, limit, resetAt } = raw as Record<string, unknown>
  const isValid = Number.isFinite(used) && Number.isFinite(limit) && typeof resetAt === 'string' && !Number.isNaN(Date.parse(resetAt))
  return isValid ? { used: used as number, limit: limit as number, resetAt: resetAt as string } : null
}

/**
 * Server data is external input: null unless it has a known plan. Unknown features and models are
 * dropped; an answer without a model list (older backend) gets the plan's default list.
 */
export function sanitizeEntitlement(raw: unknown): Entitlement | null {
  if (!raw || typeof raw !== 'object') return null
  const src = raw as Record<string, unknown>
  if (!PLANS.includes(src.plan as Plan)) return null
  const features = Array.isArray(src.features) ? FEATURES.filter((f) => (src.features as unknown[]).includes(f)) : []
  const models = Array.isArray(src.models) ? MODEL_IDS.filter((id) => (src.models as unknown[]).includes(id)) : PLAN_MODELS[src.plan as Plan]
  return { plan: src.plan as Plan, features, models, quota: toQuota(src.quota) }
}

/** "今日已用 1.2万 / 200万 字" / "Used today: 12K / 2M characters" summary for the popup. */
export function describeQuota(quota: Quota, lang: UiLang): string {
  return translator(lang)('quotaToday', { used: compactNumber(lang, quota.used), limit: compactNumber(lang, quota.limit) })
}
