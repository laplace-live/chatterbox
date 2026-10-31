import { afterEach, describe, expect, test } from 'bun:test'

import { DEFAULT_DANMAKU_MAX_UNITS } from './const'
import {
  applyGetInfoByUserDanmakuLength,
  cachedRoomId,
  danmakuMaxChars,
  danmakuMaxUnits,
  extractDanmakuMaxUnits,
  resetRoomDanmakuLimits,
  resolveAutoSendMaxUnits,
  roomDanmakuChars,
  roomDanmakuUnits,
} from './danmaku-limit'

afterEach(() => {
  resetRoomDanmakuLimits()
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

  test('isolates caps per room so older overlapping responses and room switches never leak across rooms', () => {
    cachedRoomId.value = 222
    applyGetInfoByUserDanmakuLength(
      { code: 0, data: { property: { danmu: { length: 80, room_id: 222 } } } },
      { url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=222' }
    )
    expect(roomDanmakuUnits.value).toBe(80)

    // Out-of-order response and -101 for room 111 must not overwrite or clear active room 222.
    applyGetInfoByUserDanmakuLength(
      { code: 0, data: { property: { danmu: { length: 40, room_id: 111 } } } },
      { url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=111' }
    )
    expect(roomDanmakuUnits.value).toBe(80)
    applyGetInfoByUserDanmakuLength(
      { code: -101, message: '账号未登录' },
      { url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=111' }
    )
    expect(roomDanmakuUnits.value).toBe(80)

    // Switching to room 333 whose getInfoByUser was missed or malformed resets to null (default 80) instead of keeping room 222's cap.
    cachedRoomId.value = 333
    applyGetInfoByUserDanmakuLength(
      { code: 0, data: {} },
      { url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=333' }
    )
    expect(roomDanmakuUnits.value).toBeNull()
    expect(danmakuMaxUnits.value).toBe(DEFAULT_DANMAKU_MAX_UNITS)
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
