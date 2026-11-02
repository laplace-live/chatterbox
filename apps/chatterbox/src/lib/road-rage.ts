import { signal } from '@preact/signals'

import { ROAD_RAGE_WINDOW_MS } from './const'
import { insertRandomChar } from './utils'

export { ROAD_RAGE_WINDOW_MS }

const lastRoadRageText = signal('')
let lastRoadRageSentAt = 0
let lastRoadRageIndex: number | undefined
let pendingRoadRage: { key: string; text: string; index: number } | null = null
let expireTimer: ReturnType<typeof setTimeout> | null = null

/** Clear tracked repeat state and cancel any pending expiry timer. */
export function resetRoadRageState(): void {
  if (expireTimer !== null) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
  lastRoadRageSentAt = 0
  lastRoadRageIndex = undefined
  pendingRoadRage = null
  lastRoadRageText.value = ''
}

function scheduleRoadRageExpiry(): void {
  if (expireTimer !== null) clearTimeout(expireTimer)
  expireTimer = setTimeout(() => {
    expireTimer = null
    resetRoadRageState()
  }, ROAD_RAGE_WINDOW_MS)
}

function resolveRoadRage(original: string, processed: string, char: string): { text: string; index: number } {
  const key = `${original}\0${processed}\0${char}\0${lastRoadRageIndex ?? ''}`
  if (pendingRoadRage?.key === key) return pendingRoadRage
  const inserted = insertRandomChar(processed, char, lastRoadRageIndex)
  pendingRoadRage = { key, ...inserted }
  return pendingRoadRage
}

/** True when `original` matches the last sent manual text and falls within {@link ROAD_RAGE_WINDOW_MS}. */
export function isRoadRageRepeat(original: string, now = Date.now()): boolean {
  const last = lastRoadRageText.value
  return Boolean(last) && original === last && lastRoadRageSentAt > 0 && now - lastRoadRageSentAt < ROAD_RAGE_WINDOW_MS
}

/** Previews the post-dedup text when Road Rage is active and `original` repeats within {@link ROAD_RAGE_WINDOW_MS}. */
export function previewRoadRageText(
  original: string,
  processed: string,
  char: string,
  enabled: boolean,
  now = Date.now()
): string {
  if (!enabled || !isRoadRageRepeat(original, now)) return processed
  return resolveRoadRage(original, processed, char).text
}

/**
 * Applies Road Rage dedup to an outbound manual send when `original` repeats within {@link ROAD_RAGE_WINDOW_MS},
 * and records `original` as the baseline for the next {@link ROAD_RAGE_WINDOW_MS} window.
 */
export function applyRoadRageOnSend(opts: {
  original: string
  processed: string
  char: string
  enabled: boolean
  isEmote: boolean
  now?: number
}): { text: string; roadRaged: boolean } {
  const { original, processed, char, enabled, isEmote, now = Date.now() } = opts
  let text = processed
  let roadRaged = false

  if (!isEmote && enabled && isRoadRageRepeat(original, now)) {
    const resolved = resolveRoadRage(original, processed, char)
    text = resolved.text
    lastRoadRageIndex = resolved.index
    roadRaged = true
  } else {
    lastRoadRageIndex = undefined
  }

  pendingRoadRage = null
  lastRoadRageSentAt = now
  lastRoadRageText.value = original
  scheduleRoadRageExpiry()

  return { text, roadRaged }
}
