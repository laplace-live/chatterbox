import { describe, expect, test } from 'bun:test'

import { BRACKET_RESERVE, wrapSegment, wrapSplitLen } from './wrap'

/** Split length must reserve the two 【】 graphemes so a wrapped segment still fits maxLen. */
describe('wrapSplitLen', () => {
  test('reserves the wrapper graphemes when wrapping', () => {
    expect(wrapSplitLen(40, true)).toBe(40 - BRACKET_RESERVE)
  })

  test('passes maxLen through unchanged when not wrapping', () => {
    expect(wrapSplitLen(40, false)).toBe(40)
  })

  test('clamps to at least 1 for tiny maxLen', () => {
    expect(wrapSplitLen(1, true)).toBe(1)
    expect(wrapSplitLen(2, true)).toBe(1)
  })
})

describe('wrapSegment', () => {
  test('wraps in 【】 when enabled', () => {
    expect(wrapSegment('你好', true)).toBe('【你好】')
  })

  test('returns the segment untouched when disabled', () => {
    expect(wrapSegment('你好', false)).toBe('你好')
  })

  test('a wrapped segment fits maxLen given the reserved split length', () => {
    const maxLen = 10
    const content = 'x'.repeat(wrapSplitLen(maxLen, true))
    expect([...wrapSegment(content, true)].length).toBeLessThanOrEqual(maxLen)
  })
})
