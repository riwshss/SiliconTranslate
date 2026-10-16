import { DurableObject } from 'cloudflare:workers'
import { consume, nextUtcMidnight, usedToday, utcDay, type QuotaResult, type QuotaState } from './quota'

const STATE_KEY = 'q'

/**
 * One instance per counter key (install id, client IP, or "global").
 * Durable Objects run requests for one key serially, so read-modify-write is atomic.
 */
export class QuotaCounter extends DurableObject {
  async consume(amount: number, limit: number): Promise<QuotaResult> {
    const state = await this.ctx.storage.get<QuotaState>(STATE_KEY)
    const { next, result } = consume(state, amount, limit, new Date())
    if (result.allowed) await this.ctx.storage.put(STATE_KEY, next)
    return result
  }

  async peek(limit: number): Promise<QuotaResult> {
    const now = new Date()
    const state = await this.ctx.storage.get<QuotaState>(STATE_KEY)
    const used = usedToday(state, utcDay(now))
    return { allowed: used < limit, used, limit, resetAt: nextUtcMidnight(now) }
  }
}
