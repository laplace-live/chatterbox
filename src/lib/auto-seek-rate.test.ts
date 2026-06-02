import { describe, expect, test } from 'bun:test'

import { decidePlaybackRate } from './auto-seek-rate'

/**
 * Regression focus: when the streamer is offline and bilibili plays a
 * recording (round-play / 轮播, `live_status === 2`), the `<video>` is a
 * finite-duration VOD that pre-buffers ~20s ahead. The speed ladder must
 * NOT treat that prebuffer as live latency — otherwise it pins playbackRate
 * at 1.3x for the entire recording. A genuine live stream reports a
 * non-finite duration (Infinity on the native player, NaN on mpegts.js
 * before duration metadata) and must still be chased as before.
 */

// The script's default buffered-ahead target, in seconds.
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

  // Same ladder must apply whether the live stream is the native player
  // (duration === Infinity) or our mpegts.js audio-only pipeline before
  // duration metadata arrives (duration === NaN).
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
})
