import { describe, expect, test } from 'bun:test'

import { createVadSegmenter, type VadSegmenter } from './vad-segmenter'

const RATE = 16000
/** One 64 ms sub-block at 16 kHz — the unit the segmenter reasons in. */
const SUB = 1024

const SILENT = 0
const SPEECH = 3000 // rms ≈ 0.092
const NOISE = 500 // rms ≈ 0.015, steady background

/** Push `blocks` × 64 ms of alternating ±amplitude, split into `frameSize` chunks. */
function feed(seg: VadSegmenter, amplitude: number, blocks: number, frameSize = SUB): void {
  const total = blocks * SUB
  let written = 0
  while (written < total) {
    const n = Math.min(frameSize, total - written)
    const frame = new Int16Array(n)
    for (let i = 0; i < n; i++) frame[i] = (written + i) % 2 === 0 ? amplitude : -amplitude
    seg.push(frame)
    written += n
  }
}

function collect(): { segments: Int16Array[]; seg: VadSegmenter } {
  const segments: Int16Array[] = []
  const seg = createVadSegmenter({ sampleRate: RATE, onSegment: s => segments.push(s) })
  return { segments, seg }
}

describe('createVadSegmenter', () => {
  test('emits one segment for silence → speech → silence', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 20)
    feed(seg, SILENT, 12)
    expect(segments.length).toBe(1)
  })

  test('discards speech shorter than the one-second minimum', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 5)
    feed(seg, SILENT, 12)
    expect(segments.length).toBe(0)
  })

  test('prepends pre-roll and keeps the closing silence', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 20)
    feed(seg, SILENT, 12)
    // 4 pre-roll + 20 speech + 10 silence blocks (silence closes at 600 ms).
    expect(segments[0].length).toBe(34 * SUB)
  })

  test('force-flushes continuous speech at the 15s cap', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 300)
    // Cuts at the first sub-block boundary past 240000 samples, then keeps buffering.
    expect(segments.length).toBe(1)
    expect(segments[0].length).toBe(235 * SUB)
  })

  test('drops a silence-only continuation tail after a force-flush cut', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    // 4 pre-roll + 231 speech blocks exactly reach the 15 s cut, so the tail that follows holds no speech.
    feed(seg, SPEECH, 231)
    feed(seg, SILENT, 12)
    expect(segments.length).toBe(1)
  })

  test('flush drops a silence-only continuation tail', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 231)
    feed(seg, SILENT, 5)
    seg.flush()
    expect(segments.length).toBe(1)
  })

  test('adapts to steady background noise instead of latching on it', () => {
    const { segments, seg } = collect()
    feed(seg, NOISE, 200)
    expect(segments.length).toBe(0)
  })

  test('still detects speech that rises above steady background noise', () => {
    const { segments, seg } = collect()
    feed(seg, NOISE, 20)
    feed(seg, SPEECH, 20)
    feed(seg, NOISE, 12)
    expect(segments.length).toBe(1)
  })

  test('flush emits an open segment that has not met the minimum', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 5)
    seg.flush()
    expect(segments.length).toBe(1)
  })

  test('flush includes a ragged remainder retained by push', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    feed(seg, SPEECH, 20)
    // 100 samples < one sub-block: push() keeps them pending; flush() must not drop them.
    seg.push(new Int16Array(100).fill(SPEECH))
    seg.flush()
    expect(segments.length).toBe(1)
    // 4 pre-roll + 20 speech blocks + the pending remainder.
    expect(segments[0].length).toBe(24 * SUB + 100)
  })

  test('flush is a no-op when no segment is open', () => {
    const { segments, seg } = collect()
    feed(seg, SILENT, 10)
    seg.flush()
    expect(segments.length).toBe(0)
  })

  test('segments identically when frames do not divide into sub-blocks', () => {
    const even = collect()
    feed(even.seg, SILENT, 10, 4096)
    feed(even.seg, SPEECH, 20, 4096)
    feed(even.seg, SILENT, 12, 4096)

    const ragged = collect()
    feed(ragged.seg, SILENT, 10, 1000)
    feed(ragged.seg, SPEECH, 20, 1000)
    feed(ragged.seg, SILENT, 12, 1000)

    expect(ragged.segments.length).toBe(even.segments.length)
    expect(ragged.segments[0].length).toBe(even.segments[0].length)
  })
})
