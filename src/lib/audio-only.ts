/**
 * Audio-only mode for bilibili live: the web player has no audio-only
 * toggle (only the mobile app does), so we build one. Non-obvious bits:
 * - Only the Android app `getRoomPlayInfo?only_audio=1` endpoint yields a
 *   true audio-only FLV; the web endpoint ignores the flag.
 * - `stopPlayback()` truly halts the HLS pull (~0.1 req/s); `pause()`
 *   keeps the buffer fed (~2.4 req/s). `reload()` restores it, quality
 *   preserved.
 * - Watchdog re-stops on `blob:` src revert: BLTH's SwitchLiveStreamQuality
 *   re-engages the player, else you'd stream video + audio at once.
 * - Volume/mute captured BEFORE stopPlayback (which nulls getPlayerInfo).
 */

import { effect } from '@preact/signals'
// devDependency, type-only: `typeof Mpegts` mirrors the UMD pinned on
// `window.mpegts`. Nothing is bundled — we lazy-load the UMD from unpkg.
import type Mpegts from 'mpegts.js'

import { unsafeWindow } from '$'
import { ensureRoomId } from './api'
import { MPEGTS_CDN_URL } from './const'
import { loadUmdScript } from './load-script'
import { appendLog } from './log'
import { getPlayerVideo, isNativePlayerStreaming, PLAYER_CONTAINER_SELECTOR, resolveLivePlayer } from './player-dom'
import { audioOnlyEnabled, audioOnlyMuted, audioOnlyVolume } from './store'
import { isIpHost } from './utils'

const HTML_FLAG_CLASS = 'lc-audio-only'
const STYLE_ID = 'lc-audio-only-style'
// Exported for id-lookup from `lib/auto-seek.ts`: the element is recreated
// across refresh/disengage cycles, so a live reference would go stale.
export const AUDIO_EL_ID = 'lc-audio-only-stream'

// Stream URLs are signed with ~1h expiry; refresh well before that closes.
const STREAM_REFRESH_MS = 50 * 60 * 1000

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

function getMpegtsFromWindow(): typeof Mpegts | null {
  const candidate = (unsafeWindow as unknown as { mpegts?: typeof Mpegts }).mpegts
  return candidate ?? null
}

// Lazy-injected (not @require/externalGlobals) so users who never enable
// audio-only skip the ~120 KB CDN fetch.
function loadMpegts(): Promise<typeof Mpegts> {
  return loadUmdScript(MPEGTS_CDN_URL, getMpegtsFromWindow)
}

// Only the Android app endpoint honours `only_audio=1` (verified audio-only
// FLV); the web endpoint ignores it. Needs matching mobi_app/platform params
// or bilibili rejects with `argument illegal`. appkey/build/device etc. are
// hard-coded to a long-working client identity.

interface AudioStreamInfo {
  url: string
  /** True iff the API was reachable but the room doesn't expose
   *  an audio-only stream (encrypted room, pre-broadcast, etc.). */
  unavailable?: boolean
}

