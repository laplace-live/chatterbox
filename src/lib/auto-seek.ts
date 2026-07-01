/**
 * Auto-seek (自动追帧): minimize live-stream latency by nudging
 * `mediaElement.playbackRate` to keep the buffered-ahead window near
 * `autoSeekBufferThreshold` seconds. Ladder/defaults adapted from
 * c-basalt's `Bilibili直播自动追帧` (GPL-3.0), reimplemented event-driven.
 *
 * - Event-driven (progress/waiting/timeupdate/playing), not interval-polled: zero wakeups while idle, throttled against event bursts.
 * - Round-play/轮播 (`live_status === 2`) serves a finite-duration VOD; the core holds 1x on finite `duration` so the ladder doesn't peg it at 1.3x. Real live reports non-finite duration.
 * - Skip while `document.hidden`; `visibilitychange` re-ticks on foreground to trim the buffer grown while hidden.
 * - Target element is swapped by B站 (quality/roundplay) and by audio-only engage/refresh; a `MutationObserver` re-attaches, every tick re-queries.
 */

import { effect } from '@preact/signals'

import { AUDIO_EL_ID } from './audio-only'
import { decidePlaybackRate } from './auto-seek-rate'
import { getPlayerVideo } from './player-dom'
import {
  audioOnlyEnabled,
  autoSeekBufferThreshold,
  autoSeekCurrentBufferLen,
  autoSeekCurrentRate,
  autoSeekEnabled,
} from './store'

// Throttle adjacent ticks so a `progress`+`timeupdate` burst doesn't cause multiple
// `playbackRate` writes. 150ms: below the ~150ms perceptible window, above burst spacing (<16ms).
const TICK_THROTTLE_MS = 150

// `playbackRate` reads/writes carry FP noise; ignore sub-1% deltas to avoid spurious
// browser-side "rate changed" work.
const RATE_EPSILON = 0.005

// === Element & listener tracking ========================================

/** Media element we currently have listeners on (page `<video>` or hidden audio-only `<audio>`). */
let attachedMedia: HTMLMediaElement | null = null

/** DOM observer that re-attaches when the target media element mounts or swaps. */
let containerObserver: MutationObserver | null = null

/** Last tick timestamp for throttling. */
let lastTickAt = 0

/** Pending throttled-tick handle, if any. */
let pendingTickTimer: ReturnType<typeof setTimeout> | null = null

/** Dispose handle for the @preact/signals effect that drives start/stop. */
let stateEffectDispose: (() => void) | null = null

// === Helpers ============================================================

/**
 * Pick the element to seek on: hidden `<audio>` in audio-only mode (native player stopped), else the `<video>`.
 * @returns `null` during transitions (element not yet mounted / being torn down) — caller skips the tick.
 */
function getMediaTarget(): HTMLMediaElement | null {
  if (audioOnlyEnabled.value) {
    const el = document.getElementById(AUDIO_EL_ID)
    return el instanceof HTMLAudioElement ? el : null
  }
  return getPlayerVideo()
}

function getBufferLen(m: HTMLMediaElement): number | null {
  try {
    if (m.buffered.length === 0) return null
    const len = m.buffered.end(m.buffered.length - 1) - m.currentTime
    return Number.isFinite(len) ? len : null
  } catch {
    // `buffered.end(n)` can throw INDEX_SIZE_ERR if the range shifted between the length and index reads.
    return null
  }
}

function setRate(m: HTMLMediaElement, rate: number): void {
  if (Math.abs(m.playbackRate - rate) < RATE_EPSILON) {
    // Re-sync the signal in case another script wrote `playbackRate` directly.
    if (Math.abs(autoSeekCurrentRate.value - m.playbackRate) > RATE_EPSILON) {
      autoSeekCurrentRate.value = m.playbackRate
    }
    return
  }
  m.playbackRate = rate
  autoSeekCurrentRate.value = rate
}

// === Core tick logic ====================================================

/** Inspect the current media buffer and maybe adjust `playbackRate`. */
function tick(): void {
  // Backgrounded tabs throttle our event sources to ~1Hz; skip and trim on visibilitychange.
  if (document.hidden) return

  const m = getMediaTarget()
  if (!m) return
  if (m.paused) {
    // Publish at-rest values so the metrics panel isn't stale.
    autoSeekCurrentRate.value = m.playbackRate
    const buf = getBufferLen(m)
    if (buf !== null) autoSeekCurrentBufferLen.value = buf
    return
  }

  const bufferLen = getBufferLen(m)
  if (bufferLen === null) return
  autoSeekCurrentBufferLen.value = bufferLen

  // `null` = core declines (misconfigured threshold); leave the rate alone. The core's
  // round-play guard also holds 1x on finite `duration` (offline VOD, live_status === 2)
  // so a recording's prebuffer doesn't pin playback at 1.3x.
  const target = decidePlaybackRate(bufferLen, autoSeekBufferThreshold.value, m.duration)
  if (target === null) {
    autoSeekCurrentRate.value = m.playbackRate
    return
  }
  setRate(m, target)
}

