/**
 * Pure tier/duration logic for the SC pin strip.
 *
 * Why a separate file: this file holds NO DOM / signal / timer code. Every
 * function here is pure (input → output, no I/O). The pin strip's lifecycle
 * module (`custom-chat-sc-pinstrip.ts`) and its tests both consume this.
 * Pure-helper extraction matches the pattern already used elsewhere
 * (`loop-utils.ts`, `auto-blend-trend.ts`, `meme-content-key.ts`).
 *
 * Design philosophy: durations are picked for the READER's experience, not
 * for the streamer's revenue moment. B 站 native pins SC for 1/2/5/10/30/60
 * minutes — that's their economic logic (longer pin = more attention to the
 * payment event). For a chat-reading user, a 30-minute pin = 30 minutes of
 * lost chat real estate. We cap at 5 minutes even for ¥10000+ SCs because
 * beyond that, the pin stops being information and becomes noise.
 *
 * The pin strip is a horizontal carousel that auto-rotates through ALL active
 * SCs, so capacity is not limited by the duration choice — it's only limited
 * by how long each SC stays pinned. Short durations + unlimited concurrent
 * SCs = fast turnover, no UI bloat regardless of room intensity.
 */

export type SCTierId = 'T1' | 'T2' | 'T3' | 'T4' | 'T5'

export interface SCTier {
  id: SCTierId
  /** Human-readable label. Not shown in UI by default — the yuan-amount badge
   *  is the user's primary read of "how big a SC this is". The tier name is
   *  here for log lines / accessibility / debug surfaces only. */
  label: string
  /** Pin duration in seconds. Picked for reader experience, not streamer
   *  economics — see file header. */
  durationSec: number
  /** Inclusive lower bound in yuan (元). The tier function picks the highest
   *  tier whose minAmount ≤ amount. */
  minAmount: number
}

/**
 * Tier table. ORDER MATTERS — must be sorted by minAmount ascending; the
 * picker function walks this list and keeps the last match.
 *
 * Calibration notes:
 *  - T1 (¥30-49, 15 s): the minimum Bilibili SC tier. 15 s is enough for a
 *    slow reader to spot it + read 1 sentence. Anything shorter and SCs from
 *    busy rooms would feel like they "flashed by".
 *  - T2 (¥50-99, 30 s): the most common tier in mid-popularity rooms.
 *    30 s ≈ a full reading + a moment to react.
 *  - T3 (¥100-499, 1 min): a deliberate payment, not impulse. Pin for the
 *    full minute so other readers also see the SC if they were scrolled away.
 *  - T4 (¥500-999, 2 min): rare-ish, big spender, deserves longer pin.
 *  - T5 (¥1000+, 5 min CAP): yes, even a ¥50000 SC caps at 5 min. The
 *    purpose of pin is to *guarantee the reader sees it*, not to be a
 *    monument to the payment. 5 min is way past "saw it" and well into
 *    "I get it, scroll on".
 */
export const SC_TIERS: readonly SCTier[] = [
  { id: 'T1', label: '微光', durationSec: 15, minAmount: 0 },
  { id: 'T2', label: '心意', durationSec: 30, minAmount: 50 },
  { id: 'T3', label: '醒目', durationSec: 60, minAmount: 100 },
  { id: 'T4', label: '高调', durationSec: 120, minAmount: 500 },
  { id: 'T5', label: '巅峰', durationSec: 300, minAmount: 1000 },
] as const

/** Pick the tier for a yuan amount. Always returns SOMETHING — even
 *  amount = 0 / negative / NaN falls back to T1, so the renderer can
 *  blindly call this without null-checking. */
export function scAmountToTier(amountYuan: number | undefined): SCTier {
  const yuan = Number.isFinite(amountYuan) ? Math.max(0, amountYuan as number) : 0
  let tier = SC_TIERS[0]
  for (const t of SC_TIERS) {
    if (yuan >= t.minAmount) tier = t
  }
  return tier
}

/** Convenience: tier duration in milliseconds, since the lifecycle module
 *  works in ms for setTimeout / Date.now() diffs. */
export function scAmountToDurationMs(amountYuan: number | undefined): number {
  return scAmountToTier(amountYuan).durationSec * 1000
}

/** "1:23" / "0:05". Used by the strip's countdown overlay and the dot
 *  accessibility label. Defensive against negative / NaN inputs. */
export function formatRemainingTime(msLeft: number): string {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return '0:00'
  const totalSec = Math.ceil(msLeft / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

/** Tier id → ARIA-friendly label for screen readers. */
export function tierAccessibilityLabel(tier: SCTier, amountYuan: number): string {
  return `${tier.label}级 醒目留言 ¥${amountYuan}，将驻留 ${tier.durationSec} 秒`
}