async function fetchAudioOnlyStreamUrl(roomId: number): Promise<AudioStreamInfo> {
  const params = new URLSearchParams({
    appkey: 'iVGUTjsxvpLeuDCf',
    build: '6215200',
    c_locale: 'zh_CN',
    channel: 'bili',
    codec: '0',
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
    // qn=250 (720P transcode), not the raw qn=10000 passthrough: video is
    // stripped only on transcodes, so `only_audio=1` is ignored on the raw
    // feed. Original-only rooms fall through to the checks below.
    qn: '250',
    s_locale: 'zh_CN',
    statistics: '{"appId":1,"platform":3,"version":"6.21.5","abtest":""}',
    ts: String(Math.floor(Date.now() / 1000)),
    room_id: String(roomId),
  })
  const url = `https://api.live.bilibili.com/xlive/app-room/v2/index/getRoomPlayInfo?${params.toString()}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`)
  const data: {
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
  } = await resp.json()

  if (data.code !== 0) throw new Error(`API error code=${data.code} message=${data.message ?? ''}`)

  // 1 = broadcasting; 0 (off-air) / 2 (carousel) serve no attachable stream.
  if (data.data?.live_status !== 1) {
    return { url: '', unavailable: true }
  }

  // Prefer FLV — mpegts.js demuxes it directly; HLS would need hls.js.
  const streams = data.data?.playurl_info?.playurl?.stream ?? []
  for (const stream of streams) {
    if (stream.protocol_name !== 'http_stream') continue
    for (const format of stream.format ?? []) {
      if (format.format_name !== 'flv') continue
      const codec = format.codec?.[0]
      if (!codec?.base_url || !codec.url_info?.length) continue

      // Raw passthrough (accept_qn=[10000] only) yields a FLV URL whose edge
      // serves no audio-only bytes; is_pushing:false corroborates a dead slot.
      // Treat as unavailable so we don't attach mpegts to a dead URL.
      const acceptQn = codec.accept_qn ?? []
      const hasTranscode = acceptQn.some(q => q !== 10000)
      if (!hasTranscode || codec.is_pushing === false) {
        return { url: '', unavailable: true }
      }
      // Prefer non-IP hosts: the app endpoint often returns an IP variant
      // first, but its cert (`*.bilivideo.com`) has no IP in the SAN so the
      // browser's TLS handshake fails. Fall back to IP only if no hostname.
      const urlInfo = codec.url_info.find(u => u.host && !isIpHost(u.host)) ?? codec.url_info[0]
      if (!urlInfo?.host) continue
      const full = `${urlInfo.host}${codec.base_url}${urlInfo.extra ?? ''}`
      // Upgrade to https: responses are often http, blocked as mixed content.
      return { url: full.replace(/^http:\/\//, 'https://') }
    }
  }
  return { url: '', unavailable: true }
}

// === Playback pipeline ===================================================

let audioEl: HTMLAudioElement | null = null
let mpegtsPlayer: Mpegts.Player | null = null
/** Room id the open stream targets; captured at enable so refresh stays put if the user navigates away. */
let activeRoomId: number | null = null
let streamRefreshTimer: ReturnType<typeof setTimeout> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
/** Bumped on every (re)engagement; async work from an older gen short-circuits after a bump. */
let engagementGen = 0
/** True between stopPlayback and reload. Separate from `mpegtsPlayer`: there's a window where the native player is stopped but no pipeline exists yet, and disengage must still reload. */
let nativePlayerStopped = false

function clearStreamRefreshTimer(): void {
  if (streamRefreshTimer !== null) {
    clearTimeout(streamRefreshTimer)
    streamRefreshTimer = null
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
    if (!audioOnlyEnabled.value) return
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
  if (Math.abs(audioEl.volume - volume) > 0.005) audioEl.volume = volume
  if (audioEl.muted !== muted) audioEl.muted = muted
}

/**
 * Carry audio-only volume/mute back onto the native player after
 * disengage (counterpart of `captureNativeVolume`); reload() otherwise
 * restores bilibili's own pre-stop volume. Applied only once the reloaded
 * player is streaming again (`blob:` src) so we land after its init-time
 * volume write and win. Bounded ~5s; aborts via `gen` if the user
 * re-engages mid-reload.
 */
async function restoreVolumeToNativePlayer(volume: number, muted: boolean, gen: number): Promise<void> {
  const target = Math.max(0, Math.min(1, volume))
  const POLL_MS = 200
  const MAX_POLLS = 25 // ~5s ceiling

  const apply = (): boolean => {
    const v = getPlayerVideo()
    if (!v) return false
    v.volume = target
    v.muted = muted
    return true
  }

  for (let i = 0; i < MAX_POLLS; i++) {
    if (gen !== engagementGen) return // re-engaged — leave it alone
    const v = getPlayerVideo()
    // `blob:` src = reloaded player streaming; apply after its init volume.
    if (v && isNativePlayerStreaming(v)) {
      apply()
      return
    }
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS))
  }

  // Fallback: no `blob:` src within the window — apply anyway, an early
  // write beats no write.
  if (gen === engagementGen) apply()
}

/**
 * Tear down the audio pipeline. Idempotent; per-step errors swallowed so a
 * mid-teardown failure doesn't leak handles into the next enable.
 */
function destroyAudioPipeline(): void {
  clearStreamRefreshTimer()
  clearWatchdog()
  if (mpegtsPlayer) {
    try {
      mpegtsPlayer.pause()
    } catch {
      // best-effort cleanup
    }
    try {
      mpegtsPlayer.unload()
    } catch {
      // best-effort cleanup
    }
    try {
      mpegtsPlayer.detachMediaElement()
    } catch {
      // best-effort cleanup
    }
    try {
      mpegtsPlayer.destroy()
    } catch {
      // best-effort cleanup
    }
    mpegtsPlayer = null
  }
  if (audioEl) {
    audioEl.pause()
    audioEl.removeAttribute('src')
    audioEl.remove()
    audioEl = null
  }
  activeRoomId = null
}

