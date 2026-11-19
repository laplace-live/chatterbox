import { describe, expect, it } from 'bun:test'
import * as signals from '@preact/signals'

import * as constants from './const'
import * as danmakuLimit from './danmaku-limit'
import * as medalParse from './fans-medal-parse'
import {
  isSameFansMedal,
  mergeFansMedals,
  normalizeFansMedal,
  parseFansMedalPanelResponse,
  parseGetInfoByUserMedal,
} from './fans-medal-parse'
import * as medalRoom from './fans-medal-room'
import * as utils from './utils'

const fansMedalSource = await Bun.file(new URL('./fans-medal.ts', import.meta.url)).text()
let medalModuleId = 0

async function loadFansMedal(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  medalRoom.resetRoomDisplayedMedals()
  danmakuLimit.resetRoomDanmakuLimits()
  const storeMock = {
    cachedRoomId: danmakuLimit.cachedRoomId,
    cachedStreamerUid: signals.signal<number | null>(null),
  }
  const dependencies: Record<string, unknown> = {
    '@preact/signals': signals,
    './api': { getCsrfToken: () => 'csrf', getSpmPrefix: () => '444.8' },
    './const': constants,
    './fans-medal-parse': medalParse,
    './fans-medal-room': medalRoom,
    './log': { appendLog: () => {} },
    './store': storeMock,
    './utils': utils,
    './wbi': { cachedWbiKeys: null, encodeWbi: () => '' },
  }
  const key = `__fansMedalTest${++medalModuleId}`
  Reflect.set(globalThis, key, { fetch: fetchImpl, dependencies })
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(fansMedalSource)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
      if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
      return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
    })
  const code = `const { fetch } = globalThis[${JSON.stringify(key)}];\n${js}`
  try {
    const mod: typeof import('./fans-medal') = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )
    return mod
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

function mustNormalize(raw: unknown) {
  const medal = normalizeFansMedal(raw)
  if (!medal) throw new Error('Expected valid medal fixture')
  return medal
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 1))
  }
}

describe('normalizeFansMedal', () => {
  it('normalizes nested fansMedal/panel entries with B站 v2 colors, ignoring the legacy decimal ones', () => {
    const medal = normalizeFansMedal({
      medal: {
        medal_id: 101,
        medal_name: '测试牌',
        level: 24,
        target_id: 999,
        medal_color_start: 16737945,
        medal_color_end: 6130680,
        medal_color_border: 16737945,
        v2_medal_color_start: '#C770A499',
        v2_medal_color_end: '#C770A499',
        v2_medal_color_border: '#C770A499',
        v2_medal_color_text: '#FFFFFFFF',
        v2_medal_color_level: '#6C004799',
        is_lighted: 1,
        wearing_status: 1,
        guard_level: 3,
        today_feed: 120,
        day_limit: 1500,
      },
      anchor_info: { nick_name: '某主播' },
      room_info: { room_id: 777 },
    })

    expect(medal).toEqual({
      medalId: 101,
      medalName: '测试牌',
      level: 24,
      targetId: 999,
      targetName: '某主播',
      roomId: 777,
      colorStart: '#C770A499',
      colorEnd: '#C770A499',
      colorBorder: '#C770A499',
      colorText: '#FFFFFFFF',
      isLighted: true,
      guardLevel: 3,
      todayFeed: 120,
      dayLimit: 1500,
    })
  })

  it("falls back to B站's default colors without v2 ones and handles is_used / omitted is_lighted", () => {
    const entry = {
      medal: {
        medal_id: 303,
        medal_name: '备用色',
        level: 6,
        medal_color_start: 12632256,
        v2_medal_color_start: '',
        is_used: 1,
      },
    }
    const medal = normalizeFansMedal(entry)
    expect(medal).toMatchObject({
      colorStart: 'rgba(151, 158, 189, 0.8)',
      colorEnd: 'rgba(151, 158, 189, 0.8)',
      colorBorder: 'rgba(151, 158, 189, 0.8)',
      colorText: '#FFFFFF',
      isLighted: true,
    })
    expect(parseFansMedalPanelResponse({ code: 0, data: { list: [entry] } }).weared?.medalId).toBe(303)
  })
})

