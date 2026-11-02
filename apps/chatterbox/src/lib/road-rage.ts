import { signal } from '@preact/signals'

import { ROAD_RAGE_WINDOW_MS } from './const'
import { insertRandomChar } from './utils'

export { ROAD_RAGE_WINDOW_MS }

interface InflightRoadRage {
  id: number
  original: string
  index: number | undefined
}

const stateVersion = signal(0)
let lastRoadRageText = ''
let lastRoadRageSentAt = 0
let lastRoadRageIndex: number | undefined
let inflightSends: InflightRoadRage[] = []
let nextInflightId = 1
let pendingRoadRage: { key: string; text: string; index: number } | null = null
let expireTimer: ReturnType<typeof setTimeout> | null = null

/** Clear tracked repeat state and cancel any pending expiry timer. */
export function resetRoadRageState(): void {
  if (expireTimer !== null) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
  lastRoadRageText = ''
  lastRoadRageSentAt = 0
  lastRoadRageIndex = undefined
  inflightSends = []
  pendingRoadRage = null
  stateVersion.value++
}

/** Schedule state cleanup once the remaining {@link ROAD_RAGE_WINDOW_MS} window elapses after the last confirmed send. */
function scheduleRoadRageExpiry(now = Date.now()): void {
  if (expireTimer !== null) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
  if (inflightSends.length > 0 || lastRoadRageSentAt <= 0) return
  const remaining = ROAD_RAGE_WINDOW_MS - (now - lastRoadRageSentAt)
  if (remaining <= 0) {
    resetRoadRageState()
    return
  }
  expireTimer = setTimeout(() => {
    expireTimer = null
    if (inflightSends.length > 0) return
    resetRoadRageState()
  }, remaining)
}

/** Return the active repeat baseline (latest in-flight send, or last confirmed send within {@link ROAD_RAGE_WINDOW_MS}). */
function activeRoadRageBaseline(now: number): { original: string; index: number | undefined } | null {
  const latestInflight = inflightSends[inflightSends.length - 1]
  if (latestInflight) return { original: latestInflight.original, index: latestInflight.index }
  if (lastRoadRageText && lastRoadRageSentAt > 0 && now - lastRoadRageSentAt < ROAD_RAGE_WINDOW_MS) {
    return { original: lastRoadRageText, index: lastRoadRageIndex }
  }
  return null
}

/** Insert `char` at a random emote-safe slot in `processed`, caching the choice for identical inputs. */
function resolveRoadRage(
  original: string,
  processed: string,
  char: string,
  avoidIndex: number | undefined
): { text: string; index: number } {
  const key = `${original}\0${processed}\0${char}\0${avoidIndex ?? ''}`
  if (pendingRoadRage?.key === key) return pendingRoadRage
  const inserted = insertRandomChar(processed, char, avoidIndex)
  pendingRoadRage = { key, ...inserted }
  return pendingRoadRage
}

/** True when `original` matches the active in-flight or recently delivered manual text within {@link ROAD_RAGE_WINDOW_MS}. */
export function isRoadRageRepeat(original: string, now = Date.now()): boolean {
  void stateVersion.value
  if (!original) return false
  const baseline = activeRoadRageBaseline(now)
  return baseline !== null && baseline.original === original
}

/** Previews the post-dedup text when Road Rage is active and `original` repeats within {@link ROAD_RAGE_WINDOW_MS}. */
export function previewRoadRageText(
  original: string,
  processed: string,
  char: string,
  enabled: boolean,
  now = Date.now()
): string {
  void stateVersion.value
  if (!enabled || !original) return processed
  const baseline = activeRoadRageBaseline(now)
  if (!baseline || baseline.original !== original) return processed
  return resolveRoadRage(original, processed, char, baseline.index).text
}

/**
 * Applies Road Rage dedup to an outbound manual send when `original` repeats within {@link ROAD_RAGE_WINDOW_MS}.
 * Call `settle(delivered, now)` once delivery finishes so the 5s window starts at actual POST completion.
 */
export function applyRoadRageOnSend(opts: {
  original: string
  processed: string
  char: string
  enabled: boolean
  isEmote: boolean
  now?: number
}): { text: string; roadRaged: boolean; settle: (delivered: boolean, completedAt?: number) => void } {
  const { original, processed, char, enabled, isEmote, now = Date.now() } = opts
  const baseline = activeRoadRageBaseline(now)
  let text = processed
  let roadRaged = false
  let chosenIndex: number | undefined

  if (!isEmote && enabled && baseline !== null && baseline.original === original) {
    const resolved = resolveRoadRage(original, processed, char, baseline.index)
    text = resolved.text
    chosenIndex = resolved.index
    roadRaged = true
  }

  pendingRoadRage = null
  if (expireTimer !== null) {
    clearTimeout(expireTimer)
    expireTimer = null
  }
  const id = nextInflightId++
  inflightSends.push({ id, original, index: chosenIndex })
  stateVersion.value++

  let settled = false
  const settle = (delivered: boolean, completedAt = Date.now()): void => {
    if (settled) return
    settled = true
    inflightSends = inflightSends.filter(item => item.id !== id)
    pendingRoadRage = null
    if (delivered) {
      lastRoadRageText = original
      lastRoadRageSentAt = completedAt
      lastRoadRageIndex = chosenIndex
    }
    scheduleRoadRageExpiry(completedAt)
    stateVersion.value++
  }

  return { text, roadRaged, settle }
}
