/** Pure rate-decision core for auto-seek (自动追帧), unit-testable without a browser. */

// Speedup `[delta, rate]` (delta = bufferLen - threshold); slowdown `[absBufferLen, rate]` (compared to bufferLen directly, no offset).
const SPEEDUP_LADDER: ReadonlyArray<readonly [number, number]> = [
  [2, 1.3],
  [1, 1.2],
  [0, 1.1],
]
const SLOWDOWN_LADDER: ReadonlyArray<readonly [number, number]> = [
  [0.2, 0.1],
  [0.3, 0.3],
  [0.6, 0.6],
]

// Below this buffer level we slow playback to dodge a stall, regardless of target.
const SLOWDOWN_CEILING = SLOWDOWN_LADDER[SLOWDOWN_LADDER.length - 1][0]
// 1x band between slowdown ceiling and speedup floor; without a gap the controller can never rest at 1x.
const STABLE_DEAD_BAND = 0.2
/** Lowest target that keeps a 1x dead-band; below it the speedup floor enters the slowdown zone and rate oscillates 0.6x ↔ 1.1x forever. */
export const MIN_STABLE_THRESHOLD = SLOWDOWN_CEILING + STABLE_DEAD_BAND

/**
 * Decide the playbackRate from current buffer state; `null` means make no decision (leave rate untouched, just reflect in metrics).
 *
 * @param bufferLen  Seconds buffered ahead of `currentTime`.
 * @param threshold  Target buffered-ahead window (`autoSeekBufferThreshold`).
 * @param duration   `mediaElement.duration`, the live/recording discriminator: non-finite (Infinity or NaN) ⇒ live; finite positive ⇒ recording/轮播/replay (VOD, no live edge) so we hold 1x.
 */
export function decidePlaybackRate(bufferLen: number, threshold: number, duration: number): number | null {
  // Recording / round-play guard: finite duration ⇒ not live ⇒ hold 1x.
  if (Number.isFinite(duration) && duration > 0) return 1

  if (!Number.isFinite(threshold) || threshold <= 0) return null

  // Floor above the slowdown ceiling so a 1x dead-band survives (see MIN_STABLE_THRESHOLD).
  const effectiveThreshold = Math.max(threshold, MIN_STABLE_THRESHOLD)

  // Slowdown first: an imminent stall is more user-visible than slightly-high latency.
  for (const [bufThres, rate] of SLOWDOWN_LADDER) {
    if (bufferLen < bufThres) return rate
  }

  const over = bufferLen - effectiveThreshold
  for (const [delta, rate] of SPEEDUP_LADDER) {
    if (over > delta) return rate
  }

  return 1
}
