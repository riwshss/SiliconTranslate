import { handleRequest, type Env as AppEnv, type MetricsSink, type PlanStore, type QuotaStore, type TranslationCache } from './app'
import { QuotaCounter } from './quota-do'

export { QuotaCounter }

interface Env extends AppEnv {
  readonly QUOTA: DurableObjectNamespace<QuotaCounter>
  /** Workers Analytics Engine; optional so local dev works without it. */
  readonly METRICS?: AnalyticsEngineDataset
  /** Paid plans (`plan:<id>` → plan name); not bound until paid plans launch. */
  readonly PLANS?: KVNamespace
}

/** Shared translations live for a week. */
const CACHE_TTL_SECONDS = 7 * 24 * 3600

function quotaStore(ns: DurableObjectNamespace<QuotaCounter>): QuotaStore {
  const stub = (key: string) => ns.get(ns.idFromName(key))
  return {
    consume: (key, amount, limit) => stub(key).consume(amount, limit),
    peek: (key, limit) => stub(key).peek(limit),
  }
}

/** The Cache API stores responses by URL; cache keys from app.ts are already URLs. */
function translationCache(): TranslationCache {
  const cache = caches.default
  return {
    async get(key) {
      const hit = await cache.match(key)
      return hit ? hit.text() : null
    },
    put: (key, text) =>
      cache.put(key, new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` } })),
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const metrics: MetricsSink | undefined = env.METRICS
    const plans: PlanStore | undefined = env.PLANS
    return handleRequest(request, env, {
      quota: quotaStore(env.QUOTA),
      fetch: (input, init) => fetch(input, init),
      waitUntil: (promise) => ctx.waitUntil(promise),
      cache: translationCache(),
      plans,
      metrics,
    })
  },
} satisfies ExportedHandler<Env>
