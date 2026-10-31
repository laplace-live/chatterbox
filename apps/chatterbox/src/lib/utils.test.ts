import { describe, expect, test } from 'bun:test'

import { DEFAULT_INVISIBLE_CHAR, INVISIBLE_CHAR_CUSTOM } from './const'
import {
  addRandomCharacter,
  buildMemeContributeUrl,
  buildOvuContributeUrl,
  countDanmakuMessages,
  extractBvid,
  extractOpusAuthorUid,
  extractOpusPubDate,
  formatCodePoints,
  formatDanmakuError,
  getDanmakuUnits,
  insertRandomChar,
  isHttpUrl,
  parseCustomChar,
  processDanmakuMessages,
  resolveInvisibleChar,
  trimDanmakuByUnits,
} from './utils'

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
      detail: { basic: { uid: '2763' }, modules: [{ module_type: 'MODULE_TYPE_AUTHOR', module_author: {} }] },
    }
    expect(extractOpusAuthorUid(state)).toBe(2763)
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

/** Assembles the 贡献烂梗 link; the streamer uid is null until the room resolves, and an unset param must be omitted. */
describe('buildMemeContributeUrl', () => {
  test('streamer uid only (烂梗库 panel link)', () => {
    expect(buildMemeContributeUrl(1802654492)).toBe('https://laplace.live/memes?contribute=1802654492')
  })

  test('streamer uid + content round-trips through percent-encoding', () => {
    const content = '草 & 100% [dog] #1 a+b?'
    const url = buildMemeContributeUrl(1802654492, content)
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://laplace.live/memes')
    expect(parsed.searchParams.get('contribute')).toBe('1802654492')
    expect(parsed.searchParams.get('content')).toBe(content)
  })

  test('unresolved streamer uid keeps the content so the dialog still opens', () => {
    expect(buildMemeContributeUrl(null, '好')).toBe('https://laplace.live/memes?content=%E5%A5%BD')
    expect(buildMemeContributeUrl(0, '好')).toBe('https://laplace.live/memes?content=%E5%A5%BD')
  })

  test('nothing to prefill → bare /memes', () => {
    expect(buildMemeContributeUrl(null)).toBe('https://laplace.live/memes')
    expect(buildMemeContributeUrl(null, '')).toBe('https://laplace.live/memes')
  })
})

/** Endpoint gate for user-entered service addresses (openai-compat STT). */
describe('isHttpUrl', () => {
  test('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('http://127.0.0.1:8080/v1')).toBe(true)
    expect(isHttpUrl('https://api.groq.com/openai/v1')).toBe(true)
  })

  test('rejects schemeless host:port — new URL parses it with a bogus protocol', () => {
    expect(isHttpUrl('localhost:8080/v1')).toBe(false)
  })

  test('rejects empty and non-URL strings', () => {
    expect(isHttpUrl('')).toBe(false)
    expect(isHttpUrl('whisper')).toBe(false)
  })

  test('rejects non-http schemes', () => {
    expect(isHttpUrl('ftp://example.com')).toBe(false)
    expect(isHttpUrl('ws://127.0.0.1:8080')).toBe(false)
  })
})

/** Inserts the given char exactly once at a grapheme boundary, never inside a balanced `[...]` emote. */
describe('addRandomCharacter', () => {
  test('inserts the char exactly once, leaving the text otherwise intact', () => {
    for (let i = 0; i < 50; i++) {
      const out = addRandomCharacter('你好世界', '\u200B')
      expect(out.split('\u200B')).toHaveLength(2)
      expect(out.replace('\u200B', '')).toBe('你好世界')
    }
  })

  test('never lands inside an emote bracket', () => {
    for (let i = 0; i < 50; i++) {
      expect(['~[doge]', '[doge]~']).toContain(addRandomCharacter('[doge]', '~'))
    }
  })

  test('multi-char strings are inserted as one unit', () => {
    for (let i = 0; i < 50; i++) {
      expect(['XYab', 'aXYb', 'abXY']).toContain(addRandomCharacter('ab', 'XY'))
    }
  })

  test('empty text is returned unchanged', () => {
    expect(addRandomCharacter('', '~')).toBe('')
  })
})

/** Per-line split with optional char insertion; blank lines are dropped. */
describe('processDanmakuMessages', () => {
  test('inserts the char into every non-blank line when given', () => {
    const out = processDanmakuMessages('ab\n\ncd', 20, '~')
    expect(out).toHaveLength(2)
    for (const msg of out) expect(msg.split('~')).toHaveLength(2)
  })

  test('leaves lines untouched without a char', () => {
    expect(processDanmakuMessages('ab\n\ncd', 20)).toEqual(['ab', 'cd'])
  })
})

