import { describe, expect, test } from 'bun:test'

import { clampVisionFrames, fitLongEdge, resolveVisionEdge, VISION_EDGES } from './config'

describe('resolveVisionEdge', () => {
  test('keeps every supported edge', () => {
    for (const edge of VISION_EDGES) expect(resolveVisionEdge(edge)).toBe(edge)
  })

  test.each([0, 640, 2048, -768, Number.NaN, Number.POSITIVE_INFINITY])('falls back to 768 for %p', value => {
    expect(resolveVisionEdge(value)).toBe(768)
  })
})

describe('clampVisionFrames', () => {
  test.each([
    [1, 1],
    [2, 2],
    [4, 4],
    [0, 1],
    [-3, 1],
    [5, 4],
    [99, 4],
    [2.4, 2],
    [2.6, 3],
  ])('%p → %p', (value, expected) => {
    expect(clampVisionFrames(value)).toBe(expected)
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('non-finite %p → 2', value => {
    expect(clampVisionFrames(value)).toBe(2)
  })
})

describe('fitLongEdge', () => {
  test.each([
    [1920, 1080, 768, 1, [768, 432]],
    [1080, 1920, 160, 1, [90, 160]],
    [640, 360, 768, 1, [640, 360]],
    [0, 0, 768, 1, [1, 1]],
    [1000, 561, 512, 1, [512, 287]],
    [1000, 561, 512, 2, [512, 288]],
    [1, 1, 768, 2, [2, 2]],
  ])('%p×%p at %p, step %p → %p', (width, height, edge, step, size) => {
    expect(fitLongEdge(width, height, edge, step)).toEqual({ width: size[0], height: size[1] })
  })
})
