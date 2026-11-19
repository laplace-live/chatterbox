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

export interface GetInfoStamp {
  seq: number
  epoch: number
}

export type ApplyGetInfoMedalResult = 'applied' | 'stale' | 'invalid'

let medalMutationEpoch = 0
let nextGetInfoSeq = 0
let lastAppliedGetInfoSeq = 0
const ownGetInfoMedalResponses = new WeakSet<object>()
let onWearedMedalChange: ((weared: FansMedal | null) => void) | null = null

/** Capture ordering token when a `getInfoByUser` request starts so late pre-action responses are dropped. */
export function captureGetInfoStamp(): GetInfoStamp {
  return { seq: ++nextGetInfoSeq, epoch: medalMutationEpoch }
}

/** Advance the medal mutation epoch after a wear/take-off succeeds so older in-flight replies cannot revert it. */
export function bumpMedalMutationEpoch(): number {
  return ++medalMutationEpoch
}

export function markOwnGetInfoMedalResponse(resp: object): void {
  ownGetInfoMedalResponses.add(resp)
}

export function isOwnGetInfoMedalResponse(resp: object): boolean {
  return ownGetInfoMedalResponses.has(resp)
}

export function setWearedMedalChangeListener(listener: ((weared: FansMedal | null) => void) | null): void {
  onWearedMedalChange = listener
}

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
export function applyGetInfoByUserMedal(
  payload: unknown,
  context?: { roomId?: number | null; url?: string; stamp?: GetInfoStamp; fromHijack?: boolean }
): ApplyGetInfoMedalResult {
  if (fansMedalActingId.peek() !== null) return 'stale'
  const stamp = context?.stamp
  if (stamp) {
    if (stamp.epoch !== medalMutationEpoch || stamp.seq < lastAppliedGetInfoSeq) return 'stale'
  } else if (context?.fromHijack && medalMutationEpoch > 0) {
    return 'stale'
  }

  const parsed = parseGetInfoByUserMedal(payload)
  if (!parsed) return 'invalid'
  if (stamp) lastAppliedGetInfoSeq = Math.max(lastAppliedGetInfoSeq, stamp.seq)

  const roomIds = collectRoomIds(payload, context)
  const isUnauthed = isRecord(payload) && payload.code === -101
  if (isUnauthed) {
    if (medalsByRoom.value.size > 0 || roomIds.length > 0) {
      const next = new Map<number, FansMedal | null>()
      for (const id of roomIds) next.set(id, null)
      medalsByRoom.value = next
    }
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
    onWearedMedalChange?.(wearedMedal.peek())
  }
  return 'applied'
}

/** Clear recorded room-displayed and globally worn medal caches (for tests). */
export function resetRoomDisplayedMedals(): void {
  if (medalsByRoom.value.size > 0) medalsByRoom.value = new Map()
  unkeyedDisplayedMedal.value = undefined
  wearedMedal.value = null
  fansMedalActingId.value = null
  medalMutationEpoch = 0
  nextGetInfoSeq = 0
  lastAppliedGetInfoSeq = 0
}
