import { computed, signal } from '@preact/signals'

import type { FansMedal } from '../types'

import { collectRoomIds, resolveRoomEntry } from './danmaku-limit'
import { isSameFansMedal, parseGetInfoByUserMedal } from './fans-medal-parse'
import { readPath } from './utils'

const medalsByRoom = signal<ReadonlyMap<number, FansMedal | null>>(new Map())
const unkeyedDisplayedMedal = signal<FansMedal | null | undefined>(undefined)
const activeRoomMedal = computed(() => resolveRoomEntry(medalsByRoom.value, unkeyedDisplayedMedal.value))

/** Medal Bilibili displays in the active room (`data.medal.curr_show` from `getInfoByUser`). */
export const roomDisplayedMedal = computed(() => activeRoomMedal.value ?? null)

/** Whether `getInfoByUser` medal state has been recorded for the active room. */
export const roomDisplayedMedalKnown = computed(() => activeRoomMedal.value !== undefined)

/** User's globally worn fans medal (not necessarily what is displayed in the current room). */
export const wearedMedal = signal<FansMedal | null>(null)

/** Medal id of the in-flight wear/take-off (`-1` for an id-less take-off), else `null`. */
export const fansMedalActingId = signal<number | null>(null)

let medalChanges = 0

/** Count a successful wear/take-off. */
export function noteMedalChange(): void {
  medalChanges++
}

/** Successful wear/take-offs so far, for spotting replies that raced one. */
export function medalChangeCount(): number {
  return medalChanges
}

/**
 * Record `getInfoByUser`'s per-room `curr_show` and global `curr_weared_v2`. B站's own replies
 * (`fromHijack`) are ignored after a wear/take-off, since they may predate it.
 */
export function applyGetInfoByUserMedal(
  payload: unknown,
  context?: { roomId?: number | null; url?: string; fromHijack?: boolean }
): 'applied' | 'stale' | 'invalid' {
  if (fansMedalActingId.peek() !== null || (context?.fromHijack && medalChanges > 0)) return 'stale'
  const parsed = parseGetInfoByUserMedal(payload)
  if (!parsed) return 'invalid'

  const roomIds = collectRoomIds(payload, context)
  if (readPath(payload, 'code') === -101) {
    // Logged out: forget every recorded room, not just this one.
    medalsByRoom.value = new Map(roomIds.map(id => [id, null]))
    unkeyedDisplayedMedal.value = null
  } else if (roomIds.length > 0) {
    const next = new Map(medalsByRoom.value)
    for (const id of roomIds) next.set(id, parsed.displayed)
    medalsByRoom.value = next
  } else {
    unkeyedDisplayedMedal.value = parsed.displayed
  }

  const weared = parsed.weared
  if (weared !== undefined) {
    const existing = wearedMedal.peek()
    // `curr_weared_v2` can omit the id; keep the panel's richer record of the same medal.
    const keepExisting =
      weared !== null &&
      existing !== null &&
      existing.medalId > 0 &&
      weared.medalId === 0 &&
      isSameFansMedal(existing, weared)
    if (!keepExisting) wearedMedal.value = weared
  }
  return 'applied'
}

/** Clear recorded room-displayed and globally worn medal state (for tests). */
export function resetRoomDisplayedMedals(): void {
  medalsByRoom.value = new Map()
  unkeyedDisplayedMedal.value = undefined
  wearedMedal.value = null
  fansMedalActingId.value = null
  medalChanges = 0
}
