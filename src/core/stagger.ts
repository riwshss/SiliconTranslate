/** Delay between translations revealed in the same burst (docs/DESIGN.md §6 "譯文浮現"). */
export const REVEAL_STAGGER_MS = 30
/** After this many steps the delay stops growing, so a big batch never lags behind. */
export const REVEAL_MAX_STEPS = 10
/** Reveals closer together than this belong to the same burst. */
const BURST_GAP_MS = 120

/**
 * Returns a function that gives each reveal its start delay: 0 for the first of a burst, then
 * 30 ms more for each following one, capped at 10 steps (300 ms).
 */
export function createStagger(now: () => number = () => performance.now()): () => number {
  let last = Number.NEGATIVE_INFINITY
  let step = 0
  return () => {
    const time = now()
    step = time - last < BURST_GAP_MS ? Math.min(step + 1, REVEAL_MAX_STEPS) : 0
    last = time
    return step * REVEAL_STAGGER_MS
  }
}