describe('parseGetInfoByUserMedal', () => {
  const realGetInfoPayload = {
    code: 0,
    data: {
      property: { danmu: { room_id: 81004, length: 60 } },
      medal: {
        cnt: 66,
        is_weared: true,
        curr_weared: {
          target_id: 1521415,
          target_name: '艾尔莎_Channel',
          medal_name: '艾薯条',
          target_roomid: 81004,
          level: 27,
          day_limit: 20000,
          today_feed: 0,
          medal_color_start: 398668,
          medal_color_end: 6850801,
          medal_color_border: 398668,
          is_lighted: 1,
          guard_level: 0,
        },
        curr_weared_v2: {
          name: '奶糖花',
          level: 27,
          color_start: 398668,
          color_end: 6850801,
          color_border: 6809855,
          color: 398668,
          id: 0,
          is_light: 1,
          ruid: 2132180406,
          guard_level: 3,
          v2_medal_color_start: '#BE4960CC',
          v2_medal_color_end: '#BE4960CC',
          v2_medal_color_border: '#F18087FF',
          v2_medal_color_text: '#FFFFFFFF',
        },
        curr_show: {
          name: '艾薯条',
          level: 27,
          color_start: 398668,
          color_end: 6850801,
          color_border: 398668,
          color: 398668,
          id: 510698,
          is_light: 1,
          ruid: 1521415,
          guard_level: 0,
          v2_medal_color_start: '#3FB4F699',
          v2_medal_color_end: '#3FB4F699',
          v2_medal_color_border: '#3FB4F699',
          v2_medal_color_text: '#FFFFFFFF',
        },
      },
    },
  }

  it('parses room-displayed curr_show and globally worn curr_weared_v2 separately', () => {
    const parsed = parseGetInfoByUserMedal(realGetInfoPayload)
    expect(parsed?.displayed).toEqual({
      medalId: 510698,
      medalName: '艾薯条',
      level: 27,
      targetId: 1521415,
      targetName: '艾尔莎_Channel',
      roomId: 81004,
      colorStart: '#3FB4F699',
      colorEnd: '#3FB4F699',
      colorBorder: '#3FB4F699',
      colorText: '#FFFFFFFF',
      isLighted: true,
      guardLevel: 0,
      todayFeed: 0,
      dayLimit: 20000,
    })
    expect(parsed?.weared).toMatchObject({
      medalId: 0,
      medalName: '奶糖花',
      level: 27,
      targetId: 2132180406,
      colorBorder: '#F18087FF',
      guardLevel: 3,
    })
  })

  it('keeps displayed null when curr_show is null or empty even if curr_weared_v2 is set', () => {
    const parsed = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          is_weared: true,
          curr_show: null,
          curr_weared_v2: {
            name: '奶糖花',
            level: 27,
            color_start: 398668,
            ruid: 2132180406,
            is_light: 1,
          },
        },
      },
    })
    expect(parsed?.displayed).toBeNull()
    expect(parsed?.weared?.medalName).toBe('奶糖花')

    const emptyShow = parseGetInfoByUserMedal({
      code: 0,
      data: { medal: { is_weared: false, curr_show: {}, curr_weared_v2: {} } },
    })
    expect(emptyShow).toEqual({ displayed: null, weared: null })
  })

  it('reads only v2 colors, falls back for legacy payloads, and handles error codes', () => {
    const unlit = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          curr_show: {
            name: '未点亮',
            level: 11,
            id: 77,
            ruid: 88,
            color_start: 12632256,
            color_end: 12632256,
            color_border: 12632256,
            is_light: 0,
            v2_medal_color_start: '#919298CC',
            v2_medal_color_end: '#919298CC',
            v2_medal_color_border: '#919298CC',
            v2_medal_color_text: '#FFFFFFFF',
          },
        },
      },
    })
    expect(unlit?.displayed).toMatchObject({ colorStart: '#919298CC', colorBorder: '#919298CC', isLighted: false })

    const legacy = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          is_weared: true,
          curr_weared: { target_id: 42, medal_name: '旧字段', level: 15, target_roomid: 9001 },
        },
      },
    })
    expect(legacy?.displayed?.medalName).toBe('旧字段')
    expect(legacy?.displayed?.roomId).toBe(9001)
    expect(legacy?.displayed?.colorStart).toBe('rgba(151, 158, 189, 0.8)')
    expect(legacy?.weared).toBeUndefined()

    const blankName = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          curr_show: { name: '', medal_name: '兜底名', level: 5, target_id: 123 },
        },
      },
    })
    expect(blankName?.displayed?.medalName).toBe('兜底名')

    expect(parseGetInfoByUserMedal({ code: -400, message: 'bad request' })).toBeNull()
  })
})