/**
 * Build the hidden `<audio>` + mpegts player for a fresh stream URL (enable
 * and refresh paths). Caller must short-circuit on generation change.
 */
async function attachMpegtsPlayer(url: string, mpegts: typeof Mpegts): Promise<void> {
  if (!audioEl) {
    audioEl = document.createElement('audio')
    audioEl.id = AUDIO_EL_ID
    // `display: none` also drops it from tab order.
    audioEl.style.display = 'none'
    document.body.appendChild(audioEl)
  } else if (mpegtsPlayer) {
    // Refresh path: destroy the existing player before re-attaching.
    try {
      mpegtsPlayer.destroy()
    } catch {
      // best-effort cleanup
    }
    mpegtsPlayer = null
  }

  mpegtsPlayer = mpegts.createPlayer({
    type: 'flv',
    isLive: true,
    hasVideo: false,
    hasAudio: true,
    url,
  })
  mpegtsPlayer.attachMediaElement(audioEl)
  mpegtsPlayer.load()

  syncVolumeToAudioEl()

  // `play()` can reject under autoplay policy (usually allowed here since
  // the native player was already playing); log for diagnosis.
  try {
    await audioEl.play()
  } catch (err) {
    console.warn('[audio-only] autoplay blocked or play() failed:', err)
  }
}

function scheduleStreamRefresh(roomId: number, gen: number): void {
  clearStreamRefreshTimer()
  streamRefreshTimer = setTimeout(() => {
    streamRefreshTimer = null
    if (gen !== engagementGen) return
    if (!audioOnlyEnabled.value) return
    void refreshStream(roomId, gen)
  }, STREAM_REFRESH_MS)
}

async function refreshStream(roomId: number, gen: number): Promise<void> {
  try {
    const [{ url, unavailable }, mpegts] = await Promise.all([fetchAudioOnlyStreamUrl(roomId), loadMpegts()])
    if (gen !== engagementGen) return
    if (unavailable || !url) {
      appendLog('⚠️ 仅音频流刷新失败：直播间未在直播')
      return
    }
    await attachMpegtsPlayer(url, mpegts)
    if (gen !== engagementGen) return
    scheduleStreamRefresh(roomId, gen)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`⚠️ 仅音频流刷新失败：${msg}`)
    // Retry on the same cadence so transient errors don't kill the mode.
    if (gen === engagementGen) scheduleStreamRefresh(roomId, gen)
  }
}

/**
 * Engage audio-only: load mpegts, fetch the FLV URL, stop the native HLS
 * pull, start the pipeline. Throws so the caller degrades gracefully (CSS
 * hide stays, native audio keeps playing).
 */
async function engageAudioOnly(): Promise<void> {
  const gen = ++engagementGen
  const roomId = await ensureRoomId()
  if (gen !== engagementGen) return

  const [info, mpegts] = await Promise.all([fetchAudioOnlyStreamUrl(roomId), loadMpegts()])
  if (gen !== engagementGen) return

  if (info.unavailable || !info.url) {
    // Off-air, or original-only room with no audio-only transcode.
    throw new Error('该直播间未提供仅音频流（未开播、刚开播、或观众太少平台未启用转码）')
  }

  // Wait for the cold-start race (see `waitForLivePlayer`); near-instant
  // in dev, ~hundreds of ms in prod with audio-only persisted on.
  const player = await waitForLivePlayer()
  if (gen !== engagementGen) return

  // After the wait so getPlayerInfo() has data, but before stopPlayback
  // nulls it.
  captureNativeVolume()

  // Halt the native pull before attaching ours — order matters, else both
  // streams flow at once.
  if (player?.stopPlayback) {
    try {
      player.stopPlayback()
      // Before the await so a concurrent disengage knows to reload even
      // though mpegtsPlayer isn't set yet.
      nativePlayerStopped = true
    } catch (err) {
      console.warn('[audio-only] stopPlayback failed:', err)
    }
  }
  // Null player (deleted room / extreme cold-start): skip stopPlayback;
  // the watchdog stays the safety net and sets the flag if it stops later.

  activeRoomId = roomId
  await attachMpegtsPlayer(info.url, mpegts)
  if (gen !== engagementGen) {
    // Gen bumped during attach = disengage ran; it already tore down and
    // reloaded. Do NOT destroyAudioPipeline() here — a subsequent engage
    // may own the current handles, and disengage already nulled ours.
    return
  }

  startWatchdog()
  scheduleStreamRefresh(roomId, gen)
  appendLog('🎧 已开启仅音频模式')
}

