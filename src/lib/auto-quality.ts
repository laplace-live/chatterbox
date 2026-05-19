/**
 * Auto-quality (自动原画): on page load, wait for bilibili's `livePlayer`
 * to exist and switch it to 原画 (qn=10000) if it landed on a lower
 * quality. One-shot per page load — does NOT keep enforcing across the
 * session, so a user who manually picks 720p later stays on 720p.
 *
 * Credits / prior art:
 *   The `switchQuality('10000')` mechanism is adapted from c-basalt's
 *   `Bilibili 直播自动追帧` userscript
 *   (https://github.com/c-basalt/bilibili-live-seeker-script, GPL-3.0).
 *   We intentionally implement only the minimum slice — no `qn=0→10000`
 *   URL rewrite, no `__NEPTUNE_IS_MY_WAIFU__` SSR interception, no
 *   `getPlayerInfo.qualityCandidates` patch — because the active
 *   `switchQuality` call alone catches most "started on lower quality"
 *   cases without taking on the document-start hook complexity those
 *   other tricks require.
 *
 * Audio-only interaction:
 *
 * The 仅音频 module calls `livePlayer.stopPlayback()` and runs a 1.5s
 * watchdog that re-stops the player whenever someone (us, BLTH, etc.)
 * re-engages the HLS pull. If we called `switchQuality()` while
 * audio-only is active, we'd ping-pong against that watchdog and waste
 * bandwidth. So:
 *
 * 1. The pre-flight check skips entirely if `audioOnlyEnabled` is true
 *    at the moment the player becomes available.
 * 2. The mode is one-shot: we don't re-fire later if the user toggles
 *    audio-only off mid-session. The expectation is "set quality on
 *    page load, then leave alone" — matching how the user's manual
 *    quality choice survives subsequent toggles.
 */

import { unsafeWindow } from '$'
import { appendLog } from './log'
import { audioOnlyEnabled, autoQualityEnabled } from './store'

/** How long to keep polling for `livePlayer` before giving up. Bilibili's
 *  player typically mounts within 2-5s of page load even on a cold tab,
 *  so 60s is generous — covers slow networks and the SPA round-trip
 *  for a deep-linked room URL. */
const PLAYER_WAIT_TIMEOUT_MS = 60_000

/** Poll cadence while waiting for `livePlayer`. 500ms matches c-basalt's
 *  upstream and is low enough to feel instantaneous on a fast load
 *  while not burning CPU on slow loads. */
const PLAYER_POLL_INTERVAL_MS = 500

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

let pollTimer: ReturnType<typeof setTimeout> | null = null
let started = false

/**
 * Attempt the quality switch. Returns true iff we either successfully
 * fired `switchQuality` or determined no switch was needed (already at
 * 原画) — i.e. the polling loop can stop. Returns false if `livePlayer`
 * isn't ready yet so the caller should keep polling.
 */
function tryApply(): boolean {
  const player = getLivePlayer()
  if (!player?.getPlayerInfo || !player.switchQuality) return false

  // Don't fight the audio-only watchdog. If audio-only is engaged at
  // the moment we'd act, just declare success — we don't want to fire
  // later when it disengages because by then the user has been
  // explicitly using the player and might have manually set a quality.
  if (audioOnlyEnabled.value) {
    return true
  }

  let info: {
    quality?: string | number
    qualityCandidates?: QualityCandidate[]
  } | null = null
  try {
    info = player.getPlayerInfo() ?? null
  } catch (err) {
    console.warn('[auto-quality] getPlayerInfo threw:', err)
    return false
  }
  if (!info) return false

  const current = Number(info.quality)
  if (!Number.isFinite(current)) return false

  // Wait for the candidate list to populate. Empty candidates means
  // the player hasn't finished negotiating with the server; trying to
  // switch now would either no-op or fall back to whatever default
  // bilibili chose. Returning false here keeps the polling loop alive
  // so we retry on the next tick.
  const candidates = info.qualityCandidates ?? []
  if (candidates.length === 0) return false

  // Pick the highest qn the player advertises. This is the menu's top
  // entry — historically 原画 (qn=10000) but now 高码率 (qn=30000) on rooms
  // that have it. Data-driven max means we always land on whatever
  // bilibili currently considers "best".
  let maxQn = current
  for (const c of candidates) {
    const n = Number(c.qn)
    if (Number.isFinite(n) && n > maxQn) maxQn = n
  }
  if (maxQn <= current) return true // already at the top, nothing to do

  try {
    player.switchQuality(String(maxQn))
    appendLog(`📺 已切换至最高画质 qn=${maxQn}（原 qn=${current}）`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[auto-quality] switchQuality failed:', err)
    appendLog(`⚠️ 切换最高画质失败：${msg}`)
  }
  return true
}

function clearPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

/**
 * Public entrypoint. Wired up once from `app.tsx` (or `main.tsx`) on
 * the live host. Idempotent — repeat calls do nothing once the one-shot
 * has fired.
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

  const deadline = Date.now() + PLAYER_WAIT_TIMEOUT_MS
  const poll = (): void => {
    pollTimer = null
    if (tryApply()) return
    if (Date.now() >= deadline) {
      console.warn('[auto-quality] timed out waiting for livePlayer')
      return
    }
    pollTimer = setTimeout(poll, PLAYER_POLL_INTERVAL_MS)
  }
  poll()
}

export function stopAutoQuality(): void {
  clearPoll()
  // `started` deliberately NOT reset: the one-shot semantics mean a
  // remount (e.g. HMR) should NOT re-fire the switch. A real page
  // reload resets module state anyway, which is the correct way to
  // re-arm this feature.
}
