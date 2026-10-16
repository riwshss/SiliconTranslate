// Anonymous identity and entitlement for the Silk AI engine. The install token is issued and
// signed by the backend (POST /v1/install) and kept in local storage: it carries no personal data
// and only lets the backend count a daily quota per install.

import { ApiError } from '../core/errors'
import { defaultEntitlement, effectiveModel, ENTITLEMENT_KEY, sanitizeEntitlement, type Entitlement } from '../shared/entitlement'
import { CLOUD_API_URL, RELEASE_CHANNEL } from '../shared/service'
import { fetchWithRetry, type ApiConfig } from './api'

const TOKEN_KEY = 'installToken'
/** Unsigned random id kept by extension ≤ 2.2; dropped once a token is issued. */
const LEGACY_INSTALL_KEY = 'installId'
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i

let tokenPromise: Promise<string> | null = null

async function requestInstallToken(): Promise<string> {
  const res = await fetchWithRetry(`${CLOUD_API_URL}/v1/install`, { method: 'POST' })
  const body = (await res.json().catch(() => null)) as { success?: unknown; data?: { token?: unknown } } | null
  const token = body?.success === true ? body.data?.token : null
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new ApiError('bad-response', 'badAccount')
  return token
}

/** The install token, asked from the backend the first time it is needed. */
export function getInstallToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const stored = (await chrome.storage.local.get(TOKEN_KEY))[TOKEN_KEY]
    if (typeof stored === 'string' && TOKEN_RE.test(stored)) return stored
    const token = await requestInstallToken()
    await chrome.storage.local.set({ [TOKEN_KEY]: token })
    await chrome.storage.local.remove(LEGACY_INSTALL_KEY)
    return token
  })().catch((err: unknown) => {
    tokenPromise = null
    throw err
  })
  return tokenPromise
}

/** The backend no longer accepts the stored token (e.g. its key was rotated): get a new one next time. */
export async function forgetInstallToken(): Promise<void> {
  tokenPromise = null
  await chrome.storage.local.remove(TOKEN_KEY)
}

/** `model` must be one the plan allows (see usableModel); the backend checks it again. */
export async function cloudApiConfig(model: string): Promise<ApiConfig> {
  return { baseUrl: `${CLOUD_API_URL}/v1`, model, headers: { 'X-Silk-Install': await getInstallToken() } }
}

/** Last entitlement the backend reported, or the channel default before the first answer. */
export async function cachedEntitlement(): Promise<Entitlement> {
  const stored = (await chrome.storage.local.get(ENTITLEMENT_KEY))[ENTITLEMENT_KEY]
  return sanitizeEntitlement(stored) ?? defaultEntitlement(RELEASE_CHANNEL)
}

/** Asks the backend for the current plan and quota and caches the answer. */
export async function refreshEntitlement(signal?: AbortSignal): Promise<Entitlement> {
  const res = await fetchWithRetry(`${CLOUD_API_URL}/v1/entitlement`, { headers: { 'X-Silk-Install': await getInstallToken() } }, signal)
  const body = (await res.json().catch(() => null)) as { success?: unknown; data?: unknown } | null
  const entitlement = body?.success === true ? sanitizeEntitlement(body.data) : null
  if (!entitlement) throw new ApiError('bad-response', 'badAccount')
  await chrome.storage.local.set({ [ENTITLEMENT_KEY]: entitlement })
  return entitlement
}

/**
 * The model to call for the user's choice under the cached plan (a locked choice falls back to
 * the plan default). Fails fast when the plan has no cloud AI; the backend enforces both anyway.
 */
export async function usableModel(chosen: string): Promise<string> {
  const model = effectiveModel(await cachedEntitlement(), chosen)
  if (!model) throw new ApiError('upgrade')
  return model
}
