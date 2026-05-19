/**
 * Pure state machine for the SC pin strip.
 *
 * Why a separate module: keeping the queue / current-index / pause logic
 * away from DOM + timers makes the whole thing testable as pure
 * (state, event) → state' transitions. The DOM-mounting module
 * (`custom-chat-sc-pinstrip.ts`) holds onto the state, dispatches events
 * into here, and re-renders on the returned new state.
 *
 * Design notes:
 *
 *  - `active` is ordered by `pinnedAt` ASCENDING — so `active[0]` is the
 *    oldest still-pinned SC, `active[active.length-1]` is the newest. This
 *    matters for the dot indicator (rendered left → right = oldest → newest
 *    in the queue).
 *
 *  - `currentIndex` points into `active`. When a new SC arrives we ADVANCE
 *    to it (newest gets attention), unless the user is in manual-paused mode
 *    — in that case the new SC joins the queue but the visible card stays
 *    put. This is the iOS "stories" pattern: notification arrives, dot count
 *    grows, but the story you were holding stays held.
 *
 *  - `pauseUntil` is an absolute timestamp. When `> now`, auto-rotation is
 *    suppressed. After hover / swipe / key navigation, pause is set to
 *    `now + USER_INTERACTION_PAUSE_MS` (default 10s) — long enough that the
 *    user finishes reading without an annoying snap-back.
 *
 *  - We do NOT trim the queue. If 50 SCs arrive in a minute and all have
 *    valid pin times, all 50 sit in `active` and the strip dots show
 *    `+45` overflow. The auto-rotate just cycles through them. The whole
 *    point of horizontal time-multiplexing is that queue size doesn't cost
 *    layout space.
 */

import type { CustomChatEvent } from './custom-chat-events'

import { type SCTier, scAmountToDurationMs, scAmountToTier } from './custom-chat-sc-pinstrip-tier'

/** A snapshot of a single SC being pinned. */
export interface ActivePinnedSC {
  /** Stable id from `CustomChatEvent.id`, used for de-dup + DOM keys. */
  id: string
  amountYuan: number
  tier: SCTier
  uname: string
  text: string
  avatarUrl?: string
  /** Absolute ms timestamp (Date.now() style) when this SC entered the queue. */
  pinnedAt: number
  /** Absolute ms timestamp when this SC should auto-expire. */
  expiresAt: number
  /** When > 0, the user long-pressed to stick this SC past its natural
   *  expiry; the lifecycle won't auto-remove it until the user explicitly
   *  dismisses it (or it falls off the back via FIFO if many sticks pile up). */
  stuck: boolean
}

export interface PinStripState {
  /** Ordered oldest → newest. */
  active: ActivePinnedSC[]
  /** Index into `active`. -1 iff `active.length === 0`. */
  currentIndex: number
  /** Absolute ms timestamp until which auto-rotation is suppressed.
   *  0 = not paused. */
  pauseUntil: number
}

export const USER_INTERACTION_PAUSE_MS = 10_000
export const AUTO_ROTATE_INTERVAL_MS = 4_000
/** Long-press threshold for marking a card "stuck" — matches Bilibili's
 *  long-press danmaku-action threshold elsewhere in the codebase. */
export const STICK_LONG_PRESS_MS = 600

export function initialState(): PinStripState {
  return { active: [], currentIndex: -1, pauseUntil: 0 }
}

/** Build an ActivePinnedSC from a CustomChatEvent. Returns null if the event
 *  isn't an SC, lacks an amount, or has bad data — caller can safely skip. */
export function makeActiveSC(event: CustomChatEvent, now: number): ActivePinnedSC | null {
  if (event.kind !== 'superchat') return null
  const amount = Number.isFinite(event.amount) ? Math.max(0, event.amount as number) : 0
  if (amount <= 0) return null
  const tier = scAmountToTier(amount)
  return {
    id: event.id,
    amountYuan: amount,
    tier,
    uname: event.uname,
    text: event.text,
    avatarUrl: event.avatarUrl,
    pinnedAt: now,
    expiresAt: now + scAmountToDurationMs(amount),
    stuck: false,
  }
}

/** New SC arrives. Append + advance current to point at the newcomer
 *  UNLESS user is in interactive-pause mode (in which case we keep the
 *  visible card put — the new SC joins as a dot only). */
export function enqueue(state: PinStripState, sc: ActivePinnedSC, now: number): PinStripState {
  // De-dup: if an SC with the same id is already pinned (e.g. WS + DOM
  // double-emit), treat the new one as a no-op.
  if (state.active.some(item => item.id === sc.id)) return state
  const active = [...state.active, sc]
  const userPaused = state.pauseUntil > now
  const currentIndex = userPaused ? state.currentIndex : active.length - 1
  return { ...state, active, currentIndex }
}

/** Tick removes expired non-stuck SCs and adjusts currentIndex so it still
 *  points to a valid card (or -1 if empty). Idempotent and side-effect-free. */
