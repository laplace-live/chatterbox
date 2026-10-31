import { computed, signal } from '@preact/signals'

import { DANMAKU_UNITS_PER_CHAR, DEFAULT_DANMAKU_MAX_UNITS } from './const'
import { readPath } from './utils'

/** Converts Bilibili `utilDanmuLength` half-width units (e.g. `80`) to full-width Chinese character ("字") count (`40`). */
function unitsToDanmakuChars(units: number): number {
  return Math.max(1, Math.floor(units / DANMAKU_UNITS_PER_CHAR))
}

/** Viewer's room-specific `data.property.danmu.length` in Bilibili half-width units (`null` until resolved or when logged out). */
export const roomDanmakuUnits = signal<number | null>(null)

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

/** Updates {@link roomDanmakuUnits} from a `getInfoByUser` JSON body (`-101` clears a stale logged-in cap on SPA nav). */
export function applyGetInfoByUserDanmakuLength(payload: unknown): void {
  if (readPath(payload, 'code') === -101) {
    roomDanmakuUnits.value = null
    return
  }
  const units = extractDanmakuMaxUnits(payload)
  if (units !== null) roomDanmakuUnits.value = units
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
