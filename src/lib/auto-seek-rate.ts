/**
 * Pure rate-decision core for auto-seek (自动追帧), split out from the
 * DOM/GM-coupled orchestration in `auto-seek.ts` so the speed ladder and
 * the round-play guard can be unit-tested without a browser (see
 * `auto-seek-rate.test.ts`).
 */

// Speed ladders — `[delta, rate]` for speedup (delta = bufferLen - threshold)
// and `[absBufferLen, rate]` for slowdown (compared against bufferLen
// directly, no threshold offset). Field-tested values from c-basalt's
// `Bilibili直播自动追帧` userscript (greasyfork 439875). See `auto-seek.ts`.
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

// Top of the slowdown ladder: below this buffer level we actively slow
// playback to dodge a stall, irrespective of the user's target.
const SLOWDOWN_CEILING = SLOWDOWN_LADDER[SLOWDOWN_LADDER.length - 1][0]
// Width of the comfortable 1x band kept between the slowdown ceiling and the
// speedup floor. Without a gap the two bands meet and the controller can never
// rest at 1x.
const STABLE_DEAD_BAND = 0.2
/**
 * Lowest latency target that still yields a stable (non-oscillating)
 * controller. A target at/below the slowdown ceiling puts the speedup floor
 * inside the slowdown zone, collapsing the 1x dead-band so playbackRate
 * oscillates 0.6x ↔ 1.1x forever (slow → buffer grows → speed up → buffer
 * drains → slow…). Targets are floored to this so a real dead-band survives.
 * Exported so the settings UI advertises the same minimum it will honor.
 */
export const MIN_STABLE_THRESHOLD = SLOWDOWN_CEILING + STABLE_DEAD_BAND

/**
 * Decide the playbackRate to apply from the current buffer state. Returns
 * the target rate, or `null` to mean "make no decision — leave the
 * element's rate untouched and just reflect it in metrics".
 *
 * @param bufferLen  Seconds buffered ahead of `currentTime`.
 * @param threshold  Target buffered-ahead window (`autoSeekBufferThreshold`).
 * @param duration   `mediaElement.duration`. This is the live/recording
 *   discriminator: a genuine live stream reports a **non-finite** duration
 *   — `Infinity` on bilibili's native player, `NaN` on our mpegts.js
 *   audio-only pipeline before duration metadata arrives (which never
 *   happens for a live FLV). A **finite, positive** duration means the
 *   media is a recording: round-play / 轮播 (`live_status === 2`, streamer
 *   offline) or a replay — served as VOD that pre-buffers tens of seconds
 *   ahead. Such content has no live edge to chase, so we never speed up
 *   (and never slow down to dodge a stall the native VOD player handles
 *   itself) — we hold 1x.
 */
export function decidePlaybackRate(bufferLen: number, threshold: number, duration: number): number | null {
  // Recording / round-play guard: finite duration ⇒ not live ⇒ hold 1x.
  if (Number.isFinite(duration) && duration > 0) return 1

  if (!Number.isFinite(threshold) || threshold <= 0) return null

  // Floor the target above the slowdown ceiling so a comfortable 1x dead-band
  // always exists. A target at/below the ceiling makes the speedup band
  // (over > 0) overlap the slowdown band, leaving no buffer level that holds
  // 1x — the controller then oscillates 0.6x ↔ 1.1x indefinitely.
  const effectiveThreshold = Math.max(threshold, MIN_STABLE_THRESHOLD)

  // Slowdown takes priority: a draining buffer (imminent stall) is more
  // user-visible than a slightly over-target buffer (slightly higher
  // latency).
  for (const [bufThres, rate] of SLOWDOWN_LADDER) {
    if (bufferLen < bufThres) return rate
  }

  const over = bufferLen - effectiveThreshold
  for (const [delta, rate] of SPEEDUP_LADDER) {
    if (over > delta) return rate
  }

  // Comfortable zone — target normal speed.
  return 1
}