/** Send-failure reason for the log: Bilibili's bare `f`/`k` shield codes get a label, anything else passes through. */
describe('formatDanmakuError', () => {
  test('labels the bare shield-word codes', () => {
    expect(formatDanmakuError('f')).toBe('f - 包含全局屏蔽词')
    expect(formatDanmakuError('k')).toBe('k - 包含房间屏蔽词')
  })

  test('passes other errors through even when they contain f or k', () => {
    for (const error of ['Failed to fetch', 'csrf 校验失败', 'Unexpected token < in JSON']) {
      expect(formatDanmakuError(error)).toBe(error)
    }
  })
})

/** Code point readout for the settings UI. */
describe('formatCodePoints', () => {
  test('pads BMP code points to 4 hex digits', () => {
    expect(formatCodePoints('\u00AD')).toBe('U+00AD')
  })

  test('keeps astral code points whole', () => {
    expect(formatCodePoints('a\u{1F600}')).toBe('U+0061 U+1F600')
  })
})

/** Custom insert-char field: `U+XXXX`-only input decodes, anything else is literal. */
describe('parseCustomChar', () => {
  test('decodes a code point, case-insensitively', () => {
    expect(parseCustomChar('U+200B')).toBe('\u200B')
    expect(parseCustomChar('u+200b')).toBe('\u200B')
  })

  test('decodes whitespace-separated sequences, including astral code points', () => {
    expect(parseCustomChar(' U+200B  U+1F600 ')).toBe('\u200B\u{1F600}')
  })

  test('takes anything else literally', () => {
    expect(parseCustomChar('~')).toBe('~')
    expect(parseCustomChar('aU+200B')).toBe('aU+200B')
    expect(parseCustomChar('')).toBe('')
  })

  test('rejects surrogates and out-of-range code points', () => {
    expect(parseCustomChar('U+D800')).toBeNull()
    expect(parseCustomChar('U+110000')).toBeNull()
  })
})

/** Preset / custom resolution, falling back to `DEFAULT_INVISIBLE_CHAR`. */
describe('resolveInvisibleChar', () => {
  test('uses a known preset', () => {
    expect(resolveInvisibleChar('\u200B', '')).toBe('\u200B')
  })

  test('unknown preset falls back to the default', () => {
    expect(resolveInvisibleChar('x', '')).toBe(DEFAULT_INVISIBLE_CHAR)
  })

  test('custom mode uses the parsed input', () => {
    expect(resolveInvisibleChar(INVISIBLE_CHAR_CUSTOM, 'U+2063')).toBe('\u2063')
    expect(resolveInvisibleChar(INVISIBLE_CHAR_CUSTOM, '~')).toBe('~')
  })

  test('empty or invalid custom input falls back to the default', () => {
    expect(resolveInvisibleChar(INVISIBLE_CHAR_CUSTOM, '')).toBe(DEFAULT_INVISIBLE_CHAR)
    expect(resolveInvisibleChar(INVISIBLE_CHAR_CUSTOM, 'U+D800')).toBe(DEFAULT_INVISIBLE_CHAR)
  })
})

/** Position-returning insert used by 路怒模式; avoids reusing the previous slot. */
describe('insertRandomChar', () => {
  test('returns text with the char at the reported index', () => {
    for (let i = 0; i < 50; i++) {
      const { text, index } = insertRandomChar('abcd', '~')
      expect(text.replace('~', '')).toBe('abcd')
      expect(text[index]).toBe('~')
    }
  })

  test('avoids the given index when another slot exists', () => {
    // 'ab' has slots 0,1,2; avoiding one must always yield a different index.
    for (let i = 0; i < 100; i++) {
      const { index } = insertRandomChar('ab', '~', 1)
      expect(index).not.toBe(1)
    }
  })

  test('consecutive inserts never repeat the same slot', () => {
    let prev = insertRandomChar('hello', '~').index
    for (let i = 0; i < 100; i++) {
      const { index } = insertRandomChar('hello', '~', prev)
      expect(index).not.toBe(prev)
      prev = index
    }
  })

  test('stays out of emote brackets and reports a valid outer slot', () => {
    for (let i = 0; i < 50; i++) {
      const { text, index } = insertRandomChar('[doge]', '~')
      expect([0, 6]).toContain(index)
      expect(['~[doge]', '[doge]~']).toContain(text)
    }
  })

  test('empty text returns index -1 and is unchanged', () => {
    expect(insertRandomChar('', '~')).toEqual({ text: '', index: -1 })
  })

  test('avoidIndex is ignored when it is the only slot', () => {
    // A fully-bracketed string leaves only the two outer slots; avoiding one still yields the other.
    const { index } = insertRandomChar('[ab]', '~', 0)
    expect(index).toBe(4)
  })
})

