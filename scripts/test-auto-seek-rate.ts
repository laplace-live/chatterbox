import { decidePlaybackRate } from '../src/lib/auto-seek-rate.ts'

/**
 * Unit test for the auto-seek (自动追帧) rate-decision logic.
 *
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

interface Case {
  name: string
  bufferLen: number
  threshold: number
  duration: number
  expected: number | null
}

const cases: Case[] = [
  // === The bug: finite-duration recording must never speed up ===========
  {
    name: 'round-play recording, ~22s prebuffer → 1x (THE BUG)',
    bufferLen: 22,
    threshold: T,
    duration: 7219.29,
    expected: 1,
  },
  { name: 'round-play recording, comfortable buffer → 1x', bufferLen: 1.8, threshold: T, duration: 600, expected: 1 },
  {
    name: 'round-play recording, draining buffer → still 1x (no slowdown)',
    bufferLen: 0.1,
    threshold: T,
    duration: 600,
    expected: 1,
  },

  // === Genuine live, native player: duration === Infinity ===============
  {
    name: 'live (Infinity), 22s buffer → chase at 1.3x',
    bufferLen: 22,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 1.3,
  },
  {
    name: 'live (Infinity), 2.01s over threshold → 1.3x',
    bufferLen: T + 2.01,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 1.3,
  },
  {
    name: 'live (Infinity), 1.5s over threshold → 1.2x',
    bufferLen: T + 1.5,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 1.2,
  },
  {
    name: 'live (Infinity), 0.5s over threshold → 1.1x',
    bufferLen: T + 0.5,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 1.1,
  },
  {
    name: 'live (Infinity), exactly at threshold → 1x',
    bufferLen: T,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 1,
  },
  {
    name: 'live (Infinity), draining 0.15s → slow to 0.1x',
    bufferLen: 0.15,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 0.1,
  },
  {
    name: 'live (Infinity), draining 0.25s → slow to 0.3x',
    bufferLen: 0.25,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 0.3,
  },
  {
    name: 'live (Infinity), draining 0.5s → slow to 0.6x',
    bufferLen: 0.5,
    threshold: T,
    duration: Number.POSITIVE_INFINITY,
    expected: 0.6,
  },

  // === Genuine live, audio-only via mpegts.js: duration === NaN =========
  {
    name: 'live (NaN, audio-only), 22s buffer → chase at 1.3x',
    bufferLen: 22,
    threshold: T,
    duration: Number.NaN,
    expected: 1.3,
  },

  // === Misconfigured threshold on live → no decision (null) =============
  {
    name: 'invalid threshold 0 on live → null',
    bufferLen: 5,
    threshold: 0,
    duration: Number.POSITIVE_INFINITY,
    expected: null,
  },
  {
    name: 'invalid threshold NaN on live → null',
    bufferLen: 5,
    threshold: Number.NaN,
    duration: Number.POSITIVE_INFINITY,
    expected: null,
  },
]

console.log('='.repeat(80))
console.log('auto-seek 自动追帧 rate-decision test')
console.log('='.repeat(80))
console.log('')

let passCount = 0
let failCount = 0

for (const [index, c] of cases.entries()) {
  const actual = decidePlaybackRate(c.bufferLen, c.threshold, c.duration)
  const match = actual === c.expected
  if (match) passCount++
  else failCount++
  const status = match ? '✅ PASS' : '❌ FAIL'
  console.log(`Test ${(index + 1).toString().padStart(2)}: ${status}  ${c.name}`)
  console.log(`  in:  bufferLen=${c.bufferLen}  threshold=${c.threshold}  duration=${c.duration}`)
  console.log(`  out: expected=${c.expected}  actual=${actual}`)
  if (!match) console.log('  ⚠️  MISMATCH')
  console.log('')
}

console.log('='.repeat(80))
console.log(`Total: ${cases.length}   Passed: ${passCount} ✅   Failed: ${failCount} ❌`)
console.log('='.repeat(80))

if (failCount > 0) process.exit(1)
