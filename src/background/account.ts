// Anonymous identity and entitlement for the Silk AI engine. The install id is a random UUID kept
// in local storage: it carries no personal data and only lets the backend count a daily quota.

import { ApiError } from '../core/errors'
import { canUseCloudAi, defaultEntitlement, sanitizeEntitlement, type Entitlement } from '../shared/entitlement'
import { CLOUD_API_URL, RELEASE_CHANNEL } from '../shared/service'
import { fetchWithRetry, type ApiConfig } from './api'

const INSTALL_KEY = 'installId'
const ENTITLEMENT_KEY = 'entitlement'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let installIdPromise: Promise<string> | null = null

export function getInstallId(): Promise<string> {
  installIdPromise ??= (async () => {
    const stored = (await chrome.storage.local.get(INSTALL_KEY))[INSTALL_KEY]
    if (typeof stored === 'string' && UUID_RE.test(stored)) return stored
    const id = crypto.randomUUID()
    await chrome.storage.local.set({ [INSTALL_KEY]: id })
    return id
  })().catch((err: unknown) => {
    installIdPromise = null
    throw err
  })
  return installIdPromise
}

/** `model` must be one of CLOUD_MODELS; the backend checks it against the same allowlist. */
export async function cloudApiConfig(model: string): Promise<ApiConfig> {
  return { baseUrl: `${CLOUD_API_URL}/v1`, model, headers: { 'X-Silk-Install': await getInstallId() } }
}

/** Last entitlement the backend reported, or the channel default before the first answer. */
export async function cachedEntitlement(): Promise<Entitlement> {
  const stored = (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY]
  return sanitizeEntitlement(stored) ?? defaultEntitlement(RELEASE_CHANNEL)
}

/** Asks the backend for the current plan and quota and caches the answer. */
export async function refreshEntitlement(signal?: AbortSignal): Promise<Entitlement> {
  const res = await fetchWithRetry(`${CLOUD_API_URL}/v1/entitlement`, { headers: { 'X-Silk-Install': await getInstallId() } }, signal)
  const body = (await res.json().catch(() => null)) as { success?: unknown; data?: unknown } | null
  const entitlement = body?.success === true ? sanitizeEntitlement(body.data) : null
  if (!entitlement) throw new ApiError('bad-response', 'badAccount')
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: entitlement })
  return entitlement
}

/** Fails fast when the cached plan lacks cloud AI; the backend still enforces it either way. */
export async function assertCanUse(): Promise<void> {
  if (!canUseCloudAi(await cachedEntitlement())) throw new ApiError('upgrade')
}
