import { describe, expect, test } from 'bun:test'

import { BLANK_VARIANCE, LUMA_HEIGHT, LUMA_WIDTH, lumaDiff, lumaVariance, rgbaToLuma } from './luma'

function rgba(pixels: [number, number, number, number?][]): Uint8ClampedArray {
  return Uint8ClampedArray.from(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]))
}

describe('rgbaToLuma', () => {
  test('weights R, G, B by Rec.601 and ignores alpha', () => {
    const pixels = rgba([
      [0, 0, 0],
      [255, 255, 255],
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [128, 128, 128, 0],
    ])
    expect([...rgbaToLuma(pixels)]).toEqual([0, 255, 76, 150, 29, 128])
  })

  test('gives one byte per pixel for a full grid, from either buffer type', () => {
    const size = LUMA_WIDTH * LUMA_HEIGHT * 4
    expect(rgbaToLuma(new Uint8ClampedArray(size))).toHaveLength(LUMA_WIDTH * LUMA_HEIGHT)
    expect([...rgbaToLuma(new Uint8Array([10, 10, 10, 255, 200, 200, 200, 255]))]).toEqual([10, 200])
  })
})

describe('lumaDiff', () => {
  test('is the mean absolute difference', () => {
    expect(lumaDiff(new Uint8Array([0, 100]), new Uint8Array([10, 80]))).toBe(15)
    expect(lumaDiff(new Uint8Array([10, 80]), new Uint8Array([0, 100]))).toBe(15)
    expect(lumaDiff(new Uint8Array([0, 255]), new Uint8Array([255, 0]))).toBe(255)
  })

  test('identical or empty buffers differ by 0', () => {
    const luma = new Uint8Array([1, 2, 3])
    expect(lumaDiff(luma, luma.slice())).toBe(0)
    expect(lumaDiff(new Uint8Array(0), new Uint8Array(0))).toBe(0)
  })

  test('buffers of different length are maximally different', () => {
    expect(lumaDiff(new Uint8Array(4), new Uint8Array(5))).toBe(255)
  })
})

describe('lumaVariance', () => {
  test('is the population variance', () => {
    expect(lumaVariance(new Uint8Array([0, 10]))).toBe(25)
    expect(lumaVariance(new Uint8Array([0, 255]))).toBe(127.5 ** 2)
  })

  test('a flat frame (black preroll) is below the blank threshold', () => {
    expect(lumaVariance(new Uint8Array(LUMA_WIDTH * LUMA_HEIGHT))).toBe(0)
    expect(lumaVariance(new Uint8Array([16, 17, 18, 19]))).toBeLessThan(BLANK_VARIANCE)
    expect(lumaVariance(new Uint8Array(0))).toBe(0)
  })
})
