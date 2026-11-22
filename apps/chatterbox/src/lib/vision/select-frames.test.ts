import { describe, expect, test } from 'bun:test'

import type { VisionFrame } from './types'

import { KEEP_DIFF, LUMA_HEIGHT, LUMA_WIDTH } from './luma'
import { frameLabel, selectFrames } from './select-frames'

const NOW = 100_000

/** A uniform frame whose luma is `level` everywhere. */
function frame(at: number, level: number): VisionFrame {
  return {
    at,
    luma: new Uint8Array(LUMA_WIDTH * LUMA_HEIGHT).fill(level),
    dataUrl: `data:image/jpeg;base64,${at}`,
    thumbUrl: `data:image/jpeg;base64,thumb${at}`,
  }
}

const current = frame(NOW, 200)
const ats = (frames: readonly VisionFrame[]) => frames.map(f => f.at)

describe('frameLabel', () => {
  test.each([
    [0, '当前'],
    [500, '当前'],
    [-200, '1 秒前'],
    [-1_400, '1 秒前'],
    [-2_600, '3 秒前'],
    [-12_000, '12 秒前'],
  ])('%p ms from current → %s', (offset, label) => {
    expect(frameLabel(NOW + offset, NOW)).toBe(label)
  })
})

describe('selectFrames', () => {
  test('always includes the current frame', () => {
    const kept = [frame(NOW - 5_000, 0)]
    expect(selectFrames({ kept: [], current, from: 0, max: 4 })).toEqual([{ ...current, label: '当前' }])
    expect(ats(selectFrames({ kept, current, from: 0, max: 1 }))).toEqual([NOW])
    expect(ats(selectFrames({ kept, current, from: 0, max: 0 }))).toEqual([NOW])
  })

  test('only picks kept frames with from <= at < current.at', () => {
    const kept = [frame(NOW - 9_000, 0), frame(NOW - 6_000, 60), frame(NOW, 120), frame(NOW + 1_000, 255)]
    expect(ats(selectFrames({ kept, current, from: NOW - 6_000, max: 4 }))).toEqual([NOW - 6_000, NOW])
  })

  test('picks greedily by distance to every frame already picked', () => {
    const kept = [frame(NOW - 4_000, 0), frame(NOW - 3_000, 10), frame(NOW - 2_000, 100), frame(NOW - 1_000, 190)]
    // 10 is far from the current frame but close to 0, so 100 is the second pick.
    expect(ats(selectFrames({ kept, current, from: 0, max: 3 }))).toEqual([NOW - 4_000, NOW - 2_000, NOW])
  })

  test('stops once the best candidate is less than KEEP_DIFF from some pick', () => {
    const kept = [frame(NOW - 3_000, 0), frame(NOW - 2_000, KEEP_DIFF - 1), frame(NOW - 1_000, 200 - (KEEP_DIFF - 1))]
    expect(ats(selectFrames({ kept, current, from: 0, max: 4 }))).toEqual([NOW - 3_000, NOW])
    const borderline = [frame(NOW - 1_000, 200 - KEEP_DIFF)]
    expect(ats(selectFrames({ kept: borderline, current, from: 0, max: 4 }))).toEqual([NOW - 1_000, NOW])
  })

  test('a static scene collapses to the current frame', () => {
    const kept = [frame(NOW - 8_000, 198), frame(NOW - 4_000, 201), frame(NOW - 2_000, 203)]
    expect(selectFrames({ kept, current, from: 0, max: 4 })).toEqual([{ ...current, label: '当前' }])
  })

  test('returns picks oldest first with time labels', () => {
    const kept = [frame(NOW - 10_400, 255), frame(NOW - 3_000, 0)]
    const picked = selectFrames({ kept, current, from: 0, max: 3 })
    expect(picked.map(f => [f.label, f.dataUrl, f.thumbUrl])).toEqual([
      ['10 秒前', kept[0].dataUrl, kept[0].thumbUrl],
      ['3 秒前', kept[1].dataUrl, kept[1].thumbUrl],
      ['当前', current.dataUrl, current.thumbUrl],
    ])
  })
})
