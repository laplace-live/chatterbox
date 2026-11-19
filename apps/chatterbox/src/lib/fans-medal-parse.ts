import type { FansMedal } from '../types'

import { isRecord, readPath } from './utils'

function toInt(raw: unknown, fallback = 0): number {
  const n = Number(raw)
  return Number.isFinite(n) ? Math.floor(n) : fallback
}

function toFlag(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === '1'
}

// B站's own fallbacks for a medal without `v2_medal_color_*`.
const DEFAULT_MEDAL_FILL = 'rgba(151, 158, 189, 0.8)'
const DEFAULT_MEDAL_TEXT = '#FFFFFF'

function readColor(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && raw ? raw : fallback
}

/** B站's v2 medal colors (`#RRGGBBAA`; unlit medals come back grey), as its own renderer reads them. */
function readMedalColors(
  medal: Record<string, unknown>
): Pick<FansMedal, 'colorStart' | 'colorEnd' | 'colorBorder' | 'colorText'> {
  return {
    colorStart: readColor(medal.v2_medal_color_start, DEFAULT_MEDAL_FILL),
    colorEnd: readColor(medal.v2_medal_color_end, DEFAULT_MEDAL_FILL),
    colorBorder: readColor(medal.v2_medal_color_border, DEFAULT_MEDAL_FILL),
    colorText: readColor(medal.v2_medal_color_text, DEFAULT_MEDAL_TEXT),
  }
}

/** Normalize a `fansMedal/panel` item (`{ medal, anchor_info, room_info }`) or legacy flat payload. */
export function normalizeFansMedal(raw: unknown): FansMedal | null {
  if (!isRecord(raw)) return null
  const medal = isRecord(raw.medal) ? raw.medal : raw
  const anchor = isRecord(raw.anchor_info) ? raw.anchor_info : raw
  const room = isRecord(raw.room_info) ? raw.room_info : isRecord(raw.roominfo) ? raw.roominfo : raw

  const medalId = toInt(medal.medal_id ?? medal.id)
  const medalName = typeof medal.medal_name === 'string' ? medal.medal_name.trim() : ''
  if (medalId <= 0 || !medalName) return null

  const rawLighted = medal.is_lighted ?? medal.is_light ?? raw.is_lighted

  return {
    medalId,
    medalName,
    level: Math.max(0, toInt(medal.level)),
    targetId: toInt(medal.target_id ?? anchor.uid),
    targetName:
      (typeof anchor.nick_name === 'string' && anchor.nick_name.trim()) ||
      (typeof raw.target_name === 'string' && raw.target_name.trim()) ||
      (typeof raw.uname === 'string' && raw.uname.trim()) ||
      '',
    roomId: toInt(room.room_id ?? raw.roomid),
    ...readMedalColors(medal),
    isLighted: rawLighted === undefined ? true : toFlag(rawLighted),
    guardLevel: toInt(medal.guard_level ?? raw.guard_level),
    todayFeed: toInt(medal.today_feed ?? raw.today_feed ?? raw.intimacy),
    dayLimit: toInt(medal.day_limit ?? raw.day_limit),
  }
}

function normalizeV2OrRoomMedal(raw: unknown): FansMedal | null {
  if (!isRecord(raw) || Array.isArray(raw)) return null
  const medalName =
    (typeof raw.name === 'string' && raw.name.trim()) ||
    (typeof raw.medal_name === 'string' && raw.medal_name.trim()) ||
    ''
  if (!medalName) return null

  const medalId = toInt(raw.id ?? raw.medal_id)
  const targetId = toInt(raw.ruid ?? raw.target_id)
  const level = Math.max(0, toInt(raw.level))
  if (medalId <= 0 && targetId <= 0 && level <= 0) return null

  const rawLighted = raw.is_light ?? raw.is_lighted

  return {
    medalId,
    medalName,
    level,
    targetId,
    targetName:
      (typeof raw.target_name === 'string' && raw.target_name.trim()) ||
      (typeof raw.uname === 'string' && raw.uname.trim()) ||
      '',
    roomId: toInt(raw.target_roomid ?? raw.roomid ?? raw.room_id),
    ...readMedalColors(raw),
    isLighted: rawLighted === undefined ? true : toFlag(rawLighted),
    guardLevel: toInt(raw.guard_level),
    todayFeed: toInt(raw.today_feed),
    dayLimit: toInt(raw.day_limit),
  }
}

