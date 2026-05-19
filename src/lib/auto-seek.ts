/**
 * Auto-seek (自动追帧): minimize live-stream latency by nudging
 * `mediaElement.playbackRate` so the buffered-ahead window stays close
 * to `autoSeekBufferThreshold` seconds.
 *
 * Credits / prior art:
 *   Algorithm design (threshold ladder, slowdown-takes-priority,
 *   default values) is adapted from c-basalt's `Bilibili直播自动追帧`
 *   userscript — https://github.com/c-basalt/bilibili-live-seeker-script
 *   (greasyfork id 439875, GPL-3.0). We reimplemented it on an event
 *   loop instead of `setInterval(50ms)` polling (see below), share
 *   nothing of the original UI / GM-storage layer, and — because this
 *   project is AGPL-3.0 — are compatible downstream of GPL-3.0.
 *
 * Strategy — event-driven, not interval-polled:
 *
 * - We listen for the media element's native `progress`, `waiting`,
 *   `timeupdate`, and `playing` events. The browser already fires these
 *   whenever the buffer state changes meaningfully; piggy-backing on
 *   them means zero wakeups while paused / background / idle, and we
 *   react faster than a 50ms `setInterval` could (which is the cadence
 *   c-basalt's upstream uses for slowdown). A short throttle (~80ms)
 *   keeps us from doing redundant work when `timeupdate` and `progress`
 *   fire on the same tick.
 *
 * - Speed ladder mirrors c-basalt's field-tested values (default config
 *   in their `Bilibili直播自动追帧` userscript):
 *   speedup `[[2, 1.3], [1, 1.2], [0, 1.1]]`  — entries are
 *   `[extraSecondsOverThreshold, rate]`, evaluated in order; the first
 *   match wins. Slowdown ladder `[[0.2, 0.1], [0.3, 0.3], [0.6, 0.6]]`
 *   entries are `[bufferLenAbsolute, rate]`, used to back off as the
 *   buffer drains to avoid stalls.
 *
 * - **Audio-only mode works the same way**: when `audioOnlyEnabled` is
 *   true we target the hidden `<audio id='lc-audio-only-stream'>`
 *   element instead of `#live-player video`. `HTMLAudioElement` shares
 *   the `HTMLMediaElement` `buffered` / `currentTime` / `playbackRate`
 *   surface with `HTMLVideoElement`, so the seek logic is identical —
 *   and audio-only's mpegts.js pipeline writes into the element's
 *   MediaSource, exposing buffer info just like the native player does.
 *
 * - We **do not** touch the rate while `document.hidden` is true.
 *   Backgrounded tabs already throttle setInterval to ~1Hz, and the
 *   user can't perceive latency on a tab they aren't looking at.
 *   `visibilitychange` re-runs a tick on tab-foreground so we resync
 *   as soon as attention returns.
 *
 * - The media element gets replaced on quality switches, audio-only
 *   off→on→off cycles, and audio-only stream URL refreshes. A
 *   `MutationObserver` on `document.documentElement` re-attaches our
 *   listeners to whatever the current target is. We never hold a
 *   long-lived reference to an old element — every tick re-queries.
 *
 * Live metrics (buffer length, current rate, last-adjust timestamp,
 * total seek count) are exposed via signals so `SettingsTab` can render
 * a real-time "你当前的延迟" panel without polling us.
 */

import { effect } from '@preact/signals'

import { AUDIO_EL_ID } from './audio-only'
import {
  audioOnlyEnabled,
  autoSeekBufferThreshold,
  autoSeekCurrentBufferLen,
  autoSeekCurrentRate,
  autoSeekEnabled,
} from './store'

// Speed ladders — `[delta, rate]` for speedup (delta = bufferLen - threshold)
// and `[absBufferLen, rate]` for slowdown (compared against bufferLen
// directly, no threshold offset).
const SPEEDUP_LADDER: ReadonlyArray<readonly [number, number]> = [
  [2, 1.3],
  [1, 1.2],
  [0, 1.1],
]
const SLOWDOWN_LADDER: ReadonlyArray<readonly [number, number]> = [
  [0.2, 0.1],
  [0.3, 0.3],
  [0.6, 0.6],
]

// Throttle adjacent ticks so a burst of `progress` + `timeupdate` events
// on the same animation frame doesn't translate into multiple
// `playbackRate` writes. 80ms is well below the user-perceptible reaction
// window (~150ms) but above typical event-burst spacing (<16ms).
const TICK_THROTTLE_MS = 80

// `playbackRate` reads/writes carry FP noise; comparing to 2 decimals
// matches c-basalt's upstream and avoids spurious browser-side
// "rate changed" work for sub-1% deltas.
const RATE_EPSILON = 0.005

// === Element & listener tracking ========================================

/** The media element we currently have listeners attached to (either the
 *  page's `<video>` or our hidden audio-only `<audio>`). Cleared by
 *  `detachListeners()`; replaced whenever B站 swaps the `<video>` (quality
 *  switch, audio-only toggle, etc.) or the audio-only module recreates
 *  its hidden `<audio>` (refresh cycle). */
