import { handleRequest, type Env as AppEnv, type QuotaStore } from './app'
import { QuotaCounter } from './quota-do'

export { QuotaCounter }

interface Env extends AppEnv {
  readonly QUOTA: DurableObjectNamespace<QuotaCounter>
}

function quotaStore(ns: DurableObjectNamespace<QuotaCounter>): QuotaStore {
  const stub = (key: string) => ns.get(ns.idFromName(key))
  return {
    consume: (key, amount, limit) => stub(key).consume(amount, limit),
    peek: (key, limit) => stub(key).peek(limit),
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, { quota: quotaStore(env.QUOTA), fetch: (input, init) => fetch(input, init) })
  },
} satisfies ExportedHandler<Env>