/** Matches Bilibili's `utilDanmuLength`: printable ASCII = 1, BMP non-ASCII = 2, astral surrogate pair = 4. */
describe('getDanmakuUnits & trimDanmakuByUnits', () => {
  test('weights ASCII, CJK, invisible chars, and emojis identically to Bilibili utilDanmuLength', () => {
    expect(getDanmakuUnits('a ~')).toBe(3)
    expect(getDanmakuUnits('你好')).toBe(4)
    expect(getDanmakuUnits('【】')).toBe(4)
    expect(getDanmakuUnits('\u200B')).toBe(2)
    expect(getDanmakuUnits('😀')).toBe(4)
    expect(getDanmakuUnits('👍🏽')).toBe(8)
  })

  test('fits 40 CJK chars or 80 ASCII chars or 20 emojis into 80 units and splits past 80', () => {
    expect(trimDanmakuByUnits('好'.repeat(40), 80)).toEqual(['好'.repeat(40)])
    expect(trimDanmakuByUnits('好'.repeat(41), 80)).toEqual(['好'.repeat(40), '好'])
    expect(trimDanmakuByUnits('a'.repeat(80), 80)).toEqual(['a'.repeat(80)])
    expect(trimDanmakuByUnits('a'.repeat(81), 80)).toEqual(['a'.repeat(80), 'a'])
    expect(trimDanmakuByUnits(`${'a'.repeat(79)}好`, 80)).toEqual(['a'.repeat(79), '好'])
    expect(trimDanmakuByUnits('😀'.repeat(20), 80)).toEqual(['😀'.repeat(20)])
    expect(trimDanmakuByUnits('😀'.repeat(21), 80)).toEqual(['😀'.repeat(20), '😀'])
  })

  test('keeps multi-codepoint grapheme clusters intact unless a single cluster exceeds maxUnits', () => {
    // 10 * 8 = 80 units; 11th skin-tone emoji moves whole to chunk 2.
    expect(trimDanmakuByUnits('👍🏽'.repeat(11), 80)).toEqual(['👍🏽'.repeat(10), '👍🏽'])
    // Oversized ZWJ cluster (22 units) falls back to code-point cuts when maxUnits = 10.
    const chunks = trimDanmakuByUnits('👨‍👩‍👧‍👦', 10)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(getDanmakuUnits(chunk)).toBeLessThanOrEqual(10)
  })

  test('processDanmakuMessages accounts for inserted invisible char (2 units) before splitting', () => {
    const out = processDanmakuMessages('好'.repeat(40), 80, '\u200B')
    expect(out).toHaveLength(2)
    for (const seg of out) expect(getDanmakuUnits(seg)).toBeLessThanOrEqual(80)
  })

  test('countDanmakuMessages counts split lines, randomChar (including U+FEFF), transformLine, and unsplit emotes', () => {
    expect(countDanmakuMessages('   \n  ', 80)).toBe(0)
    expect(countDanmakuMessages('好'.repeat(40), 80)).toBe(1)
    expect(countDanmakuMessages('好'.repeat(41), 80)).toBe(2)
    expect(countDanmakuMessages('第一行\n\n第二行', 80)).toBe(2)
    expect(countDanmakuMessages('好'.repeat(40), 80, { randomChar: '\u00AD' })).toBe(2)
    expect(countDanmakuMessages('好'.repeat(40), 80, { randomChar: '\uFEFF' })).toBe(2)
    expect(countDanmakuMessages(`\uFEFF${'好'.repeat(40)}`, 80)).toBe(2)
    expect(
      countDanmakuMessages(`${'好'.repeat(19)}v`, 40, {
        transformLine: line => line.replaceAll('v', '微信'),
      })
    ).toBe(2)
    expect(
      countDanmakuMessages('drop', 40, {
        transformLine: () => '',
      })
    ).toBe(0)
    expect(
      countDanmakuMessages('official_147\n你好世界', 10, {
        isEmote: line => line === 'official_147',
        trimLines: true,
      })
    ).toBe(2)
  })
})