/**
 * Disengage: stop our pipeline and reload() the native player (which
 * restores the prior quality on its own). Safe when nothing is engaged
 * (`hadPipeline` keeps it silent), and must run even when `mpegtsPlayer`
 * is null to cancel a partial engage (see `applyAudioOnlyMode`).
 */
function disengageAudioOnly(): void {
  // Snapshot before teardown to decide whether to log + reload.
  const hadPipeline = mpegtsPlayer !== null || nativePlayerStopped

  // Bump even on the no-op path so a racing engage can't pass an old gen check.
  engagementGen++
  destroyAudioPipeline()

  if (!hadPipeline) return

  // `nativePlayerStopped` (not `mpegtsPlayer`) is authoritative for
  // "native player is stopped, must reload" — there's a window where the
  // pipeline exists but stopPlayback hasn't run.
  if (nativePlayerStopped) {
    nativePlayerStopped = false
    // Snapshot level + gen before the async reload so a later signal can't
    // shift what we carry, and the restore aborts on re-engage.
    const carryVolume = audioOnlyVolume.value
    const carryMuted = audioOnlyMuted.value
    const gen = engagementGen
    const player = getLivePlayer()
    if (player?.reload) {
      try {
        player.reload()
        appendLog('🎬 已关闭仅音频模式，正在恢复直播')
        // Fire-and-forget: carries the level onto the resumed video.
        void restoreVolumeToNativePlayer(carryVolume, carryMuted, gen)
        return
      } catch (err) {
        console.warn('[audio-only] reload failed:', err)
        appendLog('⚠️ 恢复直播失败，请刷新页面')
        return
      }
    }
  }
  appendLog('🎬 已关闭仅音频模式')
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

function applyAudioOnlyMode(enabled: boolean): void {
  ensureStyleEl()
  document.documentElement.classList.toggle(HTML_FLAG_CLASS, enabled)

  clearPendingApply()
  pendingApplyTimer = setTimeout(async () => {
    pendingApplyTimer = null
    // Re-read so a rapid toggle before this macrotask lands on latest intent.
    const desired = audioOnlyEnabled.value
    try {
      if (desired) {
        // Already engaged on the right room (page reloaded with it persisted on).
        if (mpegtsPlayer && activeRoomId !== null) return
        await engageAudioOnly()
      } else {
        // Always disengage, even with no visible pipeline: it bumps
        // `engagementGen` to short-circuit an in-flight engage. The
        // `hadPipeline` guard keeps the initial-off no-op silent.
        disengageAudioOnly()
      }
    } catch (err) {
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

let stateEffectDispose: (() => void) | null = null
let volumeEffectDispose: (() => void) | null = null

/**
 * Public entrypoint, wired once from `app.tsx`; idempotent. Owns the
 * stylesheet, effects, and pipeline — the toggle button is a separate
 * component (`components/audio-only-button.tsx`).
 */
export function startAudioOnly(): void {
  if (stateEffectDispose) return
  ensureStyleEl()
  // First effect re-applies player state on toggle; second mirrors
  // volume/mute onto the <audio>. `signal.value` reads auto-track deps.
  stateEffectDispose = effect(() => {
    applyAudioOnlyMode(audioOnlyEnabled.value)
  })
  volumeEffectDispose = effect(() => {
    syncVolumeToAudioEl()
  })
}

export function stopAudioOnly(): void {
  if (stateEffectDispose) {
    stateEffectDispose()
    stateEffectDispose = null
  }
  if (volumeEffectDispose) {
    volumeEffectDispose()
    volumeEffectDispose = null
  }
  clearPendingApply()
  destroyAudioPipeline()
  // Clear so a later `startAudioOnly()` (HMR remount) doesn't owe a reload.
  nativePlayerStopped = false
  document.documentElement.classList.remove(HTML_FLAG_CLASS)
  removeStyleEl()
}
