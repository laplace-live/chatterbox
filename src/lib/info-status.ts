/**
 * Read-only metadata aggregator for the info button popover.
 *
 * Cached per-uid for the page lifetime, never persisted (stale opinionated data
 * misleads across days; reload re-fetches). 404 = "no data" (null, no error),
 * not a failure. Guild and MCN share the BilibiliUser endpoint.
 */

import type { LaplaceInternal } from '@laplace.live/internal'
import { signal } from '@preact/signals'

import { BASE_URL } from './const'
import { infoFertilityEnabled, infoGuildEnabled, infoMcnEnabled } from './store'

export type FertilityData = LaplaceInternal.HTTPS.Workers.FertilityUserResponse
export type BilibiliUserData = LaplaceInternal.HTTPS.Workers.BilibiliUser

/** Uid currently being displayed by the info popover (null until resolved). */
export const infoCurrentUid = signal<number | null>(null)

/**
 * Opus-page provenance for the 魔法期 "贡献数据" link; null off `/opus/*`.
 * `source` is the permalink; `date` is publish date (`YYYY-MM-DD`, null if the
 * SSR snapshot carried no usable timestamp).
 */
export const infoOpusMeta = signal<{ source: string; date: string | null } | null>(null)

export const fertilityData = signal<FertilityData | null>(null)
export const fertilityLoading = signal(false)
export const fertilityError = signal<string | null>(null)

export const bilibiliUserData = signal<BilibiliUserData | null>(null)
export const bilibiliUserLoading = signal(false)
export const bilibiliUserError = signal<string | null>(null)

// Per-uid in-flight promises dedupe concurrent requests for the same uid.
const fertilityInFlight = new Map<number, Promise<void>>()
const bilibiliUserInFlight = new Map<number, Promise<void>>()

// Per-uid response cache; never re-fetched within a page session (reload only).
const fertilityCache = new Map<number, FertilityData | null>()
const bilibiliUserCache = new Map<number, BilibiliUserData | null>()

async function fetchFertility(uid: number): Promise<void> {
  // `has` not truthy-`get`, so a cached `null` (404) also short-circuits.
  if (fertilityCache.has(uid)) {
    fertilityData.value = fertilityCache.get(uid) ?? null
    return
  }
  const existing = fertilityInFlight.get(uid)
  if (existing) return existing

  fertilityLoading.value = true
  fertilityError.value = null
  const p = (async () => {
    try {
      const resp = await fetch(`${BASE_URL.LAPLACE_FERTILITY}/${uid}`)
      if (resp.status === 404) {
        fertilityCache.set(uid, null)
        fertilityData.value = null
        return
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      const json: FertilityData = await resp.json()
      fertilityCache.set(uid, json)
      fertilityData.value = json
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fertilityError.value = msg
      fertilityData.value = null
    } finally {
      fertilityLoading.value = false
      fertilityInFlight.delete(uid)
    }
  })()
  fertilityInFlight.set(uid, p)
  return p
}

async function fetchBilibiliUser(uid: number): Promise<void> {
  if (bilibiliUserCache.has(uid)) {
    bilibiliUserData.value = bilibiliUserCache.get(uid) ?? null
    return
  }
  const existing = bilibiliUserInFlight.get(uid)
  if (existing) return existing

  bilibiliUserLoading.value = true
  bilibiliUserError.value = null
  const p = (async () => {
    try {
      const resp = await fetch(`${BASE_URL.LAPLACE_BILIBILI_USER}/${uid}`)
      if (resp.status === 404) {
        bilibiliUserCache.set(uid, null)
        bilibiliUserData.value = null
        return
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      const json: BilibiliUserData = await resp.json()
      bilibiliUserCache.set(uid, json)
      bilibiliUserData.value = json
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      bilibiliUserError.value = msg
      bilibiliUserData.value = null
    } finally {
      bilibiliUserLoading.value = false
      bilibiliUserInFlight.delete(uid)
    }
  })()
  bilibiliUserInFlight.set(uid, p)
  return p
}

/** Fan out enabled fetches for `uid`; safe to call repeatedly (deduped), no-op when null. */
export function ensureInfoData(uid: number | null): void {
  if (uid === null) return
  if (infoFertilityEnabled.value) void fetchFertility(uid)
  if (infoGuildEnabled.value || infoMcnEnabled.value) void fetchBilibiliUser(uid)
}

/** Clear visible signals on uid change; caches preserved so revisits stay instant. */
export function resetInfoData(): void {
  fertilityData.value = null
  fertilityError.value = null
  bilibiliUserData.value = null
  bilibiliUserError.value = null
}

// Display helpers: colors lifted from the reference Greasemonkey scripts for consistency.

export type FertilityStatus = LaplaceInternal.HTTPS.Workers.FertilityStatus

interface FertilityDisplay {
  label: string
  emoji: string
  color: string
  bg: string
}

const FERTILITY_DISPLAY: Record<FertilityStatus, FertilityDisplay> = {
  menstruating: { label: '魔法期', emoji: '🩸', color: '#e74c3c', bg: 'rgba(231,76,60,.15)' },
  ovulating: { label: '排卵期', emoji: '🥚', color: '#f39c12', bg: 'rgba(243,156,18,.15)' },
  fertile: { label: '易孕期', emoji: '🌸', color: '#e91e63', bg: 'rgba(233,30,99,.15)' },
  normal: { label: '安全期', emoji: '💚', color: '#2ecc71', bg: 'rgba(46,204,113,.15)' },
}

export function getFertilityDisplay(status: FertilityStatus): FertilityDisplay {
  return FERTILITY_DISPLAY[status]
}

/** Emoji for the info button face; null (not a placeholder) when no fertility data. */
export function getFertilityButtonEmoji(): string | null {
  const data = fertilityData.value
  if (!data) return null
  return FERTILITY_DISPLAY[data.status].emoji
}
