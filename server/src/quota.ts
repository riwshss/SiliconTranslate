// Pure daily-quota math, shared by the Durable Object and the request handler.
// Usage is counted in characters of prompt text and resets at UTC midnight.

export interface QuotaState {
  day: string
  used: number
}

export interface QuotaResult {
  allowed: boolean
  used: number
  limit: number
  resetAt: string
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export function nextUtcMidnight(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next.toISOString()
}

/** Usage for `day`; a state left over from an earlier day counts as zero. */
export function usedToday(state: QuotaState | undefined, day: string): number {
  return state && state.day === day ? state.used : 0
}

/**
 * Try to spend `amount` against `limit`; a negative amount refunds and is always allowed (usage
 * never drops below zero). Returns the next state (unchanged when denied) plus the outcome;
 * never mutates the input.
 */
export function consume(
  state: QuotaState | undefined,
  amount: number,
  limit: number,
  now: Date,
): { next: QuotaState; result: QuotaResult } {
  const day = utcDay(now)
  const used = usedToday(state, day)
  const resetAt = nextUtcMidnight(now)
  if (amount > 0 && used + amount > limit) {
    return { next: { day, used }, result: { allowed: false, used, limit, resetAt } }
  }
  const nextUsed = Math.max(0, used + amount)
  return { next: { day, used: nextUsed }, result: { allowed: true, used: nextUsed, limit, resetAt } }
}
