import { signal } from '@preact/signals'

import type { FansMedal } from '../types'

import { getCsrfToken, getSpmPrefix } from './api'
import { BASE_URL } from './const'
import { applyWearedMedal, isSameFansMedal, mergeFansMedals, parseFansMedalPanelResponse } from './fans-medal-parse'
import { applyGetInfoByUserMedal, fansMedalActingId, roomDisplayedMedal, wearedMedal } from './fans-medal-room'
import { appendLog } from './log'
import { cachedRoomId, cachedStreamerUid } from './store'
import { cachedWbiKeys, encodeWbi } from './wbi'

const MEDAL_PAGE_SIZE = 50
const ROOM_MEDAL_TIMEOUT_MS = 5000

export {
  applyWearedMedal,
  formatMedalColor,
  isSameFansMedal,
  mergeFansMedals,
  normalizeFansMedal,
  parseFansMedalPanelResponse,
  parseGetInfoByUserMedal,
} from './fans-medal-parse'
export {
  applyGetInfoByUserMedal,
  fansMedalActingId,
  roomDisplayedMedal,
  roomDisplayedMedalKnown,
  wearedMedal,
} from './fans-medal-room'

export const fansMedalList = signal<FansMedal[]>([])
export const fansMedalTotal = signal(0)
export const fansMedalPage = signal(0)
export const fansMedalHasMore = signal(false)
export const fansMedalLoading = signal(false)
export const fansMedalError = signal<string | null>(null)

let requestSeq = 0
let roomMedalRequestSeq = 0
let mutationSeq = 0
let roomMedalAbort: AbortController | null = null

function buildCsrfForm(extra?: Record<string, string>): FormData {
  const csrf = getCsrfToken() ?? ''
  const form = new FormData()
  if (extra) {
    for (const [k, v] of Object.entries(extra)) form.append(k, v)
  }
  form.append('csrf', csrf)
  form.append('csrf_token', csrf)
  form.append('visit_id', '')
  return form
}

/** Fetch the server-computed displayed medal (`data.medal.curr_show`) via `getInfoByUser`. */
export async function fetchRoomDisplayedMedal(roomIdOverride?: number | null): Promise<FansMedal | null> {
  const roomId = roomIdOverride ?? cachedRoomId.value
  if (!roomId || !getCsrfToken()) return roomDisplayedMedal.peek()

  const seq = ++roomMedalRequestSeq
  const mut = mutationSeq
  roomMedalAbort?.abort()
  const controller = new AbortController()
  roomMedalAbort = controller
  const timeoutId = setTimeout(() => controller.abort(), ROOM_MEDAL_TIMEOUT_MS)

  try {
    const base = { room_id: String(roomId), from: '0', not_mock_enter_effect: '1' }
    const query = cachedWbiKeys
      ? encodeWbi({ ...base, web_location: getSpmPrefix() }, cachedWbiKeys)
      : new URLSearchParams(base).toString()
    const resp = await fetch(`${BASE_URL.BILIBILI_GET_INFO_BY_USER}?${query}`, {
      method: 'GET',
      credentials: 'include',
      signal: controller.signal,
    })
    if (!resp.ok) return roomDisplayedMedal.peek()
    const json: unknown = await resp.json()
    if (seq !== roomMedalRequestSeq || mut !== mutationSeq || fansMedalActingId.value !== null) {
      return roomDisplayedMedal.peek()
    }
    applyGetInfoByUserMedal(json, { roomId })
    return roomDisplayedMedal.peek()
  } catch {
    return roomDisplayedMedal.peek()
  } finally {
    clearTimeout(timeoutId)
    if (roomMedalAbort === controller) roomMedalAbort = null
  }
}

