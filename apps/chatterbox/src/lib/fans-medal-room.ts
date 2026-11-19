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
// Page replies may predate a wear/take-off until a logout ends the session it was made in.
let pageRepliesSuspect = false

/** Count a successful wear/take-off. */
export function noteMedalChange(): void {
  medalChanges++
  pageRepliesSuspect = true
}

/** Successful wear/take-offs so far, for spotting replies that raced one. */
export function medalChangeCount(): number {
  return medalChanges
}

/**
 * Record `getInfoByUser`'s per-room `curr_show` and global `curr_weared_v2`. Only `authoritative` replies (our
 * own refetch) are ordered after a wear/take-off; from then until a logout, other replies may predate it, so they
 * only seed unrecorded rooms and leave the worn medal alone. A logout always applies.
 */
export function applyGetInfoByUserMedal(
  payload: unknown,
  context?: { roomId?: number | null; url?: string; authoritative?: boolean }
): 'applied' | 'stale' | 'invalid' {
  if (fansMedalActingId.peek() !== null) return 'stale'
  const roomIds = collectRoomIds(payload, context)
  const loggedOut = readPath(payload, 'code') === -101
  const untrusted = !loggedOut && !context?.authoritative && pageRepliesSuspect
  if (untrusted) {
    const recorded = medalsByRoom.value
    if (roomIds.length === 0 || roomIds.some(id => recorded.has(id))) return 'stale'
  }
  const parsed = parseGetInfoByUserMedal(payload)
  if (!parsed) return 'invalid'

  if (loggedOut) {
    // Logged out: forget every recorded room, not just this one, and the session's own changes.
    medalsByRoom.value = new Map(roomIds.map(id => [id, null]))
    unkeyedDisplayedMedal.value = null
    pageRepliesSuspect = false
  } else if (roomIds.length > 0) {
    const next = new Map(medalsByRoom.value)
    for (const id of roomIds) next.set(id, parsed.displayed)
    medalsByRoom.value = next
  } else {
    unkeyedDisplayedMedal.value = parsed.displayed
  }

  const weared = parsed.weared
  if (weared !== undefined && !untrusted) {
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
  pageRepliesSuspect = false
}
