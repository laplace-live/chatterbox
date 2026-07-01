import { describe, expect, test } from 'bun:test'

import { buildOvuContributeUrl, extractBvid, extractOpusAuthorUid, extractOpusPubDate } from './utils'

/** Derives the BV id from bilibili video URLs; `undefined` for non-BV paths (legacy `av`, case-sensitive prefix). */
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

/** Reads opus author uid from the SSR snapshot (opus URL has no uid): prefer author module `mid`, fall back to `basic.uid`. */
describe('extractOpusAuthorUid', () => {
  test('author module mid (primary source)', () => {
    const state = {
      detail: {
        basic: { uid: '999' },
        modules: [
          { module_type: 'MODULE_TYPE_TITLE' },
          { module_type: 'MODULE_TYPE_AUTHOR', module_author: { mid: 1802654492, name: '七禾いえ' } },
          { module_type: 'MODULE_TYPE_CONTENT' },
        ],
      },
    }
    expect(extractOpusAuthorUid(state)).toBe(1802654492)
  })

  test('falls back to basic.uid string when no author module', () => {
    const state = { detail: { basic: { uid: '1802654492' }, modules: [{ module_type: 'MODULE_TYPE_TITLE' }] } }
    expect(extractOpusAuthorUid(state)).toBe(1802654492)
  })

  test('falls back to basic.uid when author module lacks a mid', () => {
    const state = {
      detail: { basic: { uid: '12345' }, modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: {} }] },
    }
    expect(extractOpusAuthorUid(state)).toBe(12345)
  })

  test('missing / malformed snapshot returns undefined', () => {
    expect(extractOpusAuthorUid(undefined)).toBeUndefined()
    expect(extractOpusAuthorUid(null)).toBeUndefined()
    expect(extractOpusAuthorUid({})).toBeUndefined()
    expect(extractOpusAuthorUid({ detail: {} })).toBeUndefined()
    expect(extractOpusAuthorUid({ detail: { basic: { uid: '' } } })).toBeUndefined()
    expect(extractOpusAuthorUid({ detail: { basic: { uid: '0' } } })).toBeUndefined()
  })
})

/** Formats author `pub_ts` (Unix seconds) in Beijing time. NOT `pub_time`, which becomes an edit-time string on edited posts. */
describe('extractOpusPubDate', () => {
  test('formats pub_ts as YYYY-MM-DD in Beijing time', () => {
    // 1778512382 = 2026-05-11 23:13 Beijing.
    const state = {
      detail: { modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: { mid: 1, pub_ts: '1778512382' } }] },
    }
    expect(extractOpusPubDate(state)).toBe('2026-05-11')
  })

  test('a timestamp late in the UTC day still lands on the Beijing date', () => {
    // 1778543000 = 2026-05-11 UTC but 2026-05-12 Beijing.
    const state = {
      detail: { modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: { pub_ts: 1778543000 } }] },
    }
    expect(extractOpusPubDate(state)).toBe('2026-05-12')
  })

  test('missing / malformed pub_ts returns undefined', () => {
    expect(extractOpusPubDate(undefined)).toBeUndefined()
    expect(extractOpusPubDate({ detail: {} })).toBeUndefined()
    expect(
      extractOpusPubDate({ detail: { modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: {} }] } })
    ).toBeUndefined()
    expect(
      extractOpusPubDate({
        detail: { modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: { pub_ts: '0' } }] },
      })
    ).toBeUndefined()
  })
})

/** Assembles the 贡献数据 link; `source`/`date` are only known on /opus/* and must be omitted — not blanked — elsewhere. */
describe('buildOvuContributeUrl', () => {
  test('uid only (non-opus surfaces)', () => {
    expect(buildOvuContributeUrl(1802654492)).toBe('https://laplace.live/ovu?uid=1802654492')
  })

  test('uid + source + date (opus surface), source URL is percent-encoded', () => {
    const url = buildOvuContributeUrl(1802654492, {
      source: 'https://www.bilibili.com/opus/1201190606249918471',
      date: '2026-05-11',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://laplace.live/ovu')
    expect(parsed.searchParams.get('uid')).toBe('1802654492')
    expect(parsed.searchParams.get('source')).toBe('https://www.bilibili.com/opus/1201190606249918471')
    expect(parsed.searchParams.get('date')).toBe('2026-05-11')
    expect(url).toContain('source=https%3A%2F%2Fwww.bilibili.com%2Fopus%2F1201190606249918471')
  })

  test('null / undefined source and date are omitted, not blanked', () => {
    expect(buildOvuContributeUrl(123, { source: null, date: null })).toBe('https://laplace.live/ovu?uid=123')
    expect(buildOvuContributeUrl(123, { source: 'https://x.test/opus/9' })).toBe(
      'https://laplace.live/ovu?uid=123&source=https%3A%2F%2Fx.test%2Fopus%2F9'
    )
  })
})
