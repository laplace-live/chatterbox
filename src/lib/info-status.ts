/**
 * Read-only metadata aggregator for the info button popover.
 *
 * Two upstream endpoints (both hosted at workers.vrp.moe, both typed by
 * `@laplace.live/internal`):
 *
 *   - `LAPLACE_FERTILITY/${uid}`     → `FertilityUserResponse`
 *   - `LAPLACE_BILIBILI_USER/${uid}` → `BilibiliUser`
 *
 * Both are fetched lazily and cached per-uid for the lifetime of the
 * page. We intentionally do NOT persist the responses to GM storage —
 * the data is opinionated and a stale snapshot could be misleading
 * across days. A page reload re-fetches.
 *
 * Each fetch is gated by the corresponding settings signal
 * (`infoFertilityEnabled`, `infoGuildEnabled`, `infoMcnEnabled`). Guild
 * and MCN both come from the same `BilibiliUser` endpoint, so a single
 * fetch satisfies either toggle being on.
 *
 * 404 from either endpoint is treated as "no data" (a normal outcome for
 * uids not in the Laplace dataset) rather than an error — surfaced as
 * `null` data with no error message. Real network / parse failures land
 * in `*Error` so the popover can show them.
 *
 * Identifier resolution is the consumer's job: on live pages,
 * `cachedStreamerUid` is the source of truth; on space pages, the URL
 * path is. Both feed the same `ensureInfoData(uid)` entry point — this
 * module doesn't care which surface called it.
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
 * Opus-page provenance for the 魔法期 "贡献数据" link. Null on every other
 * surface; `main.tsx` sets it only on `/opus/*` pages. `source` is the opus
 * permalink and `date` is the post's publish date (`YYYY-MM-DD`, may be null
 * if the SSR snapshot carried no usable timestamp). It lives next to
 * `infoCurrentUid` because, like the uid, it's surface-supplied context the
 * popover reads but doesn't resolve itself.
 */
export const infoOpusMeta = signal<{ source: string; date: string | null } | null>(null)

export const fertilityData = signal<FertilityData | null>(null)
export const fertilityLoading = signal(false)
export const fertilityError = signal<string | null>(null)

export const bilibiliUserData = signal<BilibiliUserData | null>(null)
export const bilibiliUserLoading = signal(false)
export const bilibiliUserError = signal<string | null>(null)

// Per-uid in-flight promise caches. Without these, two consumers asking
// for the same uid back-to-back (e.g. the popover opening twice during a
// settings flip) would fire duplicate network requests. Cleared only by
// `resetInfoData` so the cache survives popover open/close cycles.
const fertilityInFlight = new Map<number, Promise<void>>()
const bilibiliUserInFlight = new Map<number, Promise<void>>()

// Per-uid response caches. Same lifetime as the in-flight map — once a
// uid resolves we never re-fetch it within the page session. A reload is
// the only refresh mechanism by design (the upstream data updates on
// the order of days, not minutes).
const fertilityCache = new Map<number, FertilityData | null>()
const bilibiliUserCache = new Map<number, BilibiliUserData | null>()

async function fetchFertility(uid: number): Promise<void> {
  // Re-hydrate from cache instantly if we already resolved this uid.
  // `has` (not truthy-check on `get`) so a cached `null` (404 = no data)
  // also short-circuits and doesn't re-fetch.
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

/**
 * Fan out fetches for `uid` based on which categories the user has
 * enabled. Safe to call repeatedly — each underlying endpoint dedupes
 * via the in-flight + cache maps.
 *
 * No-op when uid is null (e.g. live page before `ensureRoomId` resolves,
 * or a non-numeric space-page URL).
 */
export function ensureInfoData(uid: number | null): void {
  if (uid === null) return
  if (infoFertilityEnabled.value) void fetchFertility(uid)
  // Guild and MCN both live on the BilibiliUser response, so either
  // toggle being on triggers one (deduped) fetch.
  if (infoGuildEnabled.value || infoMcnEnabled.value) void fetchBilibiliUser(uid)
}

/**
 * Clear visible signals when the uid changes (e.g. SPA navigation in a
 * future world where this runs across route changes). Caches are
 * preserved so flipping back to a previously-viewed uid is instant.
 */
export function resetInfoData(): void {
  fertilityData.value = null
  fertilityError.value = null
  bilibiliUserData.value = null
  bilibiliUserError.value = null
}

// === Display helpers ====================================================
//
// `FertilityStatus` is the 4-value upstream enum
// ('menstruating' | 'fertile' | 'ovulating' | 'normal'). Map to a
// Chinese label + emoji + color tint for the popover. Colors are lifted
// from the reference Greasemonkey scripts so the visual language stays
// consistent with the audience's existing mental model.

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

/**
 * Compact emoji used on the info button face when fertility data is
 * available. Falls back to a generic "i" indicator (rendered by the
 * button itself) when no data — keep this returning null in that case
 * rather than a placeholder so the button's empty state is unambiguous.
 */
export function getFertilityButtonEmoji(): string | null {
  const data = fertilityData.value
  if (!data) return null
  return FERTILITY_DISPLAY[data.status].emoji
}
