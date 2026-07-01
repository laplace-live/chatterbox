import { describe, expect, test } from 'bun:test'

import { decidePlaybackRate } from './auto-seek-rate'

/**
 * Regression: a finite-duration recording (round-play, `live_status === 2`) pre-buffers ~20s
 * ahead and must NOT be chased (else pinned at 1.3x); genuine live reports non-finite duration
 * (Infinity native, NaN on mpegts.js before metadata) and must be.
 */

// Default buffered-ahead target, seconds.
const T = 1.7

describe('decidePlaybackRate', () => {
  describe('finite-duration recording (round-play / replay) holds 1x', () => {
    test.each([
      { label: '~22s prebuffer (the bug — was 1.3x)', bufferLen: 22, duration: 7219.29 },
      { label: 'comfortable buffer', bufferLen: 1.8, duration: 600 },
      { label: 'draining buffer (no slowdown either)', bufferLen: 0.1, duration: 600 },
    ])('$label', ({ bufferLen, duration }) => {
      expect(decidePlaybackRate(bufferLen, T, duration)).toBe(1)
    })
  })

  // Live duration is Infinity (native player) or NaN (mpegts.js before metadata); same ladder.
  describe.each([
    { kind: 'native player (duration=Infinity)', duration: Number.POSITIVE_INFINITY },
    { kind: 'audio-only mpegts.js (duration=NaN)', duration: Number.NaN },
  ])('genuine live — $kind runs the catch-up ladder', ({ duration }) => {
    test.each([
      { label: 'slowdown: draining 0.15s → 0.1x', bufferLen: 0.15, expected: 0.1 },
      { label: 'slowdown: draining 0.25s → 0.3x', bufferLen: 0.25, expected: 0.3 },
      { label: 'slowdown: draining 0.5s → 0.6x', bufferLen: 0.5, expected: 0.6 },
      { label: 'comfortable: exactly at threshold → 1x', bufferLen: T, expected: 1 },
      { label: 'speedup: 0.5s over threshold → 1.1x', bufferLen: T + 0.5, expected: 1.1 },
      { label: 'speedup: 1.5s over threshold → 1.2x', bufferLen: T + 1.5, expected: 1.2 },
      { label: 'speedup: 2.01s over threshold → 1.3x', bufferLen: T + 2.01, expected: 1.3 },
      { label: 'speedup: 22s buffer → 1.3x', bufferLen: 22, expected: 1.3 },
    ])('$label', ({ bufferLen, expected }) => {
      expect(decidePlaybackRate(bufferLen, T, duration)).toBe(expected)
    })
  })

  describe('misconfigured threshold on live → no decision (null)', () => {
    test.each([
      { label: 'threshold 0', threshold: 0 },
      { label: 'threshold negative', threshold: -1 },
      { label: 'threshold NaN', threshold: Number.NaN },
    ])('$label', ({ threshold }) => {
      expect(decidePlaybackRate(5, threshold, Number.POSITIVE_INFINITY)).toBeNull()
    })
  })

  // Regression: with target ≤ the 0.6s slowdown ceiling the speedup band overlaps slowdown,
  // leaving no 1x level so playbackRate flaps 0.6x ↔ 1.1x; a 1x dead-band above the ceiling fixes it.
  describe('low latency target keeps a stable 1x dead-band (no oscillation)', () => {
    test.each([
      { label: 'just above slowdown ceiling holds 1x (was 1.1x → oscillated)', bufferLen: 0.65 },
      { label: '0.7s buffer holds 1x', bufferLen: 0.7 },
      { label: '0.8s buffer holds 1x', bufferLen: 0.8 },
    ])('target 0.4s: $label', ({ bufferLen }) => {
      expect(decidePlaybackRate(bufferLen, 0.4, Number.POSITIVE_INFINITY)).toBe(1)
    })

    test('still slows a genuinely draining buffer (stall avoidance intact)', () => {
      expect(decidePlaybackRate(0.5, 0.4, Number.POSITIVE_INFINITY)).toBe(0.6)
    })
  })
})
