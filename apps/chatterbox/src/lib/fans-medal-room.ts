import { computed, signal } from '@preact/signals'

import type { FansMedal } from '../types'

import { cachedRoomId } from './danmaku-limit'
import { isSameFansMedal, parseGetInfoByUserMedal } from './fans-medal-parse'
import { extractRoomNumber, isRecord, readPath } from './utils'

const medalsByRoom = signal<ReadonlyMap<number, FansMedal | null>>(new Map())
const unkeyedDisplayedMedal = signal<FansMedal | null | undefined>(undefined)

/** User's globally worn fans medal (not necessarily what is displayed in the current room). */
export const wearedMedal = signal<FansMedal | null>(null)
export const fansMedalActingId = signal<number | null>(null)

function parsePositiveRoomId(raw: unknown): number | null {
  const num = Number(raw)
  return Number.isInteger(num) && num > 0 ? num : null
}

function extractUrlRoomId(url: string | undefined): number | null {
  if (!url) return null
  const match = url.match(/[?&]room_id=(\d+)(?:&|#|$)/)
  return match ? parsePositiveRoomId(match[1]) : null
}

function collectRoomIds(payload: unknown, context?: { roomId?: number | null; url?: string }): number[] {
  const ids = new Set<number>()
  // Do not read `data.medal.curr_weared.target_roomid`: it points to another streamer's room when unowned locally.
  for (const candidate of [
    context?.roomId,
    extractUrlRoomId(context?.url),
    readPath(payload, 'data', 'property', 'danmu', 'room_id'),
    readPath(payload, 'data', 'room_info', 'room_id'),
  ]) {
    const id = parsePositiveRoomId(candidate)
    if (id !== null) ids.add(id)
  }
  return [...ids]
}

function readUrlRoomNumber(): number | null {
  if (typeof location === 'undefined') return null
  try {
    return parsePositiveRoomId(extractRoomNumber(location.href))
  } catch {
    return null
  }
}

/** Medal Bilibili displays in the active room (`data.medal.curr_show` from `getInfoByUser`). */
export const roomDisplayedMedal = computed<FansMedal | null>(() => {
  const activeRoomId = cachedRoomId.value
  const map = medalsByRoom.value
  if (activeRoomId !== null) return map.get(activeRoomId) ?? null
  const urlRoom = readUrlRoomNumber()
  if (urlRoom !== null && map.has(urlRoom)) return map.get(urlRoom) ?? null
  if (map.size === 1) return map.values().next().value ?? null
  return unkeyedDisplayedMedal.value ?? null
})

/** Whether `getInfoByUser` medal state has been recorded for the active room. */
export const roomDisplayedMedalKnown = computed<boolean>(() => {
  const activeRoomId = cachedRoomId.value
  const map = medalsByRoom.value
  if (activeRoomId !== null) return map.has(activeRoomId)
  const urlRoom = readUrlRoomNumber()
  if (urlRoom !== null && map.has(urlRoom)) return true
  if (map.size === 1) return true
  return unkeyedDisplayedMedal.value !== undefined
})

/** Record `getInfoByUser`'s server-resolved `curr_show` (per room) and global `curr_weared_v2` medal. */
export function applyGetInfoByUserMedal(payload: unknown, context?: { roomId?: number | null; url?: string }): void {
  if (fansMedalActingId.peek() !== null) return
  const parsed = parseGetInfoByUserMedal(payload)
  if (!parsed) return

  const roomIds = collectRoomIds(payload, context)
  const isUnauthed = isRecord(payload) && payload.code === -101
  if (isUnauthed && roomIds.length === 0) {
    if (medalsByRoom.value.size > 0) medalsByRoom.value = new Map()
    unkeyedDisplayedMedal.value = null
  } else if (roomIds.length > 0) {
    const next = new Map(medalsByRoom.value)
    for (const id of roomIds) next.set(id, parsed.displayed)
    medalsByRoom.value = next
  } else {
    unkeyedDisplayedMedal.value = parsed.displayed
  }

  if (parsed.weared !== undefined) {
    if (parsed.weared === null) {
      wearedMedal.value = null
    } else {
      const existing = wearedMedal.peek()
      if (
        !(existing && existing.medalId > 0 && parsed.weared.medalId === 0 && isSameFansMedal(existing, parsed.weared))
      ) {
        wearedMedal.value = parsed.weared
      }
    }
  }
}

/** Clear recorded room-displayed and globally worn medal caches (for tests). */
export function resetRoomDisplayedMedals(): void {
  if (medalsByRoom.value.size > 0) medalsByRoom.value = new Map()
  unkeyedDisplayedMedal.value = undefined
  wearedMedal.value = null
  fansMedalActingId.value = null
}
