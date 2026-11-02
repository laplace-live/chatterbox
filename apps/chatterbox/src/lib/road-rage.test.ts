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
    expect(ROAD_RAGE_WINDOW_MS).toBe(5000)

    const t0 = 10_000
    const first = applyRoadRageOnSend({
      original: '草',
      processed: '草',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0,
    })
    first.settle(true, t0)
    expect({ text: first.text, roadRaged: first.roadRaged }).toEqual({ text: '草', roadRaged: false })
    expect(isRoadRageRepeat('草', t0 + 1000)).toBe(true)
    expect(isRoadRageRepeat('草', t0 + 4999)).toBe(true)
    expect(isRoadRageRepeat('草', t0 + 5000)).toBe(false)
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
    second.settle(true, t0 + 2000)
    expect({ text: second.text, roadRaged: second.roadRaged }).toEqual({ text: preview, roadRaged: true })
  })

  test('consecutive repeats within window never reuse the previous insertion slot', () => {
    let now = 10_000
    const initial = applyRoadRageOnSend({
      original: 'abcd',
      processed: 'abcd',
      char: '~',
      enabled: true,
      isEmote: false,
      now,
    })
    initial.settle(true, now)

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
      res.settle(true, now)
      expect(res.roadRaged).toBe(true)
      expect(res.text).not.toBe(prevText)
      prevText = res.text
    }
  })

  test('allows clean send once 5s window has elapsed, even if preview ran before expiry', () => {
    const t0 = 10_000
    const first = applyRoadRageOnSend({
      original: '测试',
      processed: '测试',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0,
    })
    first.settle(true, t0)

    // User types the repeat at +1s (caching a preview), then waits until +5s to press Enter.
    const earlyPreview = previewRoadRageText('测试', '测试', '~', true, t0 + 1000)
    expect(earlyPreview).toContain('~')

    const tExpired = t0 + 5000
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
    afterExpiry.settle(true, tExpired)
    expect({ text: afterExpiry.text, roadRaged: afterExpiry.roadRaged }).toEqual({ text: '测试', roadRaged: false })

    const rapidFollowup = applyRoadRageOnSend({
      original: '测试',
      processed: '测试',
      char: '~',
      enabled: true,
      isEmote: false,
      now: tExpired + 1000,
    })
    rapidFollowup.settle(true, tExpired + 1000)
    expect(rapidFollowup.roadRaged).toBe(true)
    expect(rapidFollowup.text).toContain('~')
  })

  test('starts 5s window from confirmed POST completion and ignores failed sends', () => {
    const t0 = 10_000
    const failed = applyRoadRageOnSend({
      original: '排队',
      processed: '排队',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0,
    })
    failed.settle(false, t0 + 500)
    expect(isRoadRageRepeat('排队', t0 + 600)).toBe(false)

    // First send starts at t0 + 1000 and stays in the send queue for 4.5s (completing at t0 + 5500).
    const first = applyRoadRageOnSend({
      original: '排队',
      processed: '排队',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0 + 1000,
    })
    expect(first.roadRaged).toBe(false)
    // While still queued past 5s from start, in-flight state keeps repeat detection active.
    expect(isRoadRageRepeat('排队', t0 + 6200)).toBe(true)
    first.settle(true, t0 + 5500)

    // At t0 + 6100 (5.1s after send start, but only 0.6s after POST completion), still within 5s window.
    expect(isRoadRageRepeat('排队', t0 + 6100)).toBe(true)
    const retryAfterSlowPost = applyRoadRageOnSend({
      original: '排队',
      processed: '排队',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0 + 6100,
    })
    expect(retryAfterSlowPost.roadRaged).toBe(true)
    expect(retryAfterSlowPost.text).toContain('~')

    // If a subsequent different send fails, the prior confirmed baseline ('排队' at t0 + 5500) is preserved.
    retryAfterSlowPost.settle(false, t0 + 6500)
    expect(isRoadRageRepeat('排队', t0 + 10_499)).toBe(true)
    expect(isRoadRageRepeat('排队', t0 + 10_500)).toBe(false)
  })

  test('skips emotes and disabled mode while still updating the baseline', () => {
    const t0 = 10_000
    const emoteFirst = applyRoadRageOnSend({
      original: 'official_102',
      processed: 'official_102',
      char: '~',
      enabled: true,
      isEmote: true,
      now: t0,
    })
    emoteFirst.settle(true, t0)
    expect(isRoadRageRepeat('official_102', t0 + 500)).toBe(true)

    const emoteRepeat = applyRoadRageOnSend({
      original: 'official_102',
      processed: 'official_102',
      char: '~',
      enabled: true,
      isEmote: true,
      now: t0 + 500,
    })
    emoteRepeat.settle(true, t0 + 500)
    expect({ text: emoteRepeat.text, roadRaged: emoteRepeat.roadRaged }).toEqual({
      text: 'official_102',
      roadRaged: false,
    })

    const plainAfterEmote = applyRoadRageOnSend({
      original: 'official_102',
      processed: 'official_102',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0 + 800,
    })
    plainAfterEmote.settle(true, t0 + 800)
    expect(plainAfterEmote.roadRaged).toBe(true)
    expect(plainAfterEmote.text).toContain('~')

    const disabledFirst = applyRoadRageOnSend({
      original: '普通',
      processed: '普通',
      char: '~',
      enabled: false,
      isEmote: false,
      now: t0 + 1000,
    })
    disabledFirst.settle(true, t0 + 1000)
    expect(isRoadRageRepeat('普通', t0 + 1500)).toBe(true)

    const disabledRepeat = applyRoadRageOnSend({
      original: '普通',
      processed: '普通',
      char: '~',
      enabled: false,
      isEmote: false,
      now: t0 + 1500,
    })
    disabledRepeat.settle(true, t0 + 1500)
    expect({ text: disabledRepeat.text, roadRaged: disabledRepeat.roadRaged }).toEqual({
      text: '普通',
      roadRaged: false,
    })

    const enabledAfterDisabled = applyRoadRageOnSend({
      original: '普通',
      processed: '普通',
      char: '~',
      enabled: true,
      isEmote: false,
      now: t0 + 2000,
    })
    enabledAfterDisabled.settle(true, t0 + 2000)
    expect(enabledAfterDisabled.roadRaged).toBe(true)
    expect(enabledAfterDisabled.text).toContain('~')
  })
})
