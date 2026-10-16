/** Hard ceilings per request: bounded prompt size and a reply that streams back quickly. */
export const MAX_BATCH_ITEMS = 12
export const MAX_BATCH_CHARS = 1800
/**
 * Below this, splitting further mostly adds per-request overhead (round trip, model start-up)
 * for little extra parallelism. The fixed system prompt costs no quota and is served from the
 * provider's prompt cache, so this can stay small.
 */
export const MIN_BATCH_CHARS = 150
/** The first batch on screen is kept tiny so the first translation shows up as early as possible. */
export const FIRST_BATCH_ITEMS = 3
export const FIRST_BATCH_CHARS = 300

/**
 * Splits `keys` (in order) into batches that can run side by side on `slots` connections.
 * Reply time grows with reply length, so a screenful spread over all slots finishes several
 * times sooner than the same text in one or two big requests. Each batch is filled up to an
 * even share of the total (between MIN_BATCH_CHARS and MAX_BATCH_CHARS), which yields at most
 * `slots` batches unless the ceilings force more.
 *
 * With `isFirstSmall`, the first batch holds at most FIRST_BATCH_ITEMS keys and FIRST_BATCH_CHARS
 * characters (but always at least one key), and the rest is spread over the remaining slots.
 */
export function splitBatches(keys: readonly string[], slots: number, isFirstSmall = false): string[][] {
  if (isFirstSmall && keys.length) {
    let count = 1
    let chars = keys[0].length
    while (count < Math.min(FIRST_BATCH_ITEMS, keys.length) && chars + keys[count].length <= FIRST_BATCH_CHARS) chars += keys[count++].length
    return [keys.slice(0, count), ...splitBatches(keys.slice(count), Math.max(1, slots - 1))]
  }
  const total = keys.reduce((sum, key) => sum + key.length, 0)
  const share = Math.min(MAX_BATCH_CHARS, Math.max(MIN_BATCH_CHARS, Math.ceil(total / Math.max(1, slots))))
  const batches: string[][] = []
  let batch: string[] = []
  let chars = 0
  for (const key of keys) {
    const isFull = batch.length >= MAX_BATCH_ITEMS || chars >= share || chars + key.length > MAX_BATCH_CHARS
    if (batch.length && isFull) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(key)
    chars += key.length
  }
  if (batch.length) batches.push(batch)
  return batches
}