export function tick(state: PinStripState, now: number): PinStripState {
  const survived: ActivePinnedSC[] = []
  let currentCardId: string | null = null
  if (state.currentIndex >= 0 && state.currentIndex < state.active.length) {
    currentCardId = state.active[state.currentIndex].id
  }
  for (const sc of state.active) {
    if (sc.stuck || sc.expiresAt > now) survived.push(sc)
  }
  if (survived.length === state.active.length) return state // no change
  // Re-locate currentIndex by id; if the current card got expired, fall back
  // to whatever's at the same position (clamped) — that's the next-oldest.
  let nextIndex = -1
  if (currentCardId !== null) {
    const found = survived.findIndex(sc => sc.id === currentCardId)
    if (found >= 0) {
      nextIndex = found
    } else {
      // Current card expired. Move to the same numeric position in the
      // survived list (which is the next-newest in queue order), clamped.
      nextIndex = Math.min(state.currentIndex, survived.length - 1)
    }
  } else if (survived.length > 0) {
    nextIndex = 0
  }
  return { ...state, active: survived, currentIndex: nextIndex }
}

/** Advance to next SC (wraps around). Sets pause as a side-effect of the
 *  user / auto-rotate manipulation:
 *   - `userInitiated = false` (auto-rotate): does NOT pause.
 *   - `userInitiated = true` (swipe / arrow / wheel): pauses for
 *     USER_INTERACTION_PAUSE_MS so the user can read the new card.
 */
export function next(state: PinStripState, now: number, userInitiated: boolean): PinStripState {
  if (state.active.length === 0) return state
  const currentIndex = (state.currentIndex + 1) % state.active.length
  const pauseUntil = userInitiated ? now + USER_INTERACTION_PAUSE_MS : state.pauseUntil
  return { ...state, currentIndex, pauseUntil }
}

export function prev(state: PinStripState, now: number, userInitiated: boolean): PinStripState {
  if (state.active.length === 0) return state
  const currentIndex = (state.currentIndex - 1 + state.active.length) % state.active.length
  const pauseUntil = userInitiated ? now + USER_INTERACTION_PAUSE_MS : state.pauseUntil
  return { ...state, currentIndex, pauseUntil }
}

/** Jump to a specific SC by index (e.g. dot-indicator click). Always
 *  user-initiated → always pauses. */
export function jumpTo(state: PinStripState, index: number, now: number): PinStripState {
  if (state.active.length === 0) return state
  if (index < 0 || index >= state.active.length) return state
  return { ...state, currentIndex: index, pauseUntil: now + USER_INTERACTION_PAUSE_MS }
}

/** Set pauseUntil = now + durationMs. Used for hover-pause on desktop
 *  (called repeatedly on mousemove with a short duration like 1000ms). */
export function pauseFor(state: PinStripState, now: number, durationMs: number): PinStripState {
  return { ...state, pauseUntil: now + durationMs }
}

export function resume(state: PinStripState): PinStripState {
  return { ...state, pauseUntil: 0 }
}

/** Toggle the "stuck" flag on the currently-visible SC. Stuck SCs survive
 *  their natural expiry until the user dismisses them. */
export function toggleStickCurrent(state: PinStripState): PinStripState {
  if (state.currentIndex < 0) return state
  const active = state.active.map((sc, i) => (i === state.currentIndex ? { ...sc, stuck: !sc.stuck } : sc))
  return { ...state, active }
}

/** Dismiss the currently-visible SC immediately (user swipe-up / explicit
 *  close). Falls back to the next card in queue. */
export function dismissCurrent(state: PinStripState, now: number): PinStripState {
  if (state.currentIndex < 0) return state
  const removedIndex = state.currentIndex
  const active = state.active.filter((_, i) => i !== removedIndex)
  let currentIndex = -1
  if (active.length > 0) {
    currentIndex = Math.min(removedIndex, active.length - 1)
  }
  // Dismissing is user-initiated, so pause auto-rotate for a moment so the
  // next card doesn't whiplash-rotate immediately.
  return { ...state, active, currentIndex, pauseUntil: now + USER_INTERACTION_PAUSE_MS }
}

/** True iff auto-rotation should fire on this tick: not paused, queue size
 *  > 1 (no point rotating a single card), AND it's been at least
 *  AUTO_ROTATE_INTERVAL_MS since the last advance — caller tracks
 *  "lastAutoAdvanceAt" externally since it depends on real wall time. */
export function isAutoRotateEligible(state: PinStripState, now: number, lastAdvanceAt: number): boolean {
  if (state.active.length <= 1) return false
  if (state.pauseUntil > now) return false
  if (now - lastAdvanceAt < AUTO_ROTATE_INTERVAL_MS) return false
  return true
}

/** Returns the currently-visible SC, or null if queue is empty. */
export function currentSC(state: PinStripState): ActivePinnedSC | null {
  if (state.currentIndex < 0) return null
  return state.active[state.currentIndex] ?? null
}
