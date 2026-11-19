import { signal } from '@preact/signals'

import type { FansMedal } from '../types'

import { getCsrfToken, getSpmPrefix } from './api'
import { BASE_URL } from './const'
import { isSameFansMedal, mergeFansMedals, parseFansMedalPanelResponse, readBilibiliMessage } from './fans-medal-parse'
import {
  applyGetInfoByUserMedal,
  fansMedalActingId,
  medalChangeCount,
  noteMedalChange,
  wearedMedal,
} from './fans-medal-room'
import { appendLog } from './log'
import { cachedRoomId, cachedStreamerUid } from './store'
import { readPath } from './utils'
import { cachedWbiKeys, encodeWbi } from './wbi'

const MEDAL_PAGE_SIZE = 50
const ROOM_MEDAL_TIMEOUT_MS = 5000
const MEDAL_ACTION_TIMEOUT_MS = 8000
const ROOM_MEDAL_ERROR_PREFIX = '刷新直播间粉丝牌失败：'

export const fansMedalList = signal<FansMedal[]>([])
export const fansMedalTotal = signal(0)
export const fansMedalPage = signal(0)
export const fansMedalHasMore = signal(false)
export const fansMedalLoading = signal(false)
export const fansMedalError = signal<string | null>(null)

let roomMedalAbort: AbortController | null = null

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return '请求超时'
  return err instanceof Error ? err.message : String(err)
}

/** Refetch the active room's `getInfoByUser` medal state (`curr_show` / `curr_weared_v2`). */
export async function fetchRoomDisplayedMedal(): Promise<void> {
  const roomId = cachedRoomId.value
  if (!roomId || !getCsrfToken()) return

  roomMedalAbort?.abort()
  const controller = new AbortController()
  roomMedalAbort = controller
  try {
    const base = { room_id: String(roomId), from: '0', not_mock_enter_effect: '1' }
    const query = cachedWbiKeys
      ? encodeWbi({ ...base, web_location: getSpmPrefix() }, cachedWbiKeys)
      : new URLSearchParams(base).toString()
    const resp = await fetch(`${BASE_URL.BILIBILI_GET_INFO_BY_USER}?${query}`, {
      method: 'GET',
      credentials: 'include',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ROOM_MEDAL_TIMEOUT_MS)]),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    const json: unknown = await resp.json()
    if (controller.signal.aborted) return
    const status = applyGetInfoByUserMedal(json, { roomId, authoritative: true })
    if (status === 'invalid') throw new Error(readBilibiliMessage(json) || '响应无效')
    if (status === 'applied' && fansMedalError.value?.startsWith(ROOM_MEDAL_ERROR_PREFIX)) {
      fansMedalError.value = null
    }
  } catch (err) {
    // Only the latest request reports; a newer fetch or a wear/take-off supersedes this one.
    if (roomMedalAbort === controller && fansMedalActingId.value === null) {
      fansMedalError.value = `${ROOM_MEDAL_ERROR_PREFIX}${describeError(err)}`
    }
  } finally {
    if (roomMedalAbort === controller) roomMedalAbort = null
  }
}

/** Refetch everything the switcher shows: the first page of owned medals and the room's displayed medal. */
export function refreshFansMedalSwitcher(): void {
  void fetchFansMedalPanel(1)
  void fetchRoomDisplayedMedal()
}

