/**
 * Audio-only mode for bilibili live: the web player has no audio-only
 * toggle (only the mobile app does), so we build one. Non-obvious bits:
 * - `getRoomPlayInfo?only_audio=1` signs `&ptype=1` into FLV URLs so CDN
 *   edges strip video tags on the fly (including `qn=10000` raw rooms).
 * - `stopPlayback()` truly halts the HLS pull (~0.1 req/s); `pause()`
 *   keeps the buffer fed (~2.4 req/s). `reload()` restores it, quality
 *   preserved.
 * - Watchdog re-stops on `blob:` src revert: BLTH's SwitchLiveStreamQuality
 *   re-engages the player, else you'd stream video + audio at once.
 * - Volume/mute captured BEFORE stopPlayback (which nulls getPlayerInfo).
 * - Swaps are make-before-break: the incoming stream starts beside the
 *   outgoing one and only takes over once it's actually playing.
 */

import { effect } from '@preact/signals'
// devDependency, type-only: `typeof Mpegts` mirrors the UMD pinned on
// `window.mpegts`. Nothing is bundled — we lazy-load the UMD from unpkg.
import type Mpegts from 'mpegts.js'

import { unsafeWindow } from '$'
import { ensureRoomId } from './api'
import { applyAudioOnlyVolume } from './audio-only-volume'
import { MPEGTS_CDN_URL } from './const'
import { loadUmdScript } from './load-script'
import { appendLog } from './log'
import { isTabHidden } from './page-visibility'
import {
  AUDIO_EL_ID,
  getPlayerVideo,
  isNativePlayerStreaming,
  PLAYER_CONTAINER_SELECTOR,
  resolveLivePlayer,
} from './player-dom'
import { audioOnlyActive, audioOnlyMode, audioOnlyMuted, audioOnlyVolume } from './store'
import { isIpHost, isRecord } from './utils'

// Installed by the lazy-loaded UMD; narrowed by `isMpegts`.
declare global {
  interface Window {
    mpegts?: unknown
  }
}

const HTML_FLAG_CLASS = 'lc-audio-only'
const STYLE_ID = 'lc-audio-only-style'

// Stream URLs are signed with ~1h expiry; refresh well before that closes.
const STREAM_REFRESH_MS = 50 * 60 * 1000

// Backoff for reconnecting after the FLV stream dies (stream restart, edge
// close, URL 403); the last step repeats up to the cap (~8.5 min in total).
// Bounded: an off-air room would otherwise poll forever.
const STREAM_RECOVERY_DELAYS_MS = [2000, 4000, 8000, 15000, 30000]
const STREAM_RECOVERY_MAX_ATTEMPTS = 20

/** How long the tab must stay hidden before 自动音频 engages, so a quick glance away keeps video. */
export const AUTO_ENGAGE_DELAY_MS = 3000

// Max wait for the incoming stream to start playing before a swap gives up on overlapping.
const SWAP_TIMEOUT_MS = 10_000

const STYLE = `
/* Hide the actual video element while audio keeps playing. The static
 * MP4 poster that bilibili's player shows after stopPlayback() also
 * lives inside #live-player, so this rule covers the "stopped" state
 * too without revealing a frozen frame. */
html.${HTML_FLAG_CLASS} ${PLAYER_CONTAINER_SELECTOR} video {
  visibility: hidden;
}

/* Visual hint that the player frame is intentionally blank rather than
 * broken: a centered "🎧 仅音频模式" label fades in while the flag is
 * set. Anchored to #live-player so it tracks the player size on resize. */
html.${HTML_FLAG_CLASS} ${PLAYER_CONTAINER_SELECTOR} {
  position: relative;
}
html.${HTML_FLAG_CLASS} ${PLAYER_CONTAINER_SELECTOR}::after {
  content: '🎧 LAPLACE Chatterbox - 仅音频模式';
  position: absolute;
  top: 10px;
  right: 10px;
  color: rgba(255, 255, 255, 0.85);
  text-shadow: 0 1px 6px rgba(0, 0, 0, 0.4);
  font-size: 16px;
  letter-spacing: 0.5px;
  pointer-events: none;
  z-index: 11;
}

/* Bilibili overlays a streamer-uploaded cover image (.web-player-video-
 * cover-img-wrap) on top of the video during pre-roll / connection
 * loading. In audio-only mode the video element is hidden but this
 * overlay sits on a separate layer and would otherwise stay visible
 * — obscuring our "🎧 仅音频模式" hint label. Scope to the audio-only
 * flag (matching every other rule in this stylesheet) so we don't
 * hide the cover during normal video playback. */
html.${HTML_FLAG_CLASS} .web-player-video-cover-img-wrap {
  display: none !important;
}
`