let attachedMedia: HTMLMediaElement | null = null

/** DOM observer that re-attaches when the target media element mounts,
 *  swaps, or the audio-only mode toggles between video and audio. */
let containerObserver: MutationObserver | null = null

/** Last tick timestamp for throttling. */
let lastTickAt = 0

/** Pending throttled-tick handle, if any. */
let pendingTickTimer: ReturnType<typeof setTimeout> | null = null

/** Dispose handle for the @preact/signals effect that drives start/stop. */
let stateEffectDispose: (() => void) | null = null

// === Helpers ============================================================

/**
 * Pick the right element to seek on based on the current mode. In
 * audio-only mode the `<video>` is hidden and the native player is
 * stopped, so the only stream actually flowing data is our hidden
 * `<audio>` — that's what we need to rate-adjust. Otherwise the native
 * `<video>` is the live source.
 *
 * Returns `null` during transitions (audio-only engaging but `<audio>`
 * not yet mounted, or quality-switch tearing down `<video>`); callers
 * just skip the tick and the next event will re-try.
 */
function getMediaTarget(): HTMLMediaElement | null {
  if (audioOnlyEnabled.value) {
    const el = document.getElementById(AUDIO_EL_ID)
    return el instanceof HTMLAudioElement ? el : null
  }
  return document.querySelector<HTMLVideoElement>('#live-player video')
}

function getBufferLen(m: HTMLMediaElement): number | null {
  try {
    if (m.buffered.length === 0) return null
    const len = m.buffered.end(m.buffered.length - 1) - m.currentTime
    return Number.isFinite(len) ? len : null
  } catch {
    // `buffered.end(n)` can throw INDEX_SIZE_ERR if the source range
    // shifted underneath us between the length read and the index read.
    return null
  }
}

function setRate(m: HTMLMediaElement, rate: number): void {
  if (Math.abs(m.playbackRate - rate) < RATE_EPSILON) {
    // Still publish the current rate in case the signal got out of sync
    // with reality (e.g. another script wrote `playbackRate` directly).
    if (Math.abs(autoSeekCurrentRate.value - m.playbackRate) > RATE_EPSILON) {
      autoSeekCurrentRate.value = m.playbackRate
    }
    return
  }
  m.playbackRate = rate
  autoSeekCurrentRate.value = rate
}

function resetRate(m: HTMLMediaElement): void {
  setRate(m, 1.0)
}

// === Core tick logic ====================================================

/**
 * Inspect the current media buffer and (maybe) adjust `playbackRate`.
 * Works the same for `<video>` (normal mode) and `<audio>` (audio-only
 * mode) because both inherit the `HTMLMediaElement` buffered/rate API.
 * Cheap — safe to call on every event, but throttled by `scheduleTick`
 * so we don't do redundant work on event bursts.
 */
function tick(): void {
  // Bail when the tab is backgrounded. The browser already throttles
  // our event sources to ~1Hz here; touching `playbackRate` while
  // hidden would just queue an `onratechange` for the foreground flush.
  // (Audio-only is interesting on a backgrounded tab — the user is
  // still listening — but the throttling means we wouldn't get reliable
  // event ticks anyway, and the buffer growing to a few seconds extra
  // while hidden is fine; we'll trim it on visibility change.)
  if (document.hidden) return

  const m = getMediaTarget()
  if (!m) return
  if (m.paused) {
    // Publish the at-rest values so the metrics panel reads true rather
    // than showing stale numbers from a previous tick.
    autoSeekCurrentRate.value = m.playbackRate
    const buf = getBufferLen(m)
    if (buf !== null) autoSeekCurrentBufferLen.value = buf
    return
  }

  const bufferLen = getBufferLen(m)
  if (bufferLen === null) return
  autoSeekCurrentBufferLen.value = bufferLen

  const threshold = autoSeekBufferThreshold.value
  if (!Number.isFinite(threshold) || threshold <= 0) {
    // Misconfigured threshold — keep playing at 1x and surface the
    // current rate in metrics, but don't make seeking decisions.
    autoSeekCurrentRate.value = m.playbackRate
    return
  }

  // Slowdown takes priority: a draining buffer is more user-visible
  // (imminent stall) than a slightly over-target buffer (slightly
  // higher latency).
  for (const [bufThres, rate] of SLOWDOWN_LADDER) {
    if (bufferLen < bufThres) {
      setRate(m, rate)
      return
    }
  }

  const over = bufferLen - threshold
  for (const [delta, rate] of SPEEDUP_LADDER) {
    if (over > delta) {
      setRate(m, rate)
      return
    }
  }

  // In the "comfortable" zone — restore 1x if we're currently
  // speeding up or slowing down.
  if (Math.abs(m.playbackRate - 1) > RATE_EPSILON) {
    resetRate(m)
  } else {
    autoSeekCurrentRate.value = m.playbackRate
  }
}

