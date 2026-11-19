import { describe, expect, it } from 'bun:test'
import * as signals from '@preact/signals'

import * as constants from './const'
import * as danmakuLimit from './danmaku-limit'
import * as medalParse from './fans-medal-parse'
import {
  applyWearedMedal,
  formatMedalColor,
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
    .replace(/export\s*\{[^}]+\}\s*from\s*["'][^"']+["'];?/g, '')
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
      if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
      return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
    })
  const code = `const { fetch } = globalThis[${JSON.stringify(key)}];\n${js}`
  try {
    return (await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )) as typeof import('./fans-medal')
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

function mustNormalize(raw: unknown) {
  const medal = normalizeFansMedal(raw)
  if (!medal) throw new Error('Expected valid medal fixture')
  return medal
}

describe('formatMedalColor', () => {
  it('formats decimal RGB numbers and 6/8-digit hex strings into #rrggbb[aa]', () => {
    expect(formatMedalColor(6130680)).toBe('#5d8bf8')
    expect(formatMedalColor(0)).toBe('#000000')
    expect(formatMedalColor('#FF6699')).toBe('#FF6699')
    expect(formatMedalColor('#3FB4F699')).toBe('#3FB4F699')
    expect(formatMedalColor('3FB4F699')).toBe('#3FB4F699')
    expect(formatMedalColor('36a185')).toBe('#36a185')
    expect(formatMedalColor(null, '#123456')).toBe('#123456')
  })
})

describe('normalizeFansMedal', () => {
  it('normalizes nested fansMedal/panel entries', () => {
    const medal = normalizeFansMedal({
      medal: {
        medal_id: 101,
        medal_name: '测试牌',
        level: 24,
        target_id: 999,
        medal_color_start: 16737945,
        medal_color_end: 6130680,
        medal_color_border: 16737945,
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
      colorStart: '#ff6699',
      colorEnd: '#5d8bf8',
      colorBorder: '#ff6699',
      isLighted: true,
      wearingStatus: true,
      guardLevel: 3,
      todayFeed: 120,
      dayLimit: 1500,
    })
  })

  it('falls back from zero medal_color_start to medal_color and handles is_used / omitted is_lighted', () => {
    const medal = normalizeFansMedal({
      medal: {
        medal_id: 303,
        medal_name: '备用色',
        level: 6,
        medal_color_start: 0,
        medal_color_end: 0,
        medal_color_border: 0,
        medal_color: '#83c5be',
        is_used: 1,
      },
    })
    expect(medal?.colorStart).toBe('#83c5be')
    expect(medal?.colorEnd).toBe('#83c5be')
    expect(medal?.colorBorder).toBe('#83c5be')
    expect(medal?.wearingStatus).toBe(true)
    expect(medal?.isLighted).toBe(true)
  })

  it('falls back to default medal color when both medal_color_start and medal_color are 0', () => {
    const medal = normalizeFansMedal({
      medal: {
        medal_id: 404,
        medal_name: '默认蓝',
        level: 3,
        medal_color_start: 0,
        medal_color_end: 0,
        medal_color_border: 0,
        medal_color: 0,
      },
    })
    expect(medal?.colorStart).toBe('#5896de')
    expect(medal?.colorEnd).toBe('#5896de')
    expect(medal?.colorBorder).toBe('#5896de')
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
      colorStart: '#06154c',
      colorEnd: '#6888f1',
      colorBorder: '#06154c',
      isLighted: true,
      wearingStatus: false,
      guardLevel: 0,
      todayFeed: 0,
      dayLimit: 20000,
    })
    expect(parsed?.weared).toMatchObject({
      medalId: 0,
      medalName: '奶糖花',
      level: 27,
      targetId: 2132180406,
      colorBorder: '#67e8ff',
      guardLevel: 3,
      wearingStatus: true,
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

  it('falls back to v2_medal_color_* when v1 decimal colors are absent, and handles legacy payloads and error codes', () => {
    const v2Only = parseGetInfoByUserMedal({
      code: 0,
      data: {
        medal: {
          curr_show: {
            name: 'V2色',
            level: 5,
            id: 77,
            ruid: 88,
            color_start: 0,
            color_end: 0,
            color_border: 0,
            color: 0,
            v2_medal_color_start: '#3FB4F699',
            v2_medal_color_end: '#5FC7F4',
            v2_medal_color_border: '#123456',
          },
        },
      },
    })
    expect(v2Only?.displayed?.colorStart).toBe('#3FB4F699')
    expect(v2Only?.displayed?.colorEnd).toBe('#5FC7F4')
    expect(v2Only?.displayed?.colorBorder).toBe('#123456')

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

    expect(parseGetInfoByUserMedal({ code: -101, message: '未登录' })).toEqual({ displayed: null, weared: null })
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

describe('isSameFansMedal, applyWearedMedal & room-keyed display', () => {
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
    expect(applyWearedMedal([rich, other], v2Worn ?? null).map(m => m.wearingStatus)).toEqual([true, false])
    expect(applyWearedMedal([rich, other], null).map(m => m.wearingStatus)).toEqual([false, false])
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

      // -101 clears room-displayed and worn medal.
      medalRoom.applyGetInfoByUserMedal({ code: -101, message: '未登录' }, { roomId: 99999 })
      expect(medalRoom.roomDisplayedMedal.peek()).toBeNull()
      expect(medalRoom.wearedMedal.peek()).toBeNull()
    } finally {
      medalRoom.resetRoomDisplayedMedals()
      danmakuLimit.resetRoomDanmakuLimits()
    }
  })
})

describe('fansMedalPanel, wear/takeOff & fetchRoomDisplayedMedal', () => {
  it('populates empty page-1 list reconciled with wearedMedal if takeOff runs mid-fetch, and drops stale refresh when non-empty', async () => {
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

    expect(mod.fansMedalList.value.map(m => [m.medalId, m.wearingStatus])).toEqual([
      [10, false],
      [20, false],
    ])
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
    expect(nextMod.fansMedalList.value.map(m => m.wearingStatus)).toEqual([false])
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
    const initialDisplayed = await mod.fetchRoomDisplayedMedal(81004)
    expect(initialDisplayed?.medalName).toBe('艾薯条')
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
    await Promise.resolve()
    await Promise.resolve()
    expect(medalRoom.wearedMedal.value?.medalName).toBe('新牌')
    expect(medalRoom.roomDisplayedMedal.value?.medalName).toBe('艾薯条')

    // Taking off global medal also refreshes curr_show from Bilibili.
    nextIsWeared = false
    nextCurrWearedV2 = null
    nextCurrShow = null
    expect(await mod.takeOffFansMedal()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
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
    const slow = mod.fetchRoomDisplayedMedal(81004)
    const fast = mod.fetchRoomDisplayedMedal(81004)
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
})