/** Fetch owned fans medals (`page = 1` replaces list; `page > 1` appends). */
export async function fetchFansMedalPanel(page = 1): Promise<void> {
  if (fansMedalLoading.value) return
  if (!getCsrfToken()) {
    fansMedalError.value = '未找到登录信息，请先登录 Bilibili'
    return
  }
  const seq = ++requestSeq
  const mut = mutationSeq
  fansMedalLoading.value = true
  fansMedalError.value = null
  try {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(MEDAL_PAGE_SIZE),
    })
    if (cachedStreamerUid.value) params.set('target_id', String(cachedStreamerUid.value))
    const resp = await fetch(`${BASE_URL.BILIBILI_FANS_MEDAL_PANEL}?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    const json: unknown = await resp.json()
    const parsed = parseFansMedalPanelResponse(json)
    if (seq !== requestSeq || mut !== mutationSeq || fansMedalActingId.value !== null) {
      // Initial empty list must still populate if user wore/unwore during the first fetch.
      if (page <= 1 && fansMedalList.value.length === 0) {
        const reconciled = applyWearedMedal(parsed.medals, wearedMedal.value)
        fansMedalList.value = reconciled
        fansMedalTotal.value = Math.max(parsed.total, reconciled.length)
        fansMedalPage.value = page
        fansMedalHasMore.value = parsed.hasMore
      }
      return
    }
    fansMedalList.value = page <= 1 ? parsed.medals : mergeFansMedals(fansMedalList.value, parsed.medals)
    fansMedalTotal.value = Math.max(parsed.total, fansMedalList.value.length)
    fansMedalPage.value = page
    fansMedalHasMore.value = parsed.hasMore
    if (page <= 1) {
      if (parsed.weared) {
        wearedMedal.value = parsed.weared
      } else if (wearedMedal.value) {
        const match = fansMedalList.value.find(m => isSameFansMedal(m, wearedMedal.value))
        if (match && !match.wearingStatus) wearedMedal.value = null
      }
    }
  } catch (err) {
    if (seq !== requestSeq || mut !== mutationSeq) return
    fansMedalError.value = err instanceof Error ? err.message : String(err)
  } finally {
    fansMedalLoading.value = false
  }
}

async function postMedalAction(
  url: string,
  actingId: number,
  actionLabel: string,
  extra?: Record<string, string>
): Promise<boolean> {
  if (fansMedalActingId.value !== null) return false
  if (!getCsrfToken()) {
    fansMedalError.value = '未找到登录信息，请先登录 Bilibili'
    return false
  }
  fansMedalActingId.value = actingId
  fansMedalError.value = null
  roomMedalAbort?.abort()
  roomMedalAbort = null
  try {
    const resp = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      body: buildCsrfForm(extra),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
    const json: { code?: number; message?: string; msg?: string } = await resp.json()
    if (json.code !== 0) throw new Error(json.message || json.msg || `错误码 ${json.code}`)
    mutationSeq++
    requestSeq++
    roomMedalRequestSeq++
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    fansMedalError.value = `${actionLabel}失败：${msg}`
    appendLog(`❌ ${actionLabel}粉丝牌失败：${msg}`)
    return false
  } finally {
    fansMedalActingId.value = null
  }
}

/** Wear `medal`, update global worn state, and refresh room display from Bilibili. */
export async function wearFansMedal(medal: FansMedal): Promise<boolean> {
  const ok = await postMedalAction(BASE_URL.BILIBILI_FANS_MEDAL_WEAR, medal.medalId, '佩戴', {
    medal_id: String(medal.medalId),
  })
  if (!ok) return false
  const nextWorn = { ...medal, wearingStatus: true }
  wearedMedal.value = nextWorn
  fansMedalList.value = applyWearedMedal(fansMedalList.value, nextWorn)
  appendLog(`🎖️ 已佩戴粉丝牌：${medal.medalName} Lv.${medal.level}`)
  void fetchRoomDisplayedMedal()
  return true
}

/** Take off the globally worn fans medal and refresh room display from Bilibili. */
export async function takeOffFansMedal(): Promise<boolean> {
  const current = wearedMedal.value
  const actingId = current && current.medalId > 0 ? current.medalId : -1
  const ok = await postMedalAction(BASE_URL.BILIBILI_FANS_MEDAL_TAKE_OFF, actingId, '卸下')
  if (!ok) return false
  wearedMedal.value = null
  fansMedalList.value = applyWearedMedal(fansMedalList.value, null)
  if (current) appendLog(`🎖️ 已卸下粉丝牌：${current.medalName}`)
  void fetchRoomDisplayedMedal()
  return true
}
