/**
 * Pure helpers for the auto-send loop.
 *
 * Kept in a separate file so unit tests can import them without dragging in
 * the full `loop.ts` graph (which transitively loads api.ts, send-queue.ts,
 * wbi.ts, etc., and installs the WBI XHR hijack at module load).
 */

/**
 * Sigma (1σ) of the send-interval jitter, expressed as a fraction of the
 * base interval. 0.10 means ~68% of delays fall within ±10% of the user's
 * configured interval, and ~95% within ±20% (samples are clamped to ±2σ
 * to bound the worst case so a freak Gaussian draw can't blow the cadence
 * apart at small intervals).
 *
 * Why Gaussian instead of the legacy uniform 0–500ms one-sided subtract:
 * uniform "randomness" over a tight window is itself a fingerprint —
 * detectors see a flat histogram and flag it. Human cadence is bell-shaped
 * around a target interval, so Gaussian jitter looks like a real user.
 *
 * Cherry-picked from laplace-live/chatterbox@760fb31.
 */
const SEND_JITTER_SIGMA = 0.1

/**
 * Sample one value from a standard normal distribution (mean 0, variance 1)
 * via the Box-Muller transform. Only the cosine half is taken; the sine
 * half is discarded since we need a single sample per call. `u1 || 1e-9`
 * guards against the rare-but-possible `Math.random() === 0` (which would
 * otherwise produce `log(0) = -Infinity` and propagate NaN downstream).
 */
function sampleStandardNormal(): number {
  const u1 = Math.random() || 1e-9
  const u2 = Math.random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Compute the per-iteration sleep in ms, with optional Gaussian jitter.
 *
 * Without jitter: returns `intervalSec * 1000` exactly.
 * With jitter: adds a bell-curve offset with σ = `SEND_JITTER_SIGMA * baseMs`,
 * clamped to ±2σ. Most delays cluster tightly around the user's configured
 * interval with rare ±20% outliers — closer to human cadence than uniform.
 *
 * Defensive against:
 * - non-finite or non-positive `intervalSec` (corrupted GM storage / bad
 *   backup): falls back to a 1s floor.
 * - jitter pushing past zero: result is clamped to ≥ 0 so a `setTimeout`
 *   never receives a negative number (which would fire on the next tick
 *   and turn the auto-loop into a tight spin). With the ±2σ clamp at
 *   ±20% of baseMs and the 1s floor on baseMs, this is purely defensive
 *   for valid inputs but matters for the corrupted-storage fallback path.
 */
export function computeJitteredSleepMs(intervalSec: number, withJitter: boolean): number {
  const safeInterval = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 1
  const baseMs = safeInterval * 1000
  if (!withJitter) return baseMs
  const sigmaMs = baseMs * SEND_JITTER_SIGMA
  const clampedSample = Math.max(-2, Math.min(2, sampleStandardNormal()))
  return Math.max(0, Math.round(baseMs + clampedSample * sigmaMs))
}
