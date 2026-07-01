/**
 * Auto-quality: one-shot per page load, switch bilibili's `livePlayer` to the
 * highest available quality; a later manual pick is left alone.
 *
 * `switchQuality` adapted from c-basalt's `Bilibili 直播自动追帧` (GPL-3.0).
 * Event-driven via MutationObserver on `#live-player video` (not polled). Skips
 * entirely if audio-only is engaged, to avoid ping-ponging its stop watchdog.
 */

import { unsafeWindow } from '$'
import { appendLog } from './log'
import { getPlayerVideo } from './player-dom'
import { audioOnlyEnabled, autoQualityEnabled } from './store'

/** Retry delay (ms) for the race where `<video>` is mounted but `getPlayerInfo()` isn't populated yet. */
const STATE_LAG_RETRY_MS = 200

/** Max state-lag retries before giving up (likely off-air/private); observer stays installed. */
const MAX_STATE_LAG_RETRIES = 10

/**
 * Minimal shape of `window.livePlayer` we depend on; declaring only what we call
 * shields us from unrelated API churn. Sniffing max `qn` from `qualityCandidates`
 * (vs hard-coding 10000) keeps working as new tiers ship, e.g. 高码率 at qn=30000.
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
  // `livePlayer` lives on the page's real window; `unsafeWindow` reaches past the sandbox.
  const candidate = (unsafeWindow as unknown as { livePlayer?: LivePlayerLike }).livePlayer
  return candidate ?? null
}

let mountObserver: MutationObserver | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryCount = 0
let started = false
/** True once applied (success or audio-only skip); subsequent fires/retries no-op. */
let done = false

/** Outcome of one quality-switch attempt. */
type ApplyResult =
  | 'done' // Switched OR already at top OR audio-only — stop.
  | 'wait-state' // <video> exists but livePlayer JS state lags — short retry.
  | 'wait-mount' // <video> not in DOM yet — keep waiting on the observer.

function tryApply(): ApplyResult {
  // Don't fight the audio-only watchdog; declaring 'done' also avoids re-firing
  // later, by when the user may have manually chosen a quality.
  if (audioOnlyEnabled.value) return 'done'

  if (!getPlayerVideo()) return 'wait-mount'

  const player = getLivePlayer()
  if (!player?.getPlayerInfo || !player.switchQuality) {
    return 'wait-state' // `<video>` mounted but `livePlayer` not installed yet
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
    return 'wait-state' // player hasn't finished negotiating quality with the server
  }

  let maxQn = current
  for (const c of candidates) {
    const n = Number(c.qn)
    if (Number.isFinite(n) && n > maxQn) maxQn = n
  }
  if (maxQn <= current) return 'done'

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

/** Try a switch and route the outcome through the observer/retry state machine. */
function attempt(): void {
  if (done) return
  const result = tryApply()
  if (result === 'done') {
    shutdown()
    return
  }
  if (result === 'wait-state') {
    // Retry on a timer rather than the next mutation, which may never come here.
    if (retryTimer !== null) return
    if (retryCount >= MAX_STATE_LAG_RETRIES) {
      // likely off-air/private; observer stays alive
      return
    }
    retryCount++
    retryTimer = setTimeout(() => {
      retryTimer = null
      attempt()
    }, STATE_LAG_RETRY_MS)
  }
  // 'wait-mount': let the observer keep listening.
}

function ensureMountObserver(): void {
  if (mountObserver) return
  retryCount = 0
  const onMutation = (): void => {
    if (done) {
      destroyObserver()
      return
    }
    const v = getPlayerVideo()
    if (!v) return
    retryCount = 0 // fresh mount → new state-lag window
    attempt()
  }
  mountObserver = new MutationObserver(onMutation)
  // Document-wide since the SPA may render the player anywhere; the querySelector
  // in the callback is the real (cheap) filter.
  mountObserver.observe(document.documentElement, { childList: true, subtree: true })
  onMutation() // cold-start probe: `<video>` may already be mounted (SPA nav)
}

/**
 * Public entrypoint; idempotent. Reads `autoQualityEnabled` once at start (not
 * reactively) — toggling it takes effect on the next page load.
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
  // `started`/`done` deliberately NOT reset: a remount (e.g. HMR) must not
  // re-fire; a real page reload re-arms via fresh module state.
}