describe('parseFansMedalPanelResponse', () => {
  it('deduplicates special_list and list and detects worn medal and pagination', () => {
    const parsed = parseFansMedalPanelResponse({
      code: 0,
      data: {
        total_number: 3,
        page_info: { current_page: 1, total_page: 2 },
        special_list: [
          {
            medal: { medal_id: 1, medal_name: '一', level: 21, wearing_status: 1, is_lighted: 1 },
            anchor_info: { nick_name: 'A' },
          },
        ],
        list: [
          {
            medal: { medal_id: 1, medal_name: '一', level: 21, wearing_status: 1, is_lighted: 1 },
            anchor_info: { nick_name: 'A' },
          },
          {
            medal: { medal_id: 2, medal_name: '二', level: 8, wearing_status: 0, is_lighted: 0 },
            anchor_info: { nick_name: 'B' },
          },
        ],
      },
    })

    expect(parsed.medals.map(m => m.medalId)).toEqual([1, 2])
    expect(parsed.weared?.medalId).toBe(1)
    expect(parsed.total).toBe(3)
    expect(parsed.hasMore).toBe(true)

    const merged = mergeFansMedals(parsed.medals, [
      { ...parsed.medals[1], level: 9 },
      { ...parsed.medals[0], medalId: 3, medalName: '三' },
    ])
    expect(merged.map(m => [m.medalId, m.level])).toEqual([
      [1, 21],
      [2, 9],
      [3, 21],
    ])
  })

  it('throws message or msg when code is non-zero', () => {
    expect(() => parseFansMedalPanelResponse({ code: -101, message: '未登录' })).toThrow('未登录')
    expect(() => parseFansMedalPanelResponse({ code: -400, msg: '参数错误' })).toThrow('参数错误')
    expect(() => parseFansMedalPanelResponse({ code: -1 })).toThrow('获取粉丝牌失败')
  })
})

describe('isSameFansMedal & room-keyed display', () => {
  it('matches by medalId first and falls back to targetId when curr_weared_v2 omits id', () => {
    const rich = mustNormalize({ medal: { medal_id: 500, target_id: 2132180406, medal_name: '奶糖花', level: 27 } })
    const other = mustNormalize({ medal: { medal_id: 510698, target_id: 1521415, medal_name: '艾薯条', level: 27 } })
    const v2Worn = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          is_weared: true,
          curr_show: null,
          curr_weared_v2: { name: '奶糖花', level: 27, id: 0, ruid: 2132180406 },
        },
      },
    })?.weared
    expect(v2Worn).toBeTruthy()
    expect(isSameFansMedal(rich, v2Worn ?? null)).toBe(true)
    expect(isSameFansMedal(other, v2Worn ?? null)).toBe(false)
  })

  it('tracks displayed medals per room, ignores target_roomid as room key, and keeps rich wearedMedal id', () => {
    medalRoom.resetRoomDisplayedMedals()
    danmakuLimit.resetRoomDanmakuLimits()
    try {
      const richWorn = mustNormalize({
        medal: { medal_id: 9001, target_id: 2132180406, medal_name: '奶糖花', level: 27, wearing_status: 1 },
      })
      medalRoom.wearedMedal.value = richWorn

      medalRoom.applyGetInfoByUserMedal(
        {
          code: 0,
          data: {
            medal: {
              is_weared: true,
              curr_weared: { target_id: 1521415, medal_name: '艾薯条', target_roomid: 81004, level: 27 },
              curr_weared_v2: { name: '奶糖花', level: 27, id: 0, ruid: 2132180406 },
              curr_show: { name: '艾薯条', level: 27, id: 510698, ruid: 1521415 },
            },
          },
        },
        { url: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByUser?room_id=99999&from=0' }
      )

      danmakuLimit.cachedRoomId.value = 99999
      expect(medalRoom.roomDisplayedMedalKnown.peek()).toBe(true)
      expect(medalRoom.roomDisplayedMedal.peek()?.medalName).toBe('艾薯条')
      // Rich medalId must not be overwritten by curr_weared_v2's id=0 for the same medal.
      expect(medalRoom.wearedMedal.peek()?.medalId).toBe(9001)

      // Switching to another room whose target_roomid was only in curr_weared does not reuse room 99999's entry.
      danmakuLimit.cachedRoomId.value = 81004
      expect(medalRoom.roomDisplayedMedalKnown.peek()).toBe(false)
      expect(medalRoom.roomDisplayedMedal.peek()).toBeNull()

      // Transient error does not overwrite recorded state.
      danmakuLimit.cachedRoomId.value = 99999
      medalRoom.applyGetInfoByUserMedal({ code: -400, message: 'bad' }, { roomId: 99999 })
      expect(medalRoom.roomDisplayedMedal.peek()?.medalName).toBe('艾薯条')
    } finally {
      medalRoom.resetRoomDisplayedMedals()
      danmakuLimit.resetRoomDanmakuLimits()
    }
  })
})

