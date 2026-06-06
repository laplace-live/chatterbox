/**
 * Auto-quality (自动原画/最高画质): on page load, wait for bilibili's
 * `livePlayer` to exist and switch it to the highest available quality.
 * One-shot per page load — does NOT keep enforcing across the session,
 * so a user who manually picks 720p later stays on 720p.
 *
 * Credits / prior art:
 *   The `switchQuality(...)` mechanism is adapted from c-basalt's
 *   `Bilibili 直播自动追帧` userscript
 *   (https://github.com/c-basalt/bilibili-live-seeker-script, GPL-3.0).
 *   We intentionally implement only the minimum slice — no `qn=0→10000`
 *   URL rewrite, no `__NEPTUNE_IS_MY_WAIFU__` SSR interception, no
 *   `getPlayerInfo.qualityCandidates` filter patch — because the active
 *   `switchQuality` call alone catches most "started on lower quality"
 *   cases without taking on the document-start hook complexity those
 *   other tricks require.
 *
 * Strategy — event-driven, not interval-polled:
 *
 *   `window.livePlayer` is set by bilibili's player bundle as part of
 *   initialization, alongside mounting `#live-player video` in the DOM.
 *   Rather than polling for `livePlayer` to appear (the upstream's
 *   approach, ~120 wakeups across 60s), we watch the document via a
 *   `MutationObserver` and react when `#live-player video` mounts —
 *   that's a tight proxy for "the player is ready". This mirrors the
 *   element-swap observer `lib/auto-seek.ts` uses, and means a tab
 *   that's never going to mount a player (e.g. user opens a deleted
 *   room) sits idle instead of grinding through a polling loop.
 *
 *   In the rare case where `<video>` mounts but `getPlayerInfo()` /
 *   `qualityCandidates` aren't populated yet (the JS state lags the
 *   DOM mount by a few frames), we fall back to a few short
 *   setTimeout retries rather than restarting a full poll loop.
 *
 * Audio-only interaction:
 *
 *   The 仅音频 module calls `livePlayer.stopPlayback()` and runs a 1.5s
 *   watchdog that re-stops the player whenever someone (us, BLTH, etc.)
 *   re-engages the HLS pull. If we called `switchQuality()` while
 *   audio-only is active, we'd ping-pong against that watchdog and
 *   waste bandwidth. So:
 *
 *   1. The pre-flight check skips entirely if `audioOnlyEnabled` is
 *      true at the moment the player becomes available.
 *   2. The mode is one-shot: we don't re-fire later if the user toggles
 *      audio-only off mid-session. The expectation is "set quality on
 *      page load, then leave alone" — matching how the user's manual
 *      quality choice survives subsequent toggles.
 */

import { unsafeWindow } from '$'
import { appendLog } from './log'
import { getPlayerVideo } from './player-dom'
import { audioOnlyEnabled, autoQualityEnabled } from './store'

/** Short retry delay for the rare race where `<video>` is in the DOM
 *  but `livePlayer.getPlayerInfo()` hasn't been populated yet. The JS
 *  state usually catches up within a frame or two; 200ms covers slow
 *  initialisation without dragging out the user-visible delay. */
const STATE_LAG_RETRY_MS = 200

/** Maximum retries for the state-lag race. 5 × 200ms = 1s of grace
 *  before we conclude that this isn't a transient race (e.g. the room
 *  is off-air / private) and stop nudging. The observer stays
 *  installed in case a fresh mount fires later. */
const MAX_STATE_LAG_RETRIES = 10

/**
 * Minimal shape of `window.livePlayer` we depend on. We deliberately
 * only declare the methods/fields we call so bilibili's evolving
 * internal API can change unrelated fields without breaking us. (The
 * audio-only module declares its own, slightly different subset of the
 * same object — keeping them per-module rather than sharing avoids one
 * file's type widening accidentally promising surface the other
 * doesn't actually use.)
 *
 * `qualityCandidates` is what the quality menu reads from. Sniffing the
 * max `qn` from it (rather than hard-coding e.g. 10000) means we
 * automatically pick up whichever tier bilibili currently treats as
 * "highest" — important because they've added new tiers above 10000
 * (高码率 / HBR sits at qn=30000 on rooms that support it, with 原画 at
 * 10000 demoted to second place). A data-driven max keeps working when
 * the next tier ships, without a code change here.
 */
interface QualityCandidate {
  qn?: string | number
}
interface LivePlayerLike {
  getPlayerInfo?: () => {
    quality?: string | number
    qualityCandidates?: QualityCandidate[]
  } | null
  switchQuality?: (qn: string) => unknown
}

function getLivePlayer(): LivePlayerLike | null {
  // `livePlayer` lives on the page's real window. In Tampermonkey our
  // code runs in an isolated sandbox; `unsafeWindow` reaches across.
  const candidate = (unsafeWindow as unknown as { livePlayer?: LivePlayerLike }).livePlayer
  return candidate ?? null
}

let mountObserver: MutationObserver | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
let started = false
/** Set true once `tryApply()` has returned 'done' (success OR audio-
 *  only skip). All subsequent observer fires + retries no-op. */
let done = false

/**
 * Outcome of one attempt at applying the quality switch. Three states
 * because the caller needs to distinguish "transient — try again" from
 * "we did our job, stop" from "player not mounted yet, sit on the
 * observer".
 */
type ApplyResult =
  | 'done' // Switched OR already at top OR audio-only — stop.
  | 'wait-state' // <video> exists but livePlayer JS state lags — short retry.
  | 'wait-mount' // <video> not in DOM yet — keep waiting on the observer.

