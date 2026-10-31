import { computed, signal } from '@preact/signals'

import { DANMAKU_UNITS_PER_CHAR, DEFAULT_DANMAKU_MAX_UNITS } from './const'
import { extractRoomNumber, readPath } from './utils'

/** Converts Bilibili `utilDanmuLength` half-width units (e.g. `80`) to full-width Chinese character ("字") count (`40`). */
function unitsToDanmakuChars(units: number): number {
  return Math.max(1, Math.floor(units / DANMAKU_UNITS_PER_CHAR))
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

/** Active resolved Bilibili real room ID for the current page (`null` until resolved). */
export const cachedRoomId = signal<number | null>(null)

const unitsByRoom = signal<ReadonlyMap<number, number>>(new Map())
const unkeyedUnits = signal<number | null>(null)

/** Viewer's room-specific `data.property.danmu.length` in Bilibili half-width units (`null` until resolved for the active room or when logged out). */
export const roomDanmakuUnits = computed<number | null>(() => {
  const activeRoomId = cachedRoomId.value
  const map = unitsByRoom.value
  if (activeRoomId !== null) return map.get(activeRoomId) ?? null
  const urlRoom = typeof location !== 'undefined' ? parsePositiveRoomId(extractRoomNumber(location.href)) : null
  if (urlRoom !== null && map.has(urlRoom)) return map.get(urlRoom) ?? null
  if (map.size === 1) return map.values().next().value ?? null
  return unkeyedUnits.value
})

/** Effective room cap in Bilibili half-width units: live `getInfoByUser` value once known, else {@link DEFAULT_DANMAKU_MAX_UNITS}. */
export const danmakuMaxUnits = computed(() => roomDanmakuUnits.value ?? DEFAULT_DANMAKU_MAX_UNITS)

/** Known room cap in full-width Chinese characters ("字") for UI bounds, or `null` until resolved. */
export const roomDanmakuChars = computed(() =>
  roomDanmakuUnits.value !== null ? unitsToDanmakuChars(roomDanmakuUnits.value) : null
)

/** Effective room cap in full-width Chinese characters ("字", e.g. `40`) for UI display. */
export const danmakuMaxChars = computed(() => unitsToDanmakuChars(danmakuMaxUnits.value))

/** Extracts `data.property.danmu.length` (half-width units) from a `getInfoByUser` JSON body, or `null` when absent/unusable. */
export function extractDanmakuMaxUnits(payload: unknown): number | null {
  if (readPath(payload, 'code') !== 0) return null
  const raw = Number(readPath(payload, 'data', 'property', 'danmu', 'length'))
  return Number.isInteger(raw) && raw > 0 ? raw : null
}

/** Records a room-keyed `getInfoByUser` danmaku unit cap (`-101` clears the matching room's logged-in cap without clobbering other rooms). */
export function applyGetInfoByUserDanmakuLength(
  payload: unknown,
  context?: { roomId?: number | null; url?: string }
): void {
  const roomIds = collectRoomIds(payload, context)
  if (readPath(payload, 'code') === -101) {
    if (roomIds.length > 0) {
      const next = new Map(unitsByRoom.value)
      let changed = false
      for (const id of roomIds) {
        if (next.delete(id)) changed = true
      }
      if (changed) unitsByRoom.value = next
    } else {
      if (unitsByRoom.value.size > 0) unitsByRoom.value = new Map()
      unkeyedUnits.value = null
    }
    return
  }
  const units = extractDanmakuMaxUnits(payload)
  if (units === null) return
  if (roomIds.length > 0) {
    const next = new Map(unitsByRoom.value)
    for (const id of roomIds) next.set(id, units)
    unitsByRoom.value = next
  } else {
    unkeyedUnits.value = units
  }
}

/** Clears cached room ID and all recorded per-room danmaku unit caps. */
export function resetRoomDanmakuLimits(): void {
  cachedRoomId.value = null
  if (unitsByRoom.value.size > 0) unitsByRoom.value = new Map()
  unkeyedUnits.value = null
}

/**
 * Effective split budget in half-width units for 独轮车: `overrideChars * 2` when positive, else the room cap.
 * Clamped to `detectedUnits` when known so an override can't overrun Bilibili's server cap, while staying usable if detection fails.
 */
export function resolveAutoSendMaxUnits(overrideChars: number | null, detectedUnits: number | null): number {
  const roomUnits = detectedUnits ?? DEFAULT_DANMAKU_MAX_UNITS
  if (typeof overrideChars !== 'number' || !Number.isFinite(overrideChars) || overrideChars < 1) return roomUnits
  const overrideUnits = Math.floor(overrideChars) * DANMAKU_UNITS_PER_CHAR
  return detectedUnits !== null ? Math.min(overrideUnits, detectedUnits) : overrideUnits
}