function scheduleTick(): void {
  const now = Date.now()
  const elapsed = now - lastTickAt
  if (elapsed >= TICK_THROTTLE_MS) {
    lastTickAt = now
    tick()
    return
  }
  // Coalesce: a queued tick will pick up the latest state when it fires.
  if (pendingTickTimer !== null) return
  pendingTickTimer = setTimeout(() => {
    pendingTickTimer = null
    lastTickAt = Date.now()
    tick()
  }, TICK_THROTTLE_MS - elapsed)
}

// === Listener (de)attach ================================================

const EVENTS_OF_INTEREST: ReadonlyArray<keyof HTMLMediaElementEventMap> = [
  // primary trigger: fires as the buffer grows (2-10Hz on live streams)
  'progress',
  // stall — catches a buffer drained between two `timeupdate`s
  'waiting',
  // safety net: fires ~4Hz so a sustained out-of-target buffer can't sit unfixed
  'timeupdate',
  // resync after stall/seek
  'playing',
  // reflect an external rate override in the metrics panel; doesn't seek
  'ratechange',
]

function attachListeners(m: HTMLMediaElement): void {
  if (attachedMedia === m) return
  detachListeners()
  for (const evt of EVENTS_OF_INTEREST) {
    m.addEventListener(evt, scheduleTick, { passive: true })
  }
  attachedMedia = m
  // Run an immediate tick so the metrics panel populates right away.
  scheduleTick()
}

function detachListeners(): void {
  if (!attachedMedia) return
  for (const evt of EVENTS_OF_INTEREST) {
    attachedMedia.removeEventListener(evt, scheduleTick)
  }
  attachedMedia = null
}

/** Watch the DOM for target media element swaps (quality/roundplay/audio-only) and re-attach. */
function ensureContainerObserver(): void {
  if (containerObserver) return
  const apply = (): void => {
    const target = getMediaTarget()
    if (target && target !== attachedMedia) {
      attachListeners(target)
    } else if (!target && attachedMedia) {
      // Target gone mid-cycle — drop the handle; the next observer hit re-attaches.
      detachListeners()
      autoSeekCurrentBufferLen.value = 0
      autoSeekCurrentRate.value = 1
    }
  }
  // Initial attach for a target already in the DOM.
  apply()
  // Document-wide so we catch the new element in any mode, including cold start.
  containerObserver = new MutationObserver(apply)
  containerObserver.observe(document.documentElement, { childList: true, subtree: true })
}

function destroyContainerObserver(): void {
  containerObserver?.disconnect()
  containerObserver = null
}

// Re-resolve the target on a video↔audio-only flip immediately, not on the next observer
// tick: otherwise the seeker keeps ticking a `<video>` the native player already stopped
// feeding (or vice versa), publishing misleading buffer numbers until the observer fires.
effect(() => {
  void audioOnlyEnabled.value // subscribe; read is the dependency trigger, value unused
  if (!autoSeekEnabled.value) return
  const target = getMediaTarget()
  if (target) {
    attachListeners(target)
  } else if (attachedMedia) {
    detachListeners()
    autoSeekCurrentBufferLen.value = 0
    autoSeekCurrentRate.value = 1
  }
})

// On tab-foreground, tick once to resync the buffer grown while hidden.
function onVisibilityChange(): void {
  if (!document.hidden) scheduleTick()
}

// === Public entrypoints =================================================

/** Wire up auto-seek. Idempotent; tracks `autoSeekEnabled` so toggling takes effect without reload. */
export function startAutoSeek(): void {
  if (stateEffectDispose) return
  stateEffectDispose = effect(() => {
    const enabled = autoSeekEnabled.value
    if (enabled) {
      ensureContainerObserver()
      document.addEventListener('visibilitychange', onVisibilityChange)
    } else {
      destroyContainerObserver()
      detachListeners()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (pendingTickTimer !== null) {
        clearTimeout(pendingTickTimer)
        pendingTickTimer = null
      }
      // Reset metrics so the panel doesn't look busy after disable.
      autoSeekCurrentBufferLen.value = 0
      autoSeekCurrentRate.value = 1
      // Restore both possible targets to 1x — either could be sitting at a nudged rate.
      const v = getPlayerVideo()
      if (v && Math.abs(v.playbackRate - 1) > RATE_EPSILON) {
        v.playbackRate = 1
      }
      const a = document.getElementById(AUDIO_EL_ID)
      if (a instanceof HTMLAudioElement && Math.abs(a.playbackRate - 1) > RATE_EPSILON) {
        a.playbackRate = 1
      }
    }
  })
}

export function stopAutoSeek(): void {
  if (stateEffectDispose) {
    stateEffectDispose()
    stateEffectDispose = null
  }
  destroyContainerObserver()
  detachListeners()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (pendingTickTimer !== null) {
    clearTimeout(pendingTickTimer)
    pendingTickTimer = null
  }
}
