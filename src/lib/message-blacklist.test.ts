import { describe, expect, test } from 'bun:test'

import {
  compileMessageBlacklist,
  isRegexEntry,
  parseRegexEntry,
  testMessageBlacklist,
  validateRegexEntry,
} from './message-blacklist'

/**
 * The 自动融入 message blacklist accepts two kinds of entries through one
 * input: plain text (exact whole-message match — the historical behaviour)
 * and `/pattern/flags` regex entries (match ANYWHERE in the danmaku). These
 * pure helpers back the Settings add-input, the live-match hot path in
 * `auto-blend.ts`, and the list "正则" badge — split out from any signal /
 * GM-storage glue so the parsing, validation, and matching rules are
 * unit-testable without a DOM or the `$` userscript globals.
 *
 * Contract:
 * - A key wrapped in slashes (`/.../`, optional trailing flags) is a regex;
 *   anything else is a literal.
 * - Regex entries match as a substring (`.test`); literals must equal the
 *   whole trimmed message.
 * - `g` / `y` are stripped before compilation so repeated `.test()` calls
 *   can't desync via a shared `lastIndex`.
 * - An invalid pattern is rejected at add-time (`validateRegexEntry`) and
 *   skipped — never thrown — at match-time (`compileMessageBlacklist`).
 */
describe('parseRegexEntry', () => {
  test.each([
    { key: '/口.*交/', source: '口.*交', flags: '' },
    { key: '/口.*交/i', source: '口.*交', flags: 'i' },
    { key: '/a/gimsuy', source: 'a', flags: 'gimsuy' },
  ])('$key → regex', ({ key, source, flags }) => {
    expect(parseRegexEntry(key)).toEqual({ source, flags })
  })

  test.each([
    { label: 'plain text', key: '口交' },
    { label: 'leading slash only', key: '/abc' },
    { label: 'trailing slash only', key: 'abc/' },
    { label: 'empty body', key: '//' },
    { label: 'empty string', key: '' },
  ])('$label → null (literal)', ({ key }) => {
    expect(parseRegexEntry(key)).toBeNull()
  })
})

describe('isRegexEntry', () => {
  test('slash-wrapped is a regex', () => {
    expect(isRegexEntry('/a/')).toBe(true)
  })
  test('plain text is a literal', () => {
    expect(isRegexEntry('口交')).toBe(false)
  })
})

describe('validateRegexEntry', () => {
  test.each([
    { label: 'literal', input: '口交' },
    { label: 'valid regex', input: '/口.*交/' },
    { label: 'valid regex with flags', input: '/口.*交/i' },
  ])('$label → ok', ({ input }) => {
    expect(validateRegexEntry(input).ok).toBe(true)
  })

  test.each([
    { label: 'unbalanced group', input: '/(/' },
    { label: 'invalid flags', input: '/a/zzz' },
  ])('$label → not ok', ({ input }) => {
    expect(validateRegexEntry(input).ok).toBe(false)
  })
})

describe('compileMessageBlacklist + testMessageBlacklist', () => {
  test('literal matches the whole message exactly', () => {
    const c = compileMessageBlacklist(['口交'])
    expect(testMessageBlacklist(c, '口交')).toBe(true)
    expect(testMessageBlacklist(c, '我口交了')).toBe(false)
  })

  test('regex matches anywhere in the message', () => {
    const c = compileMessageBlacklist(['/口.*交/'])
    expect(testMessageBlacklist(c, '口交')).toBe(true)
    expect(testMessageBlacklist(c, '口***交')).toBe(true)
    expect(testMessageBlacklist(c, '口泽满灰交')).toBe(true)
    expect(testMessageBlacklist(c, '无关弹幕')).toBe(false)
  })

  test('case-insensitive flag is honoured', () => {
    const c = compileMessageBlacklist(['/abc/i'])
    expect(testMessageBlacklist(c, 'xxABCxx')).toBe(true)
  })

  test('g flag does not desync across repeated tests', () => {
    // Without stripping `g`, the shared `lastIndex` would make the 2nd call
    // miss — this is the bug the strip guards against.
    const c = compileMessageBlacklist(['/口/g'])
    expect(testMessageBlacklist(c, '口')).toBe(true)
    expect(testMessageBlacklist(c, '口')).toBe(true)
  })

  test('invalid pattern is skipped, not thrown', () => {
    const c = compileMessageBlacklist(['/(/', '口交'])
    expect(c.regexes).toHaveLength(0)
    expect(testMessageBlacklist(c, '口交')).toBe(true)
    expect(testMessageBlacklist(c, 'anything')).toBe(false)
  })

  test('mixed literal + regex entries', () => {
    const c = compileMessageBlacklist(['草', '/口.*交/i'])
    expect(testMessageBlacklist(c, '草')).toBe(true)
    expect(testMessageBlacklist(c, '口XX交')).toBe(true)
    // The literal is exact, so a superstring of it does not match.
    expect(testMessageBlacklist(c, '草泥马')).toBe(false)
  })
})