/** Fetch owned fans medals (`page = 1` replaces the list; `page > 1` appends). */
export async function fetchFansMedalPanel(page = 1): Promise<void> {
  if (fansMedalLoading.value) return
  if (!getCsrfToken()) {
    fansMedalError.value = '未找到登录信息，请先登录 Bilibili'
    return
  }
  const changes = medalChangeCount()
  fansMedalLoading.value = true
  fansMedalError.value = null
  try {
    const params = new URLSearchParams({ page: String(page), page_size: String(MEDAL_PAGE_SIZE) })
    if (cachedStreamerUid.value) params.set('target_id', String(cachedStreamerUid.value))
    const resp = await fetch(`${BASE_URL.BILIBILI_FANS_MEDAL_PANEL}?${params}`, {
      method: 'GET',
      credentials: 'include',
      signal: AbortSignal.timeout(MEDAL_ACTION_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    const parsed = parseFansMedalPanelResponse(await resp.json())
    const raced = changes !== medalChangeCount() || fansMedalActingId.value !== null
    // A raced reply may carry stale worn state; still use it to fill an empty first page.
    if (raced && (page > 1 || fansMedalList.value.length > 0)) return
    if (!raced) {
      const current = wearedMedal.value
      if (page > 1) {
        if (!current && parsed.weared) wearedMedal.value = parsed.weared
      } else if (parsed.weared) {
        wearedMedal.value = parsed.weared
      } else if (current && (!parsed.hasMore || parsed.medals.some(m => isSameFansMedal(m, current)))) {
        wearedMedal.value = null
      }
    }
    fansMedalList.value = page <= 1 ? parsed.medals : mergeFansMedals(fansMedalList.value, parsed.medals)
    fansMedalTotal.value = Math.max(parsed.total, fansMedalList.value.length)
    fansMedalPage.value = page
    fansMedalHasMore.value = parsed.hasMore
  } catch (err) {
    if (changes === medalChangeCount()) fansMedalError.value = describeError(err)
  } finally {
    fansMedalLoading.value = false
  }
}

async function postMedalAction(
  url: string,
  actingId: number,
  actionLabel: string,
  extra: Record<string, string> = {}
): Promise<boolean> {
  if (fansMedalActingId.value !== null) return false
  const csrf = getCsrfToken()
  if (!csrf) {
    fansMedalError.value = '未找到登录信息，请先登录 Bilibili'
    return false
  }
  fansMedalActingId.value = actingId
  fansMedalError.value = null
  roomMedalAbort?.abort()
  roomMedalAbort = null
  try {
    const body = new FormData()
    for (const [key, value] of Object.entries({ ...extra, csrf, csrf_token: csrf, visit_id: '' })) {
      body.append(key, value)
    }
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body,
      signal: AbortSignal.timeout(MEDAL_ACTION_TIMEOUT_MS),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    const json: unknown = await resp.json()
    const code = readPath(json, 'code')
    if (code !== 0) throw new Error(readBilibiliMessage(json) || `错误码 ${code}`)
    noteMedalChange()
    return true
  } catch (err) {
    const msg = describeError(err)
    fansMedalError.value = `${actionLabel}失败：${msg}`
    appendLog(`❌ ${actionLabel}粉丝牌失败：${msg}`)
    return false
  } finally {
    fansMedalActingId.value = null
  }
}

/** Wear `medal`, then refresh the room's displayed medal from Bilibili. */
export async function wearFansMedal(medal: FansMedal): Promise<boolean> {
  const ok = await postMedalAction(BASE_URL.BILIBILI_FANS_MEDAL_WEAR, medal.medalId, '佩戴', {
    medal_id: String(medal.medalId),
  })
  if (!ok) return false
  wearedMedal.value = medal
  appendLog(`🎖️ 已佩戴粉丝牌：${medal.medalName} Lv.${medal.level}`)
  void fetchRoomDisplayedMedal()
  return true
}

/** Take off the globally worn fans medal, then refresh the room's displayed medal from Bilibili. */
export async function takeOffFansMedal(): Promise<boolean> {
  const current = wearedMedal.value
  const actingId = current && current.medalId > 0 ? current.medalId : -1
  const ok = await postMedalAction(BASE_URL.BILIBILI_FANS_MEDAL_TAKE_OFF, actingId, '卸下')
  if (!ok) return false
  wearedMedal.value = null
  if (current) appendLog(`🎖️ 已卸下粉丝牌：${current.medalName}`)
  void fetchRoomDisplayedMedal()
  return true
}