/** Minimal shape of bilibili's global `livePlayer` — only the methods we call. */
interface LivePlayerLike {
  getPlayerInfo?: () => {
    quality?: string
    volume?: { value?: number; disabled?: boolean }
  }
  stopPlayback?: () => unknown
  reload?: () => unknown
}

function getLivePlayer(): LivePlayerLike | null {
  // `unsafeWindow` reaches the page's real window (Tampermonkey sandbox);
  // `resolveLivePlayer` walks up to the TOP frame since activity pages run
  // the room in a `/blanc/<id>` iframe with `livePlayer` on the parent.
  return resolveLivePlayer(unsafeWindow)
}

/**
 * Wait for bilibili's player, resolving `livePlayer` once `stopPlayback`
 * is callable (null on timeout). Closes the cold-start race where our
 * `document-start` engage finishes preflight before bilibili installs the
 * global — waiting up front makes the first disengage `reload()` reliably
 * and avoids a ~1.5s doubled-stream window. A `MutationObserver` on the
 * `<video>` mount plus short setTimeout retries cover the state-lag race
 * where `<video>` exists but `livePlayer` JS state trails by a frame.
 * Caps at ~3s so a room that never mounts a player doesn't block forever.
 */
function waitForLivePlayer(maxWaitMs = 3000): Promise<LivePlayerLike | null> {
  // 100ms × 5 = 500ms grace for the state-lag race before trusting the
  // observer alone for any later remount.
  const STATE_LAG_RETRY_MS = 100
  const MAX_STATE_LAG_RETRIES = 5

  return new Promise(resolve => {
    // Fast path: player already there.
    const ready = getLivePlayer()
    if (ready?.stopPlayback) {
      resolve(ready)
      return
    }

    let observer: MutationObserver | null = null
    let stateLagTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null
    let stateLagRetries = 0
    let settled = false

    const cleanup = (): void => {
      observer?.disconnect()
      observer = null
      if (stateLagTimer !== null) {
        clearTimeout(stateLagTimer)
        stateLagTimer = null
      }
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer)
        timeoutTimer = null
      }
    }

    const finish = (value: LivePlayerLike | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const attempt = (): void => {
      if (settled) return
      if (!getPlayerVideo()) return
      const player = getLivePlayer()
      if (player?.stopPlayback) {
        finish(player)
        return
      }
      // `<video>` in DOM but `livePlayer` state lags — retry rather than
      // wait for a next mutation that might never come in this window.
      if (stateLagTimer !== null) return // already scheduled
      if (stateLagRetries >= MAX_STATE_LAG_RETRIES) return
      stateLagRetries++
      stateLagTimer = setTimeout(() => {
        stateLagTimer = null
        attempt()
      }, STATE_LAG_RETRY_MS)
    }

    observer = new MutationObserver(() => {
      if (!getPlayerVideo()) return
      // Fresh mount → a new state-lag window is acceptable.
      stateLagRetries = 0
      attempt()
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    // Cold-start probe: `<video>` may already be mounted, so run once now.
    attempt()

    timeoutTimer = setTimeout(() => finish(getLivePlayer()), maxWaitMs)
  })
}

/** Checks the members `attachMpegtsPlayer` uses. */
function isMpegts(value: unknown): value is typeof Mpegts {
  return isRecord(value) && typeof value.createPlayer === 'function' && isRecord(value.Events)
}

// Lazy-injected (not @require/externalGlobals) so users who never enable
// audio-only skip the ~120 KB CDN fetch.
function loadMpegts(): Promise<typeof Mpegts> {
  return loadUmdScript(MPEGTS_CDN_URL, 'mpegts', isMpegts)
}

/** Minimal shape of `getRoomPlayInfo` response fields used by audio-only resolution. */
export interface RoomPlayInfoResponse {
  code?: number
  message?: string
  data?: {
    live_status?: number
    playurl_info?: {
      playurl?: {
        stream?: Array<{
          protocol_name?: string
          format?: Array<{
            format_name?: string
            codec?: Array<{
              current_qn?: number
              accept_qn?: number[]
              is_pushing?: boolean
              base_url?: string
              url_info?: Array<{ host?: string; extra?: string }>
            }>
          }>
        }>
      }
    }
  }
}

/** Resolved audio-only FLV stream candidates for a live room. */
export interface AudioStreamInfo {
  /** Candidate HTTPS FLV URLs in priority order (hostname CDN nodes first, IP fallbacks last). */
  urls: string[]
  /** True iff the API was reachable but the room doesn't expose a playable audio-only FLV stream. */
  unavailable?: boolean
}

/** Extract prioritized HTTPS audio-only FLV candidate URLs from a `getRoomPlayInfo` payload. */
export function extractAudioOnlyStreamInfo(data: RoomPlayInfoResponse): AudioStreamInfo {
  // 1 = broadcasting; 0 (off-air) / 2 (carousel) serve no attachable stream.
  if (data.data?.live_status !== 1) {
    return { urls: [], unavailable: true }
  }

  // Prefer FLV — mpegts.js demuxes it directly; HLS would need hls.js.
  const streams = data.data?.playurl_info?.playurl?.stream ?? []
  for (const stream of streams) {
    if (stream.protocol_name !== 'http_stream') continue
    for (const format of stream.format ?? []) {
      if (format.format_name !== 'flv') continue
      for (const codec of format.codec ?? []) {
        // CDN edges strip video tags via ptype=1 even on qn=10000 raw streams; only is_pushing:false marks a dead slot.
        if (!codec?.base_url || !codec.url_info?.length || codec.is_pushing === false) continue

        // Prefer non-IP hosts: `*.bilivideo.com` certs omit raw IPs from SANs, failing browser TLS.
        const hostUrls: string[] = []
        const ipUrls: string[] = []
        for (const info of codec.url_info) {
          if (!info?.host) continue
          const full = `${info.host}${codec.base_url}${info.extra ?? ''}`.replace(/^http:\/\//, 'https://')
          const bucket = isIpHost(info.host) ? ipUrls : hostUrls
          if (!bucket.includes(full)) bucket.push(full)
        }
        const urls = [...hostUrls, ...ipUrls]
        if (urls.length > 0) return { urls }
      }
    }
  }
  return { urls: [], unavailable: true }
}

// Needs matching mobi_app/platform/appkey/build/device params or bilibili rejects with `argument illegal`.
async function fetchAudioOnlyStreamUrl(roomId: number): Promise<AudioStreamInfo> {
  const params = new URLSearchParams({
    appkey: 'iVGUTjsxvpLeuDCf',
    build: '6215200',
    c_locale: 'zh_CN',
    channel: 'bili',
    codec: '0,1',
    device: 'android',
    device_name: 'VTR-AL00',
    dolby: '1',
    format: '0,2',
    free_type: '0',
    http: '1',
    mask: '0',
    mobi_app: 'android',
    network: 'wifi',
    no_playurl: '0',
    only_audio: '1',
    only_video: '0',
    platform: 'android',
    play_type: '0',
    protocol: '0,1',
    // Prefer 720p transcode when available; original-only rooms fall back to qn=10000 with ptype=1.
    qn: '250',
    s_locale: 'zh_CN',
    statistics: '{"appId":1,"platform":3,"version":"6.21.5","abtest":""}',
    ts: String(Math.floor(Date.now() / 1000)),
    room_id: String(roomId),
  })
  const url = `https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo?${params.toString()}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  const data: RoomPlayInfoResponse = await resp.json()

  if (data.code !== 0) throw new Error(`API error code=${data.code} message=${data.message ?? ''}`)
  return extractAudioOnlyStreamInfo(data)
}

// === Playback pipeline ===================================================

let audioEl: HTMLAudioElement | null = null
let mpegtsPlayer: Mpegts.Player | null = null
let streamRefreshTimer: ReturnType<typeof setTimeout> | null = null
let streamRecoveryTimer: ReturnType<typeof setTimeout> | null = null
/** Consecutive reconnect attempts since the last time the stream was actually flowing. */
let streamRecoveryAttempts = 0
let watchdogTimer: ReturnType<typeof setInterval> | null = null
/** Bumped on every (re)engagement; async work from an older gen short-circuits after a bump. */
let engagementGen = 0
/** True between stopPlayback and reload, i.e. ours is the live source. Not implied by `mpegtsPlayer`, which also exists while prerolling or handing off. */
let nativePlayerStopped = false
/** Our stream is warming up silently beside the still-playing native player (before the engage swap). */
let prerolling = false
/** In-flight hand-back to the native player; settles once ours is dropped. */
let handoff: Promise<void> | null = null
let lastAttachError: string | null = null

function clearStreamRefreshTimer(): void {
  if (streamRefreshTimer !== null) {
    clearTimeout(streamRefreshTimer)
    streamRefreshTimer = null
  }
}

function clearStreamRecoveryTimer(): void {
  if (streamRecoveryTimer !== null) {
    clearTimeout(streamRecoveryTimer)
    streamRecoveryTimer = null
  }
}

function clearWatchdog(): void {
  if (watchdogTimer !== null) {
    clearInterval(watchdogTimer)
    watchdogTimer = null
  }
}

/**
 * Re-call `stopPlayback()` whenever something re-engaged the native
 * player (e.g. BLTH's SwitchLiveStreamQuality), else video + audio stream
 * at once. Detected via `blob:` src (MediaSource = streaming) vs the mp4
 * poster left after stopPlayback. 1.5s tick: slow enough not to fight a
 * one-shot auto-quality cycle, fast enough to avoid sustained doubling.
 */
function startWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setInterval(() => {
    if (!audioOnlyActive.value) return
    const v = getPlayerVideo()
    if (!v) return
    // `blob:` src = re-engaged MediaSource. Re-stop.
    if (isNativePlayerStreaming(v)) {
      const player = getLivePlayer()
      try {
        player?.stopPlayback?.()
        // Record it here too: in the cold-start race the engage-time
        // stopPlayback was a no-op (livePlayer null), so this is the call
        // that actually halts the player — without the flag the first
        // disengage would skip reload() and leave a frozen poster.
        nativePlayerStopped = true
      } catch (err) {
        console.warn('[audio-only] watchdog stopPlayback failed:', err)
      }
    }
  }, 1500)
}

/**
 * Snapshot native volume/mute into the `audioOnly*` signals. Must run
 * BEFORE stopPlayback, which nulls `getPlayerInfo()`. Seeds the slider so
 * the level carries over seamlessly.
 */
function captureNativeVolume(): void {
  const info = getLivePlayer()?.getPlayerInfo?.()
  const v = info?.volume?.value
  if (typeof v === 'number' && Number.isFinite(v)) {
    audioOnlyVolume.value = Math.max(0, Math.min(1, v / 100))
  } else {
    // Fall back to the bare `<video>` when getPlayerInfo() isn't wired yet
    // (cold start with persisted audio-only).
    const ve = getPlayerVideo()
    if (ve) {
      if (Number.isFinite(ve.volume)) audioOnlyVolume.value = ve.volume
      // Capture mute here too — the `disabled` read below never fires on
      // this branch, so a muted player would come back unmuted.
      audioOnlyMuted.value = ve.muted
    }
  }
  const muted = info?.volume?.disabled
  if (typeof muted === 'boolean') audioOnlyMuted.value = muted
}

/**
 * Push `audioOnlyVolume`/`audioOnlyMuted` onto the hidden <audio>. Reads
 * both signals BEFORE the null-guard so the live-apply effect subscribes
 * even before a pipeline exists — else a pre-attach slider move wouldn't
 * re-trigger it.
 */
function syncVolumeToAudioEl(): void {
  const volume = audioOnlyVolume.value
  const muted = audioOnlyMuted.value
  if (!audioEl) return
  applyAudioOnlyVolume(audioEl, volume, muted, prerolling)
}

/** Whether B站's own `<video>` is streaming and actually playing (not stalled or paused). */
function isNativePlaying(): boolean {
  const v = getPlayerVideo()
  return !!v && isNativePlayerStreaming(v) && !v.paused && v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
}

/** Resolve once the reloaded native player is playing, or after `SWAP_TIMEOUT_MS`. */
function waitForNativePlayback(): Promise<void> {
  return new Promise(resolve => {
    // `playing` doesn't bubble, but a capture listener still sees it, even on the fresh `<video>` reload() mounts.
    const onPlaying = (): void => {
      if (!isNativePlaying()) return
      document.removeEventListener('playing', onPlaying, true)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      document.removeEventListener('playing', onPlaying, true)
      resolve()
    }, SWAP_TIMEOUT_MS)
    document.addEventListener('playing', onPlaying, true)
  })
}

/**
 * Keep our stream audible until the reloaded native player plays, then drop it and carry its
 * level over (counterpart of `captureNativeVolume`; reload() restores B站's own pre-stop volume).
 * Runs to completion even if re-engaged meanwhile: that engage waits on `handoff` before starting.
 */
async function handOffToNativePlayer(volume: number, muted: boolean): Promise<void> {
  await waitForNativePlayback()
  destroyAudioPipeline()
  handoff = null
  const v = getPlayerVideo()
  if (!v) return
  v.volume = Math.max(0, Math.min(1, volume))
  v.muted = muted
}

function destroyMpegtsPlayer(): void {
  const player = mpegtsPlayer
  if (!player) return
  mpegtsPlayer = null
  try {
    player.pause()
  } catch {}
  try {
    player.unload()
  } catch {}
  try {
    player.detachMediaElement()
  } catch {}
  try {
    player.destroy()
  } catch {}
}

/**
 * Tear down the audio pipeline. Idempotent; per-step errors swallowed so a
 * mid-teardown failure doesn't leak handles into the next enable.
 */
function destroyAudioPipeline(): void {
  clearStreamRefreshTimer()
  clearStreamRecoveryTimer()
  clearWatchdog()
  destroyMpegtsPlayer()
  if (audioEl) {
    audioEl.pause()
    audioEl.removeAttribute('src')
    audioEl.remove()
    audioEl = null
  }
  prerolling = false
}

/**
 * Reconnect after the FLV stream ends or errors, on a bounded backoff.
 * `isLive` disables mpegts.js's own retry (it escalates EARLY_EOF straight to
 * UNRECOVERABLE_EARLY_EOF), so without this a stream restart is terminal.
 */
function scheduleStreamRecovery(roomId: number, gen: number, reason: string): void {
  if (gen !== engagementGen || !audioOnlyActive.value) return
  // Still prerolling: pausing rejects the pending play(), so the engage fails fast and video keeps playing.
  if (prerolling) {
    audioEl?.pause()
    return
  }
  clearStreamRecoveryTimer()

  if (streamRecoveryAttempts >= STREAM_RECOVERY_MAX_ATTEMPTS) {
    appendLog(
      `⚠️ 仅音频流已中断（${reason}），重连 ${STREAM_RECOVERY_MAX_ATTEMPTS} 次均失败，请手动关闭并重新开启仅音频模式`
    )
    return
  }
  const delay = STREAM_RECOVERY_DELAYS_MS[Math.min(streamRecoveryAttempts, STREAM_RECOVERY_DELAYS_MS.length - 1)]
  streamRecoveryAttempts++
  appendLog(
    `⚠️ 仅音频流已中断（${reason}），${Math.round(delay / 1000)} 秒后进行第 ${streamRecoveryAttempts}/${STREAM_RECOVERY_MAX_ATTEMPTS} 次重连…`
  )

  streamRecoveryTimer = setTimeout(() => {
    streamRecoveryTimer = null
    if (gen !== engagementGen || !audioOnlyActive.value) return
    void refreshStream(roomId, gen)
  }, delay)
}

/**
 * Build the hidden `<audio>` + mpegts player for a single stream URL.
 * Resolves true once audio is actually playing, false if startup fails or times out.
 */
async function attachMpegtsPlayer(
  url: string,
  mpegts: typeof Mpegts,
  roomId: number,
  gen: number,
  timeoutMs: number
): Promise<boolean> {
  // A fresh attach supersedes any pending reconnect.
  clearStreamRecoveryTimer()

  if (!audioEl) {
    audioEl = document.createElement('audio')
    audioEl.id = AUDIO_EL_ID
    // `display: none` also drops it from tab order.
    audioEl.style.display = 'none'
    syncVolumeToAudioEl()
    document.body.appendChild(audioEl)
  } else {
    destroyMpegtsPlayer()
  }

  const player = mpegts.createPlayer({
    type: 'flv',
    isLive: true,
    hasVideo: false,
    hasAudio: true,
    url,
  })
  mpegtsPlayer = player
  let settling = true
  let attachFailed = false

  const onStreamEnd = (reason: string): void => {
    if (settling) {
      lastAttachError = reason
      attachFailed = true
      audioEl?.pause()
      return
    }
    scheduleStreamRecovery(roomId, gen, reason)
  }

  // Must be bound before load(): mpegts.js emits ERROR through the bundled
  // `events` polyfill, which throws "Unhandled error." when nothing is
  // listening — so the absence of a listener is itself a failure mode.
  // LOADING_COMPLETE covers the silent case: a clean live EOF ends playback
  // with no error at all.
  player.on(mpegts.Events.ERROR, (type: string, detail: string) => {
    if (player !== mpegtsPlayer) return
    console.warn('[audio-only] mpegts error:', type, detail)
    onStreamEnd(detail || type || '未知错误')
  })
  player.on(mpegts.Events.LOADING_COMPLETE, () => {
    if (player !== mpegtsPlayer) return
    onStreamEnd('直播流已结束')
  })
  // Data is flowing again — clear the backoff so a later drop gets a full ladder.
  player.on(mpegts.Events.MEDIA_INFO, () => {
    if (player !== mpegtsPlayer) return
    streamRecoveryAttempts = 0
  })

  player.attachMediaElement(audioEl)
  player.load()

  syncVolumeToAudioEl()

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  try {
    const playing = attachFailed
      ? false
      : await Promise.race([
          audioEl.play().then(
            () => !attachFailed,
            err => {
              // AbortError = we paused or tore it down mid-attach on purpose.
              if (!(err instanceof DOMException && err.name === 'AbortError')) {
                console.warn('[audio-only] autoplay blocked or play() failed:', err)
              }
              return false
            }
          ),
          new Promise<boolean>(resolve => {
            timeoutTimer = setTimeout(() => {
              if (player === mpegtsPlayer) audioEl?.pause()
              resolve(false)
            }, timeoutMs)
          }),
        ])
    if (!playing && player === mpegtsPlayer) destroyMpegtsPlayer()
    return playing
  } finally {
    settling = false
    clearTimeout(timeoutTimer)
  }
}

/** Try candidate stream URLs in order within `totalTimeoutMs`, falling back to backup CDN edges on failure. */
async function attachFirstPlayableStream(
  urls: readonly string[],
  mpegts: typeof Mpegts,
  roomId: number,
  gen: number,
  totalTimeoutMs = SWAP_TIMEOUT_MS
): Promise<boolean> {
  lastAttachError = null
  const deadline = Date.now() + totalTimeoutMs
  for (let i = 0; i < urls.length; i++) {
    if (gen !== engagementGen) return false
    const remainingBudget = Math.max(0, deadline - Date.now())
    const attemptTimeout = Math.ceil(remainingBudget / (urls.length - i))
    if (attemptTimeout <= 0) return false
    const playing = await attachMpegtsPlayer(urls[i], mpegts, roomId, gen, attemptTimeout)
    if (gen !== engagementGen) return false
    if (playing) return true
  }
  return false
}

function scheduleStreamRefresh(roomId: number, gen: number): void {
  clearStreamRefreshTimer()
  streamRefreshTimer = setTimeout(() => {
    streamRefreshTimer = null
    if (gen !== engagementGen) return
    if (!audioOnlyActive.value) return
    void refreshStream(roomId, gen)
  }, STREAM_REFRESH_MS)
}

async function refreshStream(roomId: number, gen: number): Promise<void> {
  try {
    const [{ urls, unavailable }, mpegts] = await Promise.all([fetchAudioOnlyStreamUrl(roomId), loadMpegts()])
    if (gen !== engagementGen) return
    if (unavailable || urls.length === 0) {
      // Mid-reconnect, a stream that's briefly down is one failed attempt, not the end of the ladder.
      if (streamRecoveryAttempts > 0) scheduleStreamRecovery(roomId, gen, '直播流暂不可用')
      else appendLog('⚠️ 仅音频流刷新失败：直播间未在直播')
      return
    }
    const playing = await attachFirstPlayableStream(urls, mpegts, roomId, gen)
    if (gen !== engagementGen) return
    if (!playing) {
      scheduleStreamRecovery(roomId, gen, lastAttachError ?? '直播流连接失败')
      return
    }
    scheduleStreamRefresh(roomId, gen)
  } catch (err) {
    if (gen !== engagementGen) return
    const msg = err instanceof Error ? err.message : String(err)
    // Mid-reconnect, stay on the backoff ladder (it logs the reason); otherwise
    // retry on the refresh cadence so transient errors don't kill the mode.
    if (streamRecoveryAttempts > 0) {
      scheduleStreamRecovery(roomId, gen, msg)
    } else {
      appendLog(`⚠️ 仅音频流刷新失败：${msg}`)
      scheduleStreamRefresh(roomId, gen)
    }
  }
}

/**
 * Engage audio-only: load mpegts, fetch the FLV URL, preroll our pipeline
 * silently, then stop the native HLS pull once ours plays. Throws so the
 * caller degrades gracefully (native playback was never interrupted).
 *
 * `gen` is bumped and owned by the caller so its `catch` can tell a failure of
 * the current attempt from one of a superseded attempt.
 */
async function engageAudioOnly(gen: number): Promise<void> {
  // Mid-handoff: let the native player take over first, then preroll beside it as usual.
  if (handoff) await handoff
  if (gen !== engagementGen) return

  const roomId = await ensureRoomId()
  if (gen !== engagementGen) return

  const [info, mpegts] = await Promise.all([fetchAudioOnlyStreamUrl(roomId), loadMpegts()])
  if (gen !== engagementGen) return

  if (info.unavailable || info.urls.length === 0) {
    throw new Error('该直播间未提供仅音频流（可能未开播或推流中断）')
  }

  // Wait for the cold-start race (see `waitForLivePlayer`); near-instant
  // in dev, ~hundreds of ms in prod with audio-only persisted on.
  const player = await waitForLivePlayer()
  if (gen !== engagementGen) return

  // After the wait so getPlayerInfo() has data, but before stopPlayback
  // nulls it.
  captureNativeVolume()

  // Fresh engage, not a reconnect — start the backoff ladder from the top.
  streamRecoveryAttempts = 0
  prerolling = true
  const playing = await attachFirstPlayableStream(info.urls, mpegts, roomId, gen)
  if (gen !== engagementGen) {
    // Gen bumped during preroll = disengage ran and tore ours down (the
    // native player never stopped). Do NOT destroyAudioPipeline() here — a
    // subsequent engage may own the current handles.
    return
  }
  if (!playing) throw new Error('仅音频流未能开始播放')

  // Swap in one task: stop the native pull, then unsilence ours.
  if (player?.stopPlayback) {
    try {
      player.stopPlayback()
      nativePlayerStopped = true
    } catch (err) {
      console.warn('[audio-only] stopPlayback failed:', err)
    }
  }
  // Null player (deleted room / extreme cold-start): skip stopPlayback;
  // the watchdog stays the safety net and sets the flag if it stops later.
  prerolling = false
  syncVolumeToAudioEl()

  startWatchdog()
  scheduleStreamRefresh(roomId, gen)
  appendLog(audioOnlyMode.value === 'auto' ? '🎧 页面在后台，已自动切换为仅音频' : '🎧 已开启仅音频模式')
}

/**
 * Disengage: reload() the native player (which restores the prior quality
 * on its own) and hand off once it plays. Safe when nothing is engaged
 * (`hadPipeline` keeps it silent), and must run even when `mpegtsPlayer`
 * is null to cancel a partial engage (see `applyAudioOnlyActive`).
 */
function disengageAudioOnly(): void {
  // Snapshot before teardown to decide whether to log + reload.
  const hadPipeline = mpegtsPlayer !== null || nativePlayerStopped

  // Bump even on the no-op path so a racing engage can't pass an old gen check.
  engagementGen++
  // The in-flight handoff already lands on video, gaplessly.
  if (handoff) return

  // `nativePlayerStopped` (not `mpegtsPlayer`) is authoritative for "must
  // reload": a prerolling pipeline exists while the native player still plays.
  const player = getLivePlayer()
  if (!nativePlayerStopped || !player?.reload) {
    destroyAudioPipeline()
    nativePlayerStopped = false
    if (hadPipeline) appendLog('🎬 已关闭仅音频模式')
    return
  }
  nativePlayerStopped = false
  // Ours stays audible until the native player plays; nothing may fight the reload meanwhile.
  clearWatchdog()
  clearStreamRefreshTimer()
  clearStreamRecoveryTimer()
  try {
    player.reload()
  } catch (err) {
    console.warn('[audio-only] reload failed:', err)
    destroyAudioPipeline()
    appendLog('⚠️ 恢复直播失败，请刷新页面')
    return
  }
  appendLog('🎬 已关闭仅音频模式，正在恢复直播')
  // Snapshot the level now so a later signal can't shift what we carry.
  handoff = handOffToNativePlayer(audioOnlyVolume.value, audioOnlyMuted.value)
}

// Bounce through a macrotask: calling appendLog synchronously from the
// signal effect trips @preact/signals "Cycle detected".
let pendingApplyTimer: ReturnType<typeof setTimeout> | null = null

function clearPendingApply(): void {
  if (pendingApplyTimer !== null) {
    clearTimeout(pendingApplyTimer)
    pendingApplyTimer = null
  }
}

function applyAudioOnlyActive(active: boolean): void {
  ensureStyleEl()
  document.documentElement.classList.toggle(HTML_FLAG_CLASS, active)

  clearPendingApply()
  pendingApplyTimer = setTimeout(async () => {
    pendingApplyTimer = null
    // Re-read so a rapid toggle before this macrotask lands on latest intent.
    const desired = audioOnlyActive.value
    // Null until an engage actually starts, so the catch can distinguish
    // "this engage failed" from "disengage failed" / "never engaged".
    let engageGen: number | null = null
    try {
      if (desired) {
        // Already live; a pipeline mid-handoff or mid-preroll doesn't count and re-engages.
        if (mpegtsPlayer && nativePlayerStopped) return
        // Bumped here, not inside engageAudioOnly, so the catch below can check it.
        engageGen = ++engagementGen
        await engageAudioOnly(engageGen)
      } else {
        // Always disengage, even with no visible pipeline: it bumps
        // `engagementGen` to short-circuit an in-flight engage. The
        // `hadPipeline` guard keeps the initial-off no-op silent.
        disengageAudioOnly()
      }
    } catch (err) {
      // A newer engage/disengage superseded this one and now owns the pipeline
      // and the signals, so the teardown below would kill a live session. The
      // rejection is stale — the current attempt reports its own outcome.
      if (engageGen !== null && engageGen !== engagementGen) {
        console.warn('[audio-only] ignoring stale engage failure:', err)
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[audio-only] apply failed:', err)
      appendLog(`⚠️ 仅音频模式启动失败：${msg}`)
      // Tear down half-built state; reload only if we actually stopped the
      // player (else a pre-stopPlayback failure would interrupt good video).
      destroyAudioPipeline()
      if (nativePlayerStopped) {
        nativePlayerStopped = false
        const player = getLivePlayer()
        if (player?.reload) {
          try {
            player.reload()
          } catch {
            // best-effort recovery
          }
        }
      }
      // Revert to video; the effect re-run strips the hide-video class instead of stranding a blank frame.
      // 仅音频 drops back to 视频; 自动音频 stays armed and retries on the next hide.
      if (audioOnlyMode.value === 'on') audioOnlyMode.value = 'off'
      audioOnlyActive.value = false
    }
  }, 0)
}

function ensureStyleEl(): void {
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = STYLE
  document.head.appendChild(el)
}

function removeStyleEl(): void {
  document.getElementById(STYLE_ID)?.remove()
}

let autoEngageTimer: ReturnType<typeof setTimeout> | null = null

function clearAutoEngageTimer(): void {
  if (autoEngageTimer !== null) {
    clearTimeout(autoEngageTimer)
    autoEngageTimer = null
  }
}

/**
 * Derive `audioOnlyActive` from `audioOnlyMode`: 'auto' engages once the tab has stayed hidden
 * for `AUTO_ENGAGE_DELAY_MS` and drops back the moment it's visible.
 */
function syncAudioOnlyActive(): void {
  clearAutoEngageTimer()
  const mode = audioOnlyMode.value
  if (mode === 'auto' && isTabHidden()) {
    autoEngageTimer = setTimeout(() => {
      autoEngageTimer = null
      // PiP keeps the video on screen even though the tab is hidden.
      if (!document.pictureInPictureElement) audioOnlyActive.value = true
    }, AUTO_ENGAGE_DELAY_MS)
    return
  }
  audioOnlyActive.value = mode === 'on'
}

let effectDisposers: Array<() => void> = []

/**
 * Public entrypoint, wired once from `app-room.tsx`; idempotent. Owns the
 * stylesheet, effects, and pipeline — the mode picker is a separate
 * component (`components/audio-only-mode-select.tsx`).
 */
export function startAudioOnly(): void {
  if (effectDisposers.length > 0) return
  ensureStyleEl()
  document.addEventListener('visibilitychange', syncAudioOnlyActive)
  // Derivation first so the state effect's initial run already sees it.
  effectDisposers = [
    effect(syncAudioOnlyActive),
    effect(() => applyAudioOnlyActive(audioOnlyActive.value)),
    effect(syncVolumeToAudioEl),
  ]
}

export function stopAudioOnly(): void {
  for (const dispose of effectDisposers) dispose()
  effectDisposers = []
  document.removeEventListener('visibilitychange', syncAudioOnlyActive)
  clearAutoEngageTimer()
  clearPendingApply()
  destroyAudioPipeline()
  // Clear so a later `startAudioOnly()` (HMR remount) doesn't owe a reload.
  nativePlayerStopped = false
  document.documentElement.classList.remove(HTML_FLAG_CLASS)
  removeStyleEl()
}