describe('fansMedalPanel, wear/takeOff & fetchRoomDisplayedMedal', () => {
  it('fills an empty page-1 list without reviving wearedMedal if takeOff runs mid-fetch, and drops a stale refresh when non-empty', async () => {
    let resolvePanel!: (resp: Response) => void
    const mod = await loadFansMedal(url => {
      if (url.includes('fansMedal/panel')) {
        return new Promise<Response>(r => {
          resolvePanel = r
        })
      }
      return Promise.resolve(Response.json({ code: 0, data: {} }))
    })

    const initialWorn = mustNormalize({
      medal: { medal_id: 10, medal_name: '牌A', level: 12, wearing_status: 1 },
    })
    medalRoom.wearedMedal.value = initialWorn

    const firstFetch = mod.fetchFansMedalPanel(1)
    expect(await mod.takeOffFansMedal()).toBe(true)
    expect(medalRoom.wearedMedal.value).toBeNull()

    resolvePanel(
      Response.json({
        code: 0,
        data: {
          total_number: 2,
          page_info: { current_page: 1, total_page: 2 },
          special_list: [{ medal: { medal_id: 10, medal_name: '牌A', level: 12, wearing_status: 1 } }],
          list: [{ medal: { medal_id: 20, medal_name: '牌B', level: 3, wearing_status: 0 } }],
        },
      })
    )
    await firstFetch

    expect(mod.fansMedalList.value.map(m => m.medalId)).toEqual([10, 20])
    expect(medalRoom.wearedMedal.value).toBeNull()
    expect(mod.fansMedalTotal.value).toBe(2)
    expect(mod.fansMedalHasMore.value).toBe(true)

    const nextMod = await loadFansMedal(url => {
      if (url.includes('fansMedal/panel')) {
        return new Promise<Response>(r => {
          resolvePanel = r
        })
      }
      return Promise.resolve(Response.json({ code: 0, data: {} }))
    })
    nextMod.fansMedalList.value = [initialWorn]
    const refresh = nextMod.fetchFansMedalPanel(1)
    await nextMod.takeOffFansMedal()
    resolvePanel(
      Response.json({
        code: 0,
        data: {
          total_number: 1,
          page_info: { current_page: 1, total_page: 1 },
          special_list: [],
          list: [{ medal: { medal_id: 10, medal_name: '牌A', level: 12, wearing_status: 1 } }],
        },
      })
    )
    await refresh
    // Applying the raced page would have re-worn 牌A.
    expect(medalRoom.wearedMedal.value).toBeNull()
    expect(nextMod.fansMedalList.value).toEqual([initialWorn])
  })

  it('keeps roomDisplayedMedal decoupled from fansMedalPanel and refreshes it via getInfoByUser on wear/takeOff', async () => {
    const requestedUrls: string[] = []
    let nextIsWeared = true
    let nextCurrShow: Record<string, unknown> | null = {
      name: '艾薯条',
      level: 27,
      id: 510698,
      ruid: 1521415,
    }
    let nextCurrWearedV2: Record<string, unknown> | null = {
      name: '奶糖花',
      level: 27,
      id: 0,
      ruid: 2132180406,
    }
    const mod = await loadFansMedal(url => {
      requestedUrls.push(url)
      if (url.includes('fansMedal/panel')) {
        return Promise.resolve(
          Response.json({
            code: 0,
            data: {
              total_number: 2,
              page_info: { current_page: 1, total_page: 1 },
              special_list: [
                {
                  medal: { medal_id: 9001, target_id: 2132180406, medal_name: '奶糖花', level: 27, wearing_status: 1 },
                },
              ],
              list: [
                { medal: { medal_id: 510698, target_id: 1521415, medal_name: '艾薯条', level: 27, wearing_status: 0 } },
              ],
            },
          })
        )
      }
      if (url.includes('getInfoByUser')) {
        return Promise.resolve(
          Response.json({
            code: 0,
            data: {
              medal: {
                is_weared: nextIsWeared,
                curr_show: nextCurrShow,
                curr_weared_v2: nextCurrWearedV2,
              },
            },
          })
        )
      }
      return Promise.resolve(Response.json({ code: 0, data: {} }))
    })

    danmakuLimit.cachedRoomId.value = 81004
    await mod.fetchRoomDisplayedMedal()
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('艾薯条')
    expect(requestedUrls.some(u => u.includes('not_mock_enter_effect=1') && u.includes('room_id=81004'))).toBe(true)

    // Opening panel updates global wearedMedal (奶糖花), NOT roomDisplayedMedal (艾薯条).
    await mod.fetchFansMedalPanel(1)
    expect(medalRoom.wearedMedal.value?.medalName).toBe('奶糖花')
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('艾薯条')

    // Wearing another medal triggers getInfoByUser refresh so displayed follows Bilibili's server result
    // (even if curr_show still prioritizes 艾薯条 in this room while curr_weared_v2 switches to 新牌).
    nextCurrWearedV2 = { name: '新牌', level: 10, id: 777, ruid: 333 }
    const otherMedal = mustNormalize({ medal: { medal_id: 777, target_id: 333, medal_name: '新牌', level: 10 } })
    expect(await mod.wearFansMedal(otherMedal)).toBe(true)
    await waitFor(() => requestedUrls.filter(u => u.includes('getInfoByUser')).length >= 2)
    expect(medalRoom.wearedMedal.value?.medalName).toBe('新牌')
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('艾薯条')

    // Taking off global medal also refreshes curr_show from Bilibili.
    nextIsWeared = false
    nextCurrWearedV2 = null
    nextCurrShow = null
    expect(await mod.takeOffFansMedal()).toBe(true)
    await waitFor(() => medalRoom.roomDisplayedMedal.value === null)
    expect(medalRoom.wearedMedal.value).toBeNull()
    expect(medalRoom.roomDisplayedMedal.value).toBeNull()
  })

  it('discards stale fetchRoomDisplayedMedal responses superseded by a later fetch or action', async () => {
    let resolveSlow!: (resp: Response) => void
    let infoCalls = 0
    const mod = await loadFansMedal(url => {
      if (url.includes('getInfoByUser')) {
        infoCalls++
        if (infoCalls === 1) {
          return new Promise<Response>(r => {
            resolveSlow = r
          })
        }
        return Promise.resolve(
          Response.json({
            code: 0,
            data: { medal: { is_weared: false, curr_show: { name: '最新', level: 9, id: 2, ruid: 20 } } },
          })
        )
      }
      return Promise.resolve(Response.json({ code: 0, data: {} }))
    })

    danmakuLimit.cachedRoomId.value = 81004
    const slow = mod.fetchRoomDisplayedMedal()
    const fast = mod.fetchRoomDisplayedMedal()
    await fast
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('最新')

    resolveSlow(
      Response.json({
        code: 0,
        data: { medal: { is_weared: false, curr_show: { name: '过期', level: 1, id: 1, ruid: 10 } } },
      })
    )
    await slow
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('最新')
  })

  it('after a wear/takeOff, lets non-authoritative replies seed only unrecorded rooms', async () => {
    const mod = await loadFansMedal(url => {
      if (url.includes('fansMedal/panel')) {
        return Promise.resolve(
          Response.json({
            code: 0,
            data: {
              total_number: 2,
              page_info: { current_page: 1, total_page: 1 },
              special_list: [],
              list: [
                { medal: { medal_id: 10, target_id: 100, medal_name: '牌A', level: 5, wearing_status: 1 } },
                { medal: { medal_id: 20, target_id: 200, medal_name: '牌B', level: 6, wearing_status: 0 } },
              ],
            },
          })
        )
      }
      if (url.includes('getInfoByUser')) {
        return Promise.resolve(
          Response.json({
            code: 0,
            data: {
              medal: {
                is_weared: true,
                curr_show: { name: '牌B', level: 6, id: 20, ruid: 200 },
                curr_weared_v2: { name: '牌B', level: 6, id: 20, ruid: 200 },
              },
            },
          })
        )
      }
      return Promise.resolve(Response.json({ code: 0, data: {} }))
    })

    danmakuLimit.cachedRoomId.value = 81004
    await mod.fetchFansMedalPanel(1)
    expect(medalRoom.wearedMedal.value?.medalId).toBe(10)

    const wornA = {
      code: 0,
      data: {
        medal: {
          is_weared: true,
          curr_show: { name: '牌A', level: 5, id: 10, ruid: 100 },
          curr_weared_v2: { name: '牌A', level: 5, id: 10, ruid: 100 },
        },
      },
    }
    // B站's own replies count fully until the user changes medals.
    expect(medalRoom.applyGetInfoByUserMedal(wornA, { roomId: 81004 })).toBe('applied')

    const medalB = mustNormalize({ medal: { medal_id: 20, target_id: 200, medal_name: '牌B', level: 6 } })
    expect(await mod.wearFansMedal(medalB)).toBe(true)
    await waitFor(() => medalRoom.roomDisplayedMedal.value?.medalName === '牌B')

    // A late reply for a recorded room may predate the wear.
    expect(medalRoom.applyGetInfoByUserMedal(wornA, { roomId: 81004 })).toBe('stale')
    expect(medalRoom.wearedMedal.value?.medalId).toBe(20)
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('牌B')

    // An in-page room switch still records the new room, but its possibly older worn medal is ignored.
    expect(medalRoom.applyGetInfoByUserMedal(wornA, { roomId: 92000 })).toBe('applied')
    expect(medalRoom.wearedMedal.value?.medalId).toBe(20)
    danmakuLimit.cachedRoomId.value = 92000
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('牌A')

    danmakuLimit.cachedRoomId.value = 81004
    expect(medalRoom.applyGetInfoByUserMedal(wornA, { roomId: 81004, authoritative: true })).toBe('applied')
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('牌A')
    expect(medalRoom.wearedMedal.value?.medalId).toBe(10)
  })

  it('sets fansMedalError when fetchRoomDisplayedMedal fails or returns invalid data, and clears it on success', async () => {
    let mode: 'http500' | 'badcode' | 'ok' = 'http500'
    const mod = await loadFansMedal(() => {
      if (mode === 'http500') return Promise.resolve(new Response('err', { status: 500, statusText: 'Server Error' }))
      if (mode === 'badcode') return Promise.resolve(Response.json({ code: -400, message: '参数错误' }))
      return Promise.resolve(
        Response.json({
          code: 0,
          data: { medal: { is_weared: false, curr_show: { name: '恢复', level: 2, id: 5, ruid: 50 } } },
        })
      )
    })

    danmakuLimit.cachedRoomId.value = 81004
    await mod.fetchRoomDisplayedMedal()
    expect(mod.fansMedalError.value).toContain('HTTP 500')

    mode = 'badcode'
    await mod.fetchRoomDisplayedMedal()
    expect(mod.fansMedalError.value).toContain('参数错误')

    mode = 'ok'
    await mod.fetchRoomDisplayedMedal()
    expect(mod.fansMedalError.value).toBeNull()
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('恢复')
  })

  it('clears loading and acting state when panel or action requests time out', async () => {
    // What `fetch` rejects with once its `AbortSignal.timeout` fires.
    const mod = await loadFansMedal(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')))

    const panelPromise = mod.fetchFansMedalPanel(1)
    expect(mod.fansMedalLoading.value).toBe(true)
    await panelPromise
    expect(mod.fansMedalLoading.value).toBe(false)
    expect(mod.fansMedalError.value).toBe('请求超时')

    const medal = mustNormalize({ medal: { medal_id: 10, target_id: 100, medal_name: '牌A', level: 5 } })
    const wearPromise = mod.wearFansMedal(medal)
    expect(medalRoom.fansMedalActingId.value).toBe(10)
    expect(await wearPromise).toBe(false)
    expect(medalRoom.fansMedalActingId.value).toBeNull()
    expect(mod.fansMedalError.value).toBe('佩戴失败：请求超时')
  })
})
