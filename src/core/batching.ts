/** Hard ceilings per request: bounded prompt size and a reply that streams back quickly. */
export const MAX_BATCH_ITEMS = 12
export const MAX_BATCH_CHARS = 1800
/**
 * Below this, the fixed system prompt outweighs the text, so splitting further costs more quota
 * than the extra parallelism saves.
 */
export const MIN_BATCH_CHARS = 400

/**
 * Splits `keys` (in order) into batches that can run side by side on `slots` connections.
 * Reply time grows with reply length, so a screenful spread over all slots finishes several
 * times sooner than the same text in one or two big requests. Each batch is filled up to an
 * even share of the total (between MIN_BATCH_CHARS and MAX_BATCH_CHARS), which yields at most
 * `slots` batches unless the ceilings force more.
 */
export function splitBatches(keys: readonly string[], slots: number): string[][] {
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