/** True when two medal records represent the same fans medal (falls back to `targetId` when `curr_weared_v2` omits `id`). */
export function isSameFansMedal(a: FansMedal | null, b: FansMedal | null): boolean {
  if (!a || !b) return false
  if (a.medalId > 0 && b.medalId > 0) return a.medalId === b.medalId
  if (a.targetId > 0 && b.targetId > 0) return a.targetId === b.targetId
  return a.medalName === b.medalName
}

export interface ParsedRoomMedalInfo {
  displayed: FansMedal | null
  /** Undefined when absent from payload; `null` when explicitly unworn. */
  weared?: FansMedal | null
}

/** Parse `getInfoByUser` `data.medal` into room-displayed (`curr_show`) and globally worn (`curr_weared_v2`) medals. */
export function parseGetInfoByUserMedal(payload: unknown): ParsedRoomMedalInfo | null {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data) || !isRecord(payload.data.medal)) return null

  const medalObj = payload.data.medal
  const currWearedMeta = normalizeV2OrRoomMedal(medalObj.curr_weared)

  let displayed: FansMedal | null
  if ('curr_show' in medalObj) {
    const parsedShow = normalizeV2OrRoomMedal(medalObj.curr_show)
    displayed =
      parsedShow && currWearedMeta && isSameFansMedal(parsedShow, currWearedMeta)
        ? {
            ...parsedShow,
            targetName: parsedShow.targetName || currWearedMeta.targetName,
            roomId: parsedShow.roomId || currWearedMeta.roomId,
            todayFeed: parsedShow.todayFeed || currWearedMeta.todayFeed,
            dayLimit: parsedShow.dayLimit || currWearedMeta.dayLimit,
          }
        : parsedShow
  } else {
    const hasWorn = medalObj.is_weared !== false && medalObj.is_weared !== 0
    displayed = hasWorn ? currWearedMeta : null
  }

  let weared: FansMedal | null | undefined
  if ('curr_weared_v2' in medalObj) {
    if (medalObj.is_weared === false || medalObj.is_weared === 0) {
      weared = null
    } else {
      weared = normalizeV2OrRoomMedal(medalObj.curr_weared_v2)
    }
  }

  return { displayed, weared }
}

/** Merge medal arrays by `medalId`, keeping first-seen order and replacing duplicates with newer entries. */
export function mergeFansMedals(existing: readonly FansMedal[], incoming: readonly FansMedal[]): FansMedal[] {
  const byId = new Map<number, FansMedal>()
  for (const item of existing) byId.set(item.medalId, item)
  for (const item of incoming) byId.set(item.medalId, item)
  return [...byId.values()]
}

/** Bilibili's `message` (or `msg`) error text; empty when absent. */
export function readBilibiliMessage(payload: unknown): string {
  for (const key of ['message', 'msg']) {
    const text = readPath(payload, key)
    if (typeof text === 'string' && text) return text
  }
  return ''
}

function isWornPanelEntry(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const medal = isRecord(raw.medal) ? raw.medal : raw
  return toFlag(medal.wearing_status ?? raw.wearing_status ?? medal.is_used ?? raw.is_used)
}

export interface ParsedFansMedalPanel {
  medals: FansMedal[]
  total: number
  hasMore: boolean
  weared: FansMedal | null
}

/** Parse `fansMedal/panel` JSON into a deduplicated medal list and pagination metadata. */
export function parseFansMedalPanelResponse(payload: unknown): ParsedFansMedalPanel {
  if (!isRecord(payload) || payload.code !== 0 || !isRecord(payload.data)) {
    throw new Error(readBilibiliMessage(payload) || '获取粉丝牌失败')
  }
  const data = payload.data
  const rawSpecial = Array.isArray(data.special_list) ? data.special_list : []
  const rawList = Array.isArray(data.list) ? data.list : []
  const parsed: FansMedal[] = []
  // Later duplicates win, matching `mergeFansMedals`.
  const wornById = new Map<number, boolean>()
  for (const entry of [...rawSpecial, ...rawList]) {
    const medal = normalizeFansMedal(entry)
    if (!medal) continue
    parsed.push(medal)
    wornById.set(medal.medalId, isWornPanelEntry(entry))
  }
  const medals = mergeFansMedals([], parsed)
  const weared = medals.find(m => wornById.get(m.medalId)) ?? null
  const pageInfo = isRecord(data.page_info) ? data.page_info : null
  const currentPage = toInt(pageInfo?.current_page, 1)
  const totalPage = toInt(pageInfo?.total_page, 1)
  const total = toInt(data.total_number ?? data.count ?? pageInfo?.total, medals.length)
  const hasMore = Boolean(pageInfo?.has_more) || currentPage < totalPage
  return { medals, total, hasMore, weared }
}
