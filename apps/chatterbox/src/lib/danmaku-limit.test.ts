import { afterEach, describe, expect, test } from 'bun:test'

import { DEFAULT_DANMAKU_MAX_UNITS } from './const'
import {
  applyGetInfoByUserDanmakuLength,
  danmakuMaxChars,
  danmakuMaxUnits,
  extractDanmakuMaxUnits,
  resolveAutoSendMaxUnits,
  roomDanmakuChars,
  roomDanmakuUnits,
} from './danmaku-limit'

afterEach(() => {
  roomDanmakuUnits.value = null
})

describe('extractDanmakuMaxUnits & applyGetInfoByUserDanmakuLength', () => {
  test('falls back to 80 units (40 字) before resolution and converts getInfoByUser units to 字 for UI', () => {
    expect(danmakuMaxUnits.value).toBe(DEFAULT_DANMAKU_MAX_UNITS)
    expect(danmakuMaxChars.value).toBe(40)
    expect(roomDanmakuChars.value).toBeNull()

    applyGetInfoByUserDanmakuLength({
      code: 0,
      data: { property: { danmu: { mode: 1, color: 16777215, length: 80 } } },
    })
    expect(roomDanmakuUnits.value).toBe(80)
    expect(roomDanmakuChars.value).toBe(40)
    expect(danmakuMaxUnits.value).toBe(80)
    expect(danmakuMaxChars.value).toBe(40)

    applyGetInfoByUserDanmakuLength({ code: 0, data: { property: { danmu: { length: 60 } } } })
    expect(danmakuMaxUnits.value).toBe(60)
    expect(danmakuMaxChars.value).toBe(30)
  })

  test('clears a stale logged-in cap on code -101, while ignoring malformed payloads', () => {
    applyGetInfoByUserDanmakuLength({ code: 0, data: { property: { danmu: { length: 40 } } } })
    expect(danmakuMaxUnits.value).toBe(40)
    expect(danmakuMaxChars.value).toBe(20)

    expect(extractDanmakuMaxUnits({ code: 0, data: { property: { danmu: { length: 0 } } } })).toBeNull()
    expect(extractDanmakuMaxUnits({ code: -400, data: { property: { danmu: { length: 80 } } } })).toBeNull()
    applyGetInfoByUserDanmakuLength({ code: 0, data: {} })
    expect(danmakuMaxUnits.value).toBe(40)

    applyGetInfoByUserDanmakuLength({ code: -101, message: '账号未登录' })
    expect(roomDanmakuUnits.value).toBeNull()
    expect(roomDanmakuChars.value).toBeNull()
    expect(danmakuMaxUnits.value).toBe(DEFAULT_DANMAKU_MAX_UNITS)
    expect(danmakuMaxChars.value).toBe(40)
  })
})

describe('resolveAutoSendMaxUnits', () => {
  test('uses detected room units (or 80-unit default) when override is unset or invalid', () => {
    expect(resolveAutoSendMaxUnits(null, 80)).toBe(80)
    expect(resolveAutoSendMaxUnits(null, 40)).toBe(40)
    expect(resolveAutoSendMaxUnits(null, null)).toBe(DEFAULT_DANMAKU_MAX_UNITS)
    expect(resolveAutoSendMaxUnits(0, 80)).toBe(80)
    expect(resolveAutoSendMaxUnits(Number.NaN, 60)).toBe(60)
  })

  test('converts user 字 override to half-width units and clamps to the known room unit cap', () => {
    expect(resolveAutoSendMaxUnits(25, 80)).toBe(50)
    expect(resolveAutoSendMaxUnits(50, 60)).toBe(60)
    expect(resolveAutoSendMaxUnits(50, 120)).toBe(100)
    // Escape hatch: if room detection ever fails (null), explicit user override still takes effect.
    expect(resolveAutoSendMaxUnits(50, null)).toBe(100)
  })
})
