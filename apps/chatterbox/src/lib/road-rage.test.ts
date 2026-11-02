import { afterEach, describe, expect, test } from 'bun:test'

import {
  applyRoadRageOnSend,
  isRoadRageRepeat,
  previewRoadRageText,
  ROAD_RAGE_WINDOW_MS,
  resetRoadRageState,
} from './road-rage'

afterEach(() => {
  resetRoadRageState()
})

describe('road-rage repeat window', () => {
  test('treats same text within 5s as repeat and matches preview', () => {
    const t0 = 10_000
    const first = applyRoadRageOnSend({
      original: '草',
      processed: '草',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0,
    })
    expect(first).toEqual({ text: '草', roadRaged: false })
    expect(isRoadRageRepeat('草', t0 + 1000)).toBe(true)
    expect(isRoadRageRepeat('草', t0 + ROAD_RAGE_WINDOW_MS - 1)).toBe(true)
    expect(isRoadRageRepeat('别的', t0 + 1000)).toBe(false)

    const preview = previewRoadRageText('草', '草', '~', true, t0 + 2000)
    expect(preview === '~草' || preview === '草~').toBe(true)

    const second = applyRoadRageOnSend({
      original: '草',
      processed: '草',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0 + 2000,
    })
    expect(second).toEqual({ text: preview, roadRaged: true })
  })

  test('consecutive repeats within window never reuse the previous insertion slot', () => {
    let now = 10_000
    applyRoadRageOnSend({
      original: 'abcd',
      processed: 'abcd',
      char: '~',
      enabled: true,
      isEmote: false,
      now,
    })

    let prevText = ''
    for (let i = 0; i < 20; i++) {
      now += 1000
      const res = applyRoadRageOnSend({
        original: 'abcd',
        processed: 'abcd',
        char: '~',
        enabled: true,
        isEmote: false,
        now,
      })
      expect(res.roadRaged).toBe(true)
      expect(res.text).not.toBe(prevText)
      prevText = res.text
    }
  })

  test('allows clean send once 5s window has elapsed, even if preview ran before expiry', () => {
    const t0 = 10_000
    applyRoadRageOnSend({
      original: '测试',
      processed: '测试',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0,
    })

    // User types the repeat at +1s (caching a preview), then waits until +5s to press Enter.
    const earlyPreview = previewRoadRageText('测试', '测试', '~', true, t0 + 1000)
    expect(earlyPreview).toContain('~')

    const tExpired = t0 + ROAD_RAGE_WINDOW_MS
    expect(isRoadRageRepeat('测试', tExpired)).toBe(false)
    expect(previewRoadRageText('测试', '测试', '~', true, tExpired)).toBe('测试')

    const afterExpiry = applyRoadRageOnSend({
      original: '测试',
      processed: '测试',
      char: '~',
      enabled: true,
      isEmote: false,
      now: tExpired,
    })
    expect(afterExpiry).toEqual({ text: '测试', roadRaged: false })

    const rapidFollowup = applyRoadRageOnSend({
      original: '测试',
      processed: '测试',
      char: '~',
      enabled: true,
      isEmote: false,
      now: tExpired + 1000,
    })
    expect(rapidFollowup.roadRaged).toBe(true)
    expect(rapidFollowup.text).toContain('~')
  })

  test('skips emotes and disabled mode while still updating the baseline', () => {
    const t0 = 10_000
    applyRoadRageOnSend({
      original: 'official_102',
      processed: 'official_102',
      char: '~',
      enabled: true,
      isEmote: true,
      now: t0,
    })
    const emoteRepeat = applyRoadRageOnSend({
      original: 'official_102',
      processed: 'official_102',
      char: '~',
      enabled: true,
      isEmote: true,
      now: t0 + 500,
    })
    expect(emoteRepeat).toEqual({ text: 'official_102', roadRaged: false })

    applyRoadRageOnSend({
      original: '普通',
      processed: '普通',
      char: '~',
      enabled: false,
      isEmote: false,
      now: t0 + 1000,
    })
    const disabledRepeat = applyRoadRageOnSend({
      original: '普通',
      processed: '普通',
      char: '~',
      enabled: false,
      isEmote: false,
      now: t0 + 1500,
    })
    expect(disabledRepeat).toEqual({ text: '普通', roadRaged: false })
  })
})