function tryApply(): ApplyResult {
  // Don't fight the audio-only watchdog. If audio-only is engaged at
  // the moment we'd act, just declare success — we don't want to fire
  // later when it disengages because by then the user has been
  // explicitly using the player and might have manually set a quality.
  if (audioOnlyEnabled.value) return 'done'

  // The `<video>` mount is what triggers us via the observer; if it's
  // gone the player isn't ready in any sense and there's nothing to do.
  if (!getPlayerVideo()) return 'wait-mount'

  const player = getLivePlayer()
  if (!player?.getPlayerInfo || !player.switchQuality) {
    // `<video>` is in the DOM but `livePlayer` isn't installed yet —
    // the JS-state-lag race. Short retry handles this.
    return 'wait-state'
  }

  let info: {
    quality?: string | number
    qualityCandidates?: QualityCandidate[]
  } | null = null
  try {
    info = player.getPlayerInfo() ?? null
  } catch (err) {
    console.warn('[auto-quality] getPlayerInfo threw:', err)
    return 'wait-state'
  }
  if (!info) return 'wait-state'

  const current = Number(info.quality)
  if (!Number.isFinite(current)) return 'wait-state'

  const candidates = info.qualityCandidates ?? []
  if (candidates.length === 0) {
    // Player object exists but hasn't finished negotiating with the
    // server yet — the menu's just empty. Try again shortly.
    return 'wait-state'
  }

  // Pick the highest qn the player advertises. This is the menu's top
  // entry — historically 原画 (qn=10000) but now 高码率 (qn=30000) on rooms
  // that have it. Data-driven max means we always land on whatever
  // bilibili currently considers "best".
  let maxQn = current
  for (const c of candidates) {
    const n = Number(c.qn)
    if (Number.isFinite(n) && n > maxQn) maxQn = n
  }
  if (maxQn <= current) return 'done' // already at the top, nothing to do

  try {
    player.switchQuality(String(maxQn))
    appendLog(`📺 已切换至最高画质 qn=${maxQn}（原 qn=${current}）`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[auto-quality] switchQuality failed:', err)
    appendLog(`⚠️ 切换最高画质失败：${msg}`)
  }
  return 'done'
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function destroyObserver(): void {
  mountObserver?.disconnect()
  mountObserver = null
}

function shutdown(): void {
  done = true
  destroyObserver()
  clearRetry()
}

/**
 * Try a switch and route the outcome through the observer / retry
 * state machine. Called from three places: the cold-start probe in
 * `ensureMountObserver`, the `MutationObserver` callback, and the
 * state-lag setTimeout.
 */
function attempt(): void {
  if (done) return
  const result = tryApply()
  if (result === 'done') {
    shutdown()
    return
  }
  if (result === 'wait-state') {
    // `<video>` is up but JS state isn't ready. Schedule a short
    // retry rather than waiting for the next mutation, which might
    // never come in this transient window. The observer stays
    // installed so a later full re-mount can also fire us.
    if (retryTimer !== null) return // already scheduled
    if (retryCount >= MAX_STATE_LAG_RETRIES) {
      // Likely a not-actually-streaming room (off-air / private).
      // Stop retrying so we don't keep nudging the bilibili player
      // module. The observer stays alive so a later mutation (e.g.
      // room goes live) can reset things via the mount path.
      return
    }
    retryCount++
    retryTimer = setTimeout(() => {
      retryTimer = null
      attempt()
    }, STATE_LAG_RETRY_MS)
  }
  // result === 'wait-mount' is implicit: just let the observer keep
  // listening for the next mutation.
}

function ensureMountObserver(): void {
  if (mountObserver) return
  // Reset retry counter on each fresh observer install. The "wait-
  // state" path increments it per scheduled retry until success or
  // the max; a subsequent observer-driven mount also resets it.
  retryCount = 0
  const onMutation = (): void => {
    if (done) {
      destroyObserver()
      return
    }
    // Cheap query: most mutations on bilibili pages don't touch
    // `#live-player video`, so this returns null fast and we no-op.
    const v = getPlayerVideo()
    if (!v) return
    // Reset retry counter on each fresh mount — a new `<video>`
    // appearing means a new state-lag window is acceptable.
    retryCount = 0
    attempt()
  }
  mountObserver = new MutationObserver(onMutation)
  // Observe document-wide so we catch the mount regardless of where
  // bilibili's SPA renders the player. `childList + subtree` is the
  // cheapest tier that catches added nodes anywhere in the tree; the
  // actual filter is the `querySelector` inside the callback (also
  // cheap — no live `<video>` element on most pages until the player
  // mounts).
  mountObserver.observe(document.documentElement, { childList: true, subtree: true })
  // Cold-start probe: in case the `<video>` is already in the DOM by
  // the time we get wired up (e.g. SPA navigation within the same
  // tab), run one attempt immediately rather than waiting for the
  // next unrelated mutation to fire the callback.
  onMutation()
}

/**
 * Public entrypoint. Wired up once from `app.tsx` on the live host.
 * Idempotent — repeat calls do nothing once the one-shot has fired.
 *
 * Reads `autoQualityEnabled` at start time, NOT reactively, because the
 * feature is conceptually "on page load, do this thing once". Toggling
 * the setting later takes effect on the next page load, matching how
 * users intuitively expect a "set initial quality" preference to work.
 */
export function startAutoQuality(): void {
  if (started) return
  started = true
  if (!autoQualityEnabled.value) return
  ensureMountObserver()
}

export function stopAutoQuality(): void {
  destroyObserver()
  clearRetry()
  // `started` and `done` deliberately NOT reset: the one-shot
  // semantics mean a remount (e.g. HMR) should NOT re-fire the
  // switch. A real page reload resets module state anyway, which is
  // the correct way to re-arm this feature.
}