function scheduleTick(): void {
  const now = Date.now()
  const elapsed = now - lastTickAt
  if (elapsed >= TICK_THROTTLE_MS) {
    lastTickAt = now
    tick()
    return
  }
  // Coalesce: if a tick is already queued for this throttle window,
  // do nothing — it'll pick up the latest state when it fires.
  if (pendingTickTimer !== null) return
  pendingTickTimer = setTimeout(() => {
    pendingTickTimer = null
    lastTickAt = Date.now()
    tick()
  }, TICK_THROTTLE_MS - elapsed)
}

// === Listener (de)attach ================================================

const EVENTS_OF_INTEREST: ReadonlyArray<keyof HTMLMediaElementEventMap> = [
  // `progress` is the primary trigger: it fires whenever a media buffer
  // grows. Live streams typically tick this 2-10 times/sec.
  'progress',
  // `waiting` = the player ran out of data and is stalling. Catches the
  // edge case where buffer drained between two `timeupdate`s.
  'waiting',
  // `timeupdate` is our safety net — fires ~4Hz during playback even if
  // no other event has, so a sustained out-of-target buffer can't sit
  // unfixed.
  'timeupdate',
  // `playing` resyncs after a stall/seek so a paused→playing transition
  // immediately reconsiders the rate.
  'playing',
  // `ratechange` lets us reflect another script (or the user, via the
  // player UI) overriding playback rate so the metrics panel doesn't
  // lie about the current rate. Cheap; doesn't make us seek.
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

/**
 * Watch the DOM for target media element swaps. B站 destroys and
 * recreates `<video>` on quality changes and roundplay transitions; the
 * audio-only module also creates / destroys its `<audio>` element on
 * engage / disengage and on stream URL refresh. Without this observer
 * we'd attach to a stale element on first call and never see live data
 * again. `getMediaTarget()` picks the right one based on current mode,
 * so a single observer handles both pipelines.
 */
function ensureContainerObserver(): void {
  if (containerObserver) return
  const apply = (): void => {
    const target = getMediaTarget()
    if (target && target !== attachedMedia) {
      attachListeners(target)
    } else if (!target && attachedMedia) {
      // Target gone (e.g. audio-only engaging mid-cycle, or quality
      // switch tearing down `<video>`) — drop our handle so we don't
      // keep firing listeners against a detached element. The next
      // MutationObserver hit will re-attach once the new element mounts.
      detachListeners()
      // Reset metrics so the panel doesn't show stale numbers from a
      // since-destroyed element. The next attach's immediate tick will
      // repopulate them.
      autoSeekCurrentBufferLen.value = 0
      autoSeekCurrentRate.value = 1
    }
  }
  // Initial attach (covers the case where the target is already in the
  // DOM by the time we start).
  apply()
  // Observe document-wide so we catch the new element regardless of
  // which mode is active. Targeting `document.documentElement` also
  // handles the cold-start case where neither `#live-player` nor the
  // audio-only `<audio>` is mounted yet.
  containerObserver = new MutationObserver(apply)
  containerObserver.observe(document.documentElement, { childList: true, subtree: true })
}

function destroyContainerObserver(): void {
  containerObserver?.disconnect()
  containerObserver = null
}

// React to mode flips between video and audio-only: detach the old
// listener immediately rather than waiting for the next MutationObserver
// tick. Without this the seeker could keep ticking against a `<video>`
// element that the native player has already stopped feeding (or vice
// versa), publishing misleading buffer numbers until the observer
// fires.
effect(() => {
  // Subscribe to the signal explicitly — the read itself is the
  // dependency-tracking trigger; we don't need its value.
  void audioOnlyEnabled.value
  if (!autoSeekEnabled.value) return
  // Force a re-resolve: the current attachedMedia may be on the wrong
  // side of the mode flip now. `getMediaTarget()` picks the right one;
  // `attachListeners` is a no-op if we're already on it.
  const target = getMediaTarget()
  if (target) {
    attachListeners(target)
  } else if (attachedMedia) {
    detachListeners()
    autoSeekCurrentBufferLen.value = 0
    autoSeekCurrentRate.value = 1
  }
})

// Tab visibility: when the user returns to the tab, run one tick
// immediately so the buffer (which may have grown unbounded while
// hidden because we didn't seek it down) gets resynced ASAP.
function onVisibilityChange(): void {
  if (!document.hidden) scheduleTick()
}

// === Public entrypoints =================================================

/**
 * Wire up the auto-seek feature. Idempotent — repeat calls are no-ops.
 * Listens to `autoSeekEnabled` so the user toggling the setting takes
 * effect immediately without needing a page reload.
 */
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
      // Reset publish-only metrics so the panel doesn't look like the
      // feature is still doing work after the user disabled it.
      autoSeekCurrentBufferLen.value = 0
      autoSeekCurrentRate.value = 1
      // Also restore the actual media element to 1x if we'd nudged it
      // — a user disabling the feature expects normal playback to
      // resume, not to inherit whatever last rate we wrote. Reset both
      // possible targets (video AND audio) because either could be
      // sitting at a non-1x rate when the user toggles off.
      const v = document.querySelector<HTMLVideoElement>('#live-player video')
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
