/**
 * Defends `computeJitteredSleepMs` against the boundary failures called out in
 * the QA audit (A2):
 *   - jitter pushing below zero ⇒ setTimeout fires synchronously, turning the
 *     auto-loop into a tight spin.
 *   - corrupted GM storage / hand-edited backup leaves `msgSendInterval` as
 *     NaN/Infinity/non-positive ⇒ `interval * 1000` propagates the bad value
 *     into `abortableSleep`.
 *
 * Also pins the Gaussian-jitter math (cherry-pick from
 * laplace-live/chatterbox@760fb31): σ = 10% of baseMs, ±2σ clamp, Box-Muller
 * sampling. Detector defeat depends on the distribution shape, not on the
 * fact that we randomize at all — so we lock the formula here.
 *
 * The helper is pure and side-effect-free, so we can test it directly without
 * spinning up the full loop module.
 */

import { describe, expect, test } from 'bun:test'

// Imported from `loop-utils` (not `loop.ts`) so this test stays free of the
// heavy transitive graph (api.ts, send-queue.ts, wbi.ts IIFE, etc.) and
// doesn't depend on which `mock.module('$', ...)` happens to be active.
import { computeJitteredSleepMs } from '../src/lib/loop-utils'

describe('computeJitteredSleepMs', () => {
  test('returns intervalSec*1000 when jitter is disabled', () => {
    expect(computeJitteredSleepMs(1, false)).toBe(1000)
    expect(computeJitteredSleepMs(0.5, false)).toBe(500)
  })

  test('with jitter, result stays within ±2σ (±20% of baseMs)', () => {
    // 200 trials at baseMs=4000: every result must land in [3200, 4800]
    // (sample is clamped to [-2, +2] before being multiplied by sigmaMs=400).
    // Allow ±1ms slack for `Math.round`.
    const interval = 2
    const baseMs = interval * 1000
    const lo = Math.floor(baseMs * 0.8) - 1
    const hi = Math.ceil(baseMs * 1.2) + 1
    for (let i = 0; i < 200; i++) {
      const ms = computeJitteredSleepMs(interval, true)
      expect(ms).toBeGreaterThanOrEqual(lo)
      expect(ms).toBeLessThanOrEqual(hi)
    }
  })

  test('jitter is bell-shaped (most samples cluster near baseMs)', () => {
    // With σ=10% of baseMs, ~68% of unclamped samples land within ±1σ. The
    // ±2σ clamp barely changes that — true rate stays close to 68%. Allow
    // generous margin for sample noise: assert >50% of 500 trials are
    // within [baseMs - σ, baseMs + σ]. A uniform implementation (the
    // legacy ±500ms on baseMs=4000) would land ~25% in that band, so this
    // test catches a regression to uniform.
    const interval = 2
    const baseMs = interval * 1000
    const sigmaMs = baseMs * 0.1
    let within1Sigma = 0
    for (let i = 0; i < 500; i++) {
      const ms = computeJitteredSleepMs(interval, true)
      if (ms >= baseMs - sigmaMs && ms <= baseMs + sigmaMs) within1Sigma++
    }
    expect(within1Sigma).toBeGreaterThan(250)
  })

  test('result is always non-negative (defensive floor)', () => {
    // The ±20% clamp on valid baseMs ≥ 1000 (corruption fallback) means the
    // negative path can't actually reach ≤ 0 — but `Math.max(0, …)` stays
    // as a backstop for the future-proofing case where SEND_JITTER_SIGMA
    // gets bumped past 1.0. Lock the non-negative contract.
    for (let i = 0; i < 100; i++) {
      expect(computeJitteredSleepMs(0.1, true)).toBeGreaterThanOrEqual(0)
    }
  })

  test('falls back to a 1s floor when intervalSec is non-finite or non-positive', () => {
    // These are the four ways a corrupted gmSignal could land here.
    expect(computeJitteredSleepMs(Number.NaN, false)).toBe(1000)
    expect(computeJitteredSleepMs(Number.POSITIVE_INFINITY, false)).toBe(1000)
    expect(computeJitteredSleepMs(-5, false)).toBe(1000)
    expect(computeJitteredSleepMs(0, false)).toBe(1000)
  })

  test('with deterministic random=0.5, Gaussian sample matches Box-Muller (locks formula)', () => {
    // Mutation-test trap: catches typos in the Box-Muller math. With
    // Math.random returning 0.5 for both u1 and u2:
    //   sample = sqrt(-2 * ln(0.5)) * cos(π) = sqrt(2 * ln 2) * (-1) ≈ -1.17741
    // Within ±2σ clamp, so no clamping kicks in. baseMs=1000, σ=100:
    //   result = round(1000 + (-1.17741) * 100) = 882
    const realRandom = Math.random
    Math.random = () => 0.5
    try {
      const sample = Math.sqrt(-2 * Math.log(0.5)) * Math.cos(2 * Math.PI * 0.5)
      const expected = Math.round(1000 + sample * 100)
      expect(computeJitteredSleepMs(1, true)).toBe(expected)
    } finally {
      Math.random = realRandom
    }
  })

  test('extreme random triggers ±2σ clamp (locks the clamp range)', () => {
    // Math.random()=0 makes u1 fall through the `|| 1e-9` guard, producing
    // sample = sqrt(-2 * ln(1e-9)) * cos(0) ≈ sqrt(41.4) ≈ 6.43 — well past
    // the +2 clamp. Without the clamp, the result would be 1000 + 643 = 1643;
    // with the clamp it caps at 1000 + 2*100 = 1200.
    const realRandom = Math.random
    Math.random = () => 0
    try {
      expect(computeJitteredSleepMs(1, true)).toBe(1200)
    } finally {
      Math.random = realRandom
    }
  })

  test('never returns NaN or non-finite values regardless of jitter flag', () => {
    const inputs: Array<[number, boolean]> = [
      [Number.NaN, true],
      [Number.NaN, false],
      [Number.POSITIVE_INFINITY, true],
      [Number.NEGATIVE_INFINITY, true],
      [-1, true],
      [0, true],
      [0.05, true],
    ]
    for (const [interval, jitter] of inputs) {
      const ms = computeJitteredSleepMs(interval, jitter)
      expect(Number.isFinite(ms)).toBe(true)
      expect(ms).toBeGreaterThanOrEqual(0)
    }
  })
})
