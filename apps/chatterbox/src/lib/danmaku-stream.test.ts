import { describe, expect, test } from 'bun:test'

import { isEmoteDanmaku } from './danmaku-stream'

/** B站 marks emote danmaku `data-type="1"`; text danmaku stay `"0"` even when made of inline emoji. */
describe('isEmoteDanmaku', () => {
  test('emote danmaku', () => {
    expect(isEmoteDanmaku({ dataset: { type: '1', danmaku: '应援' } })).toBe(true)
  })

  test('text danmaku, with or without inline emoji', () => {
    expect(isEmoteDanmaku({ dataset: { type: '0', danmaku: '这就是烂梗' } })).toBe(false)
    expect(isEmoteDanmaku({ dataset: { type: '0', danmaku: '哈哈[花]' } })).toBe(false)
    expect(isEmoteDanmaku({ dataset: { type: '0', danmaku: '[花]' } })).toBe(false)
  })

  test('rows without data-type (gift, welcome, system)', () => {
    expect(isEmoteDanmaku({ dataset: {} })).toBe(false)
  })
})
