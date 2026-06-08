import { describe, expect, test } from 'bun:test'

import { extractBvid } from './utils'

/**
 * `extractBvid` backs the LAPLACE ICU archive button on
 * `www.bilibili.com/video/*` pages — it derives the BV id that gets
 * spliced into `https://laplace.icu/v/:bvid`. A wrong or missing id would
 * send users to a dead archive URL, so the parser must pick the BV segment
 * out of the various shapes bilibili video URLs take (trailing slash, query
 * params, page selectors) and return `undefined` for paths that carry no
 * BV id (legacy `av` links, non-video paths).
 */
describe('extractBvid', () => {
  test('plain video URL', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1NbE866EK7')).toBe('BV1NbE866EK7')
  })

  test('trailing slash and query params', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1NbE866EK7/?p=2&t=10')).toBe('BV1NbE866EK7')
  })

  test('hash / fragment after the id', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1NbE866EK7#reply123')).toBe('BV1NbE866EK7')
  })

  test('legacy av short link has no BV id', () => {
    expect(extractBvid('https://www.bilibili.com/video/av170001')).toBeUndefined()
  })

  test('non-video path returns undefined', () => {
    expect(extractBvid('https://www.bilibili.com/')).toBeUndefined()
  })

  test('case-sensitive BV prefix — lowercase bv is not a BV id', () => {
    expect(extractBvid('https://www.bilibili.com/video/bv1NbE866EK7')).toBeUndefined()
  })
})
