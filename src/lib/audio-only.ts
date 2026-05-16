/**
 * Audio-only mode for bilibili live: the official web player has no
 * audio-only toggle (only the mobile app does), so we stand one up
 * ourselves.
 *
 * Strategy — true audio-only via the app-side `only_audio=1` stream:
 *
 * 1. **CSS hide** of `#live-player video` flips synchronously the moment
 *    the user toggles, so the player frame goes blank instantly while we
 *    spin up the audio pipeline in the background.
 *
 * 2. **Native player teardown** via `livePlayer.stopPlayback()`. Bandwidth
 *    measurements during validation showed `pause()` keeps the buffer
 *    fed (~2.4 segment requests / second) but `stopPlayback()` drops
 *    bandwidth to ~0.1 requests / second — i.e. truly halts the live
 *    HLS pull. `reload()` brings it back when the user toggles off, with
 *    the user's previously-selected quality preserved (no quality switch
 *    needed; restoring the native player is enough).
 *
 * 3. **Audio-only FLV stream** fetched via the Android app endpoint
 *    `xlive/app-room/v2/index/getRoomPlayInfo?only_audio=1`. We verified
 *    empirically that the returned FLV contains only audio tags (FLV
 *    type 8, AAC) and zero video tags — the JSON response still echoes
 *    a `video_codecs` field but the bytes on the wire really are audio
 *    only, ~180 kbps vs ~1700 kbps for the original 1080P stream
 *    (~10× bandwidth saving). The web endpoint ignores `only_audio=1`
 *    so we have to use the app endpoint.
 *
 * 4. **Playback via mpegts.js** (a maintained fork of flv.js), which
 *    demuxes the FLV container and feeds AAC frames into a hidden
 *    `<audio>` element's MediaSource buffer. The library is **lazy-
 *    loaded** from the unpkg CDN on first toggle (~120 KB, cached after)
 *    so users who never use audio-only pay zero load cost.
 *
 * 5. **Volume / mute** captured from the native player BEFORE
 *    `stopPlayback()` (which nulls out `getPlayerInfo()` on its way out)
 *    and re-applied to the hidden audio element across stream-refresh
 *    re-attaches, so the user's volume preference survives the handoff.
 *
 * 6. **Stream URL refresh** every ~50 minutes. Bilibili signs CDN URLs
 *    with a ~1 hour expiry; we refresh before that window closes so a
 *    long listening session doesn't get a silent disconnect.
 *
 * 7. **Watchdog** re-calls `stopPlayback()` on a 1.5 s tick whenever the
 *    `<video>` element's src reverts to a `blob:` URL — that's the
 *    unmistakable "somebody re-engaged the player" signal. The known
 *    offender is BLTH's `SwitchLiveStreamQuality` module, which auto-
 *    restores the user's preferred quality on page load; without the
 *    watchdog the user would end up streaming both the native 1080P
 *    video AND our audio-only stream simultaneously.
 *
 * 8. **Graceful fallback**: any failure on enable (mpegts CDN down, API
 *    error, autoplay block, etc.) tears down half-built state, reloads
 *    the native player, and surfaces the error via `appendLog` — so the
 *    worst case is "feature didn't take, native player keeps playing"
 *    rather than a silent broken state.
 *
 * The toggle button itself lives in `components/audio-only-button.tsx`,
 * rendered as a sibling of `弹幕助手` in the bottom-right corner of the
 * page. We previously tried injecting it into bilibili's own player
 * controls (cloning the 小窗模式 tip-wrap), but `stopPlayback()`
 * destroys that whole subtree — and other userscripts in the wild stomp
 * on it too — so the Preact-rendered, outside-the-player approach is
 * simpler and more compatible.
 */

import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { ensureRoomId } from './api'
import { appendLog } from './log'
import { audioOnlyEnabled } from './store'

const HTML_FLAG_CLASS = 'lc-audio-only'
const STYLE_ID = 'lc-audio-only-style'
const AUDIO_EL_ID = 'lc-audio-only-stream'

// Pinned mpegts.js version. Locked rather than `latest` so a breaking
// upstream change doesn't silently land in user browsers on next CDN
// cache miss. Bump deliberately when validating a new version.
const MPEGTS_CDN_URL = 'https://unpkg.com/mpegts.js@1.8.0/dist/mpegts.js'

// Stream URLs from getRoomPlayInfo are signed with ~1 hour expiry. We
// refresh well before that window closes; 50 minutes matches the
// greasyfork 439875 cadence which has been battle-tested in the wild.
const STREAM_REFRESH_MS = 50 * 60 * 1000

const STYLE = `
/* Hide the actual video element while audio keeps playing. The static
 * MP4 poster that bilibili's player shows after stopPlayback() also
 * lives inside #live-player, so this rule covers the "stopped" state
 * too without revealing a frozen frame. */
html.${HTML_FLAG_CLASS} #live-player video {
  visibility: hidden;
}

/* Visual hint that the player frame is intentionally blank rather than
 * broken: a centered "🎧 仅音频模式" label fades in while the flag is
 * set. Anchored to #live-player so it tracks the player size on resize. */
html.${HTML_FLAG_CLASS} #live-player {
  position: relative;
}
html.${HTML_FLAG_CLASS} #live-player::after {
  content: '🎧 LAPLACE Chatterbox - 仅音频模式';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: rgba(255, 255, 255, 0.55);
  font-size: 16px;
  letter-spacing: 0.5px;
  pointer-events: none;
  z-index: 1;
}

html .web-player-video-cover-img-wrap {
  display: none !important;
}
`

/**
 * Minimal shape of the global `livePlayer` instance bilibili exposes on
 * `window`. We only touch the methods we actually call, so this type
 * captures just enough surface area to keep the rest of the file honest
 * without freezing us against bilibili's evolving internal API.
 */
interface LivePlayerLike {
  getPlayerInfo?: () => {
    quality?: string
    volume?: { value?: number; disabled?: boolean }
  }
  stopPlayback?: () => unknown
  reload?: () => unknown
}

/**
 * Subset of the mpegts.js Player surface we drive. The runtime object
 * comes from a CDN-loaded UMD bundle so the rest of mpegts.js stays
 * unbundled from our userscript.
 */
interface MpegtsPlayer {
  attachMediaElement(el: HTMLMediaElement): void
  load(): void
  pause(): void
  unload(): void
  detachMediaElement(): void
  destroy(): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

interface MpegtsRuntime {
  createPlayer(config: {
    type: 'flv' | 'mse' | 'mpegts'
    isLive?: boolean
    hasVideo?: boolean
    hasAudio?: boolean
    url: string
  }): MpegtsPlayer
  Events?: Record<string, string>
}

function getLivePlayer(): LivePlayerLike | null {
  // `livePlayer` is bilibili's own global. In Tampermonkey, our code
  // runs in an isolated sandbox; `unsafeWindow` reaches the page's real
  // window where bilibili's player module installs itself.
  const candidate = (unsafeWindow as unknown as { livePlayer?: LivePlayerLike }).livePlayer
  return candidate ?? null
}

function getMpegtsFromWindow(): MpegtsRuntime | null {
  const candidate = (unsafeWindow as unknown as { mpegts?: MpegtsRuntime }).mpegts
  return candidate ?? null
}

// === Lazy mpegts.js loader ===============================================
//
// We avoid the @require / `externalGlobals` pattern (which Tampermonkey
// fetches eagerly at script start) and inject a <script> tag on first
// toggle. The shared promise means concurrent toggle attempts share the
// single in-flight fetch instead of racing two parallel script loads.

let mpegtsLoadPromise: Promise<MpegtsRuntime> | null = null

function loadMpegts(): Promise<MpegtsRuntime> {
  const existing = getMpegtsFromWindow()
  if (existing) return Promise.resolve(existing)
  if (mpegtsLoadPromise) return mpegtsLoadPromise
  mpegtsLoadPromise = new Promise<MpegtsRuntime>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = MPEGTS_CDN_URL
    // `crossorigin=anonymous` so the browser doesn't gate the global
    // assignment behind a CORS check — unpkg sets `access-control-allow-
    // origin: *` and works fine without credentials.
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      const m = getMpegtsFromWindow()
      if (m) resolve(m)
      else reject(new Error('mpegts.js loaded but window.mpegts not set'))
    }
    script.onerror = () => {
      // Clear the cached promise so a subsequent toggle can retry.
      mpegtsLoadPromise = null
      reject(new Error(`failed to load mpegts.js from ${MPEGTS_CDN_URL}`))
    }
    document.head.appendChild(script)
  })
  return mpegtsLoadPromise
}

// === Audio-only stream URL fetch =========================================
//
// Bilibili's Android app endpoint honours `only_audio=1` and returns a
// genuine audio-only FLV (verified: 308 audio tags, 0 video tags in
// a 138 KB sample). The web `xlive/web-room/v2` endpoint silently
// returns the regular video stream regardless of the flag, so we have
// to talk to the app endpoint with the matching mobi_app/platform
// parameters or bilibili rejects with `argument illegal`.
//
// The `appkey`, `build`, `device`, `device_name`, etc. fields are
// hard-coded to the values the greasyfork 439875 userscript has used
// successfully for years — bilibili occasionally tightens signing but
// has not deprecated this client identity at the time of writing.

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
    qn: '10000',
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

  // `live_status === 1` means actively broadcasting. Other values include
  // 0 (off-air) and 2 (carousel). Neither serves an audio stream we can
  // attach to, so short-circuit so the caller doesn't hand mpegts an
  // empty URL.
  if (data.data?.live_status !== 1) {
    return { url: '', unavailable: true }
  }

  // Prefer the FLV variant of the audio-only stream — mpegts.js demuxes
  // it directly. HLS (m3u8) would require hls.js or a hand-rolled fmp4
  // appender, neither of which is worth adding when FLV is offered
  // alongside on every live room we've tested.
  const streams = data.data?.playurl_info?.playurl?.stream ?? []
  for (const stream of streams) {
    if (stream.protocol_name !== 'http_stream') continue
    for (const format of stream.format ?? []) {
      if (format.format_name !== 'flv') continue
      const codec = format.codec?.[0]
      const urlInfo = codec?.url_info?.[0]
      if (!codec?.base_url || !urlInfo?.host) continue
      const full = `${urlInfo.host}${codec.base_url}${urlInfo.extra ?? ''}`
      // Many app-endpoint responses come back as `http://` — the live
      // page itself is HTTPS, so mixed-content blocking kills the
      // request unless we upgrade. The CDN serves both schemes.
      return { url: full.replace(/^http:\/\//, 'https://') }
    }
  }
  return { url: '', unavailable: true }
}

// === Playback pipeline ===================================================

let audioEl: HTMLAudioElement | null = null
let mpegtsPlayer: MpegtsPlayer | null = null
/** Room id we currently have a stream open against. Captured at enable
 *  time so the refresh timer keeps targeting the same room even if the
 *  user navigates away mid-toggle. */
let activeRoomId: number | null = null
let streamRefreshTimer: ReturnType<typeof setTimeout> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null
/** Generation token incremented on every (re)engagement of audio-only.
 *  Async work that started on generation N short-circuits when it
 *  finishes after a generation bump — i.e. the user toggled off, or
 *  toggled off-and-on-again, while a fetch / mpegts load was in flight. */
let engagementGen = 0
/** True iff we've called `livePlayer.stopPlayback()` and haven't yet
 *  reloaded. Tracked separately from `mpegtsPlayer` because there's an
 *  in-flight window (after stopPlayback, before attachMpegtsPlayer
 *  resolves) where the native player is stopped but no audio pipeline
 *  exists yet — disengage still needs to reload in that case. */
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
 * Periodically re-call `stopPlayback()` whenever something brought the
 * native player back to life.
 *
 * Why this exists: other userscripts in the wild (e.g. BLTH's
 * `SwitchLiveStreamQuality` module, which auto-restores the user's
 * preferred quality on page load) call `switchQualityAsync()` after we
 * stop the player, which silently re-engages the HLS pull. Without a
 * watchdog the user would end up streaming both the native 1080P video
 * AND our audio-only stream simultaneously — worst-of-both-worlds for
 * bandwidth.
 *
 * We detect the re-engagement by looking at the `<video>` element's
 * `src`: bilibili uses a `blob:` URL (a MediaSource handle) when it's
 * actively streaming, and a plain `https://i0.hdslb.com/...mp4` poster
 * after `stopPlayback()`. A blob src while we're in audio-only mode is
 * the unmistakable "someone re-engaged the player" signal.
 *
 * The watchdog runs every 1.5 s — slow enough that the BLTH-style
 * one-shot auto-quality module finishes a single cycle before we
 * intervene (so we don't fight it on its very first call and create an
 * oscillation), fast enough that the user doesn't hear a sustained
 * burst of doubled audio.
 */
function startWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setInterval(() => {
    if (!audioOnlyEnabled.value) return
    const v = document.querySelector<HTMLVideoElement>('#live-player video')
    if (!v) return
    // `blob:` src means the player has an active MediaSource attached
    // i.e. somebody re-engaged it after we stopped. Re-stop.
    if (v.src.startsWith('blob:')) {
      const player = getLivePlayer()
      try {
        player?.stopPlayback?.()
      } catch (err) {
        console.warn('[audio-only] watchdog stopPlayback failed:', err)
      }
    }
  }, 1500)
}

/** Volume captured at engage time, then re-applied to the hidden audio
 *  element on every (re)attach. Persists across stream URL refreshes. */
let preservedVolume = 1
let preservedMuted = false

/**
 * Snapshot the native player's current volume / mute state. Called
 * BEFORE we hand off to mpegts so we don't depend on the native player
 * still being interrogable after `stopPlayback()` — at that point
 * `getPlayerInfo()` returns null because the player module tore down
 * its state machine, so any "live" volume sync would be reading
 * garbage anyway.
 */
function captureNativeVolume(): void {
  const info = getLivePlayer()?.getPlayerInfo?.()
  const v = info?.volume?.value
  if (typeof v === 'number' && Number.isFinite(v)) {
    preservedVolume = Math.max(0, Math.min(1, v / 100))
  } else {
    // Fall back to reading the bare `<video>` element. Useful when the
    // player module is loaded but `getPlayerInfo()` hasn't been wired
    // up yet (cold start with persisted audio-only).
    const ve = document.querySelector<HTMLVideoElement>('#live-player video')
    if (ve && Number.isFinite(ve.volume)) preservedVolume = ve.volume
  }
  const muted = info?.volume?.disabled
  if (typeof muted === 'boolean') preservedMuted = muted
}

/** Apply the captured volume / mute to the audio element. */
function syncVolumeToAudioEl(): void {
  if (!audioEl) return
  if (Math.abs(audioEl.volume - preservedVolume) > 0.005) audioEl.volume = preservedVolume
  if (audioEl.muted !== preservedMuted) audioEl.muted = preservedMuted
}

/**
 * Tear down whatever audio pipeline is currently running. Idempotent so
 * the disable path doesn't have to know whether enable ever finished.
 * Errors from each step are swallowed individually so a transient failure
 * mid-teardown doesn't leak handles to the next enable.
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
 * Build the hidden `<audio>` element + mpegts player for a fresh stream
 * URL. Used by both first-time enable and the URL-refresh path. The
 * caller is responsible for short-circuiting if the engagement
 * generation has moved on by the time this awaits.
 */
async function attachMpegtsPlayer(url: string, mpegts: MpegtsRuntime): Promise<void> {
  // Re-use the existing `<audio>` if we still have one (refresh path);
  // otherwise mount a fresh hidden element.
  if (!audioEl) {
    audioEl = document.createElement('audio')
    audioEl.id = AUDIO_EL_ID
    // `display: none` removes the element from layout AND tab order, both
    // of which we want — the user never interacts with it directly.
    audioEl.style.display = 'none'
    document.body.appendChild(audioEl)
  } else if (mpegtsPlayer) {
    // Existing player on the same element — destroy it before
    // re-attaching to a new stream URL. (Refresh path.)
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

  // `play()` can reject under autoplay policy — Chrome usually allows
  // it for pages where the user has already interacted with media
  // (which is the case here: bilibili's native player is playing
  // before our toggle). We catch and log because the user-visible
  // failure (silence) is the same either way, and a logged warning
  // lets us diagnose if it happens.
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
    // Try again on the same cadence — transient API or CDN errors
    // shouldn't kill audio-only mode permanently.
    if (gen === engagementGen) scheduleStreamRefresh(roomId, gen)
  }
}

/**
 * Engage true audio-only mode: lazy-load mpegts, fetch the audio FLV
 * URL, stop the native HLS pull, and start the audio pipeline.
 *
 * Throws on any failure so the caller can degrade gracefully (the CSS
 * hide stays applied either way, so the user-visible outcome on failure
 * is just "video hidden, native audio keeps playing").
 */
async function engageAudioOnly(): Promise<void> {
  const gen = ++engagementGen
  const roomId = await ensureRoomId()
  if (gen !== engagementGen) return

  const [info, mpegts] = await Promise.all([fetchAudioOnlyStreamUrl(roomId), loadMpegts()])
  if (gen !== engagementGen) return

  if (info.unavailable || !info.url) {
    throw new Error('该直播间未提供仅音频流（可能未开播）')
  }

  // Snapshot the volume/mute BEFORE we tear down the native player —
  // `getPlayerInfo()` returns null after `stopPlayback()` so any later
  // read would be useless.
  captureNativeVolume()

  // Halt the native HLS pull before we start ours so the user isn't
  // streaming both pipes at once. Order matters: stopPlayback first,
  // then attach our pipeline. If we attached first, there'd be a
  // window where both streams are flowing.
  const player = getLivePlayer()
  if (player?.stopPlayback) {
    try {
      player.stopPlayback()
      // Set this BEFORE the next await so a concurrent disengage sees
      // it and knows it needs to reload the native player even though
      // mpegtsPlayer hasn't been set yet.
      nativePlayerStopped = true
    } catch (err) {
      console.warn('[audio-only] stopPlayback failed:', err)
    }
  }

  activeRoomId = roomId
  await attachMpegtsPlayer(info.url, mpegts)
  if (gen !== engagementGen) {
    // Someone bumped the gen during our attach — that's always
    // `disengageAudioOnly()` (engages only run via signal flips, and
    // each on→on flip requires an off in between which calls disengage).
    // Disengage already destroyed any module-level state it observed
    // and reloaded the native player iff `nativePlayerStopped` was set.
    // We deliberately do NOT call `destroyAudioPipeline()` here: if a
    // subsequent engage has already started its own pipeline, our
    // destroy would clobber its `mpegtsPlayer` / `audioEl` references.
    // The state we set up (audioEl + mpegtsPlayer in attachMpegtsPlayer)
    // was already nulled out by disengage before that subsequent engage
    // ran, so there's nothing of ours left to leak.
    return
  }

  startWatchdog()
  scheduleStreamRefresh(roomId, gen)
  appendLog('🎧 已开启仅音频模式（only_audio=1 真·音频流）')
}

/**
 * Disengage audio-only: stop our audio pipeline and bring the native
 * player back online. `reload()` re-fetches the master playlist and
 * restores the user's previously-selected quality without us tracking
 * anything — the player already remembers what was set.
 *
 * Safe to call when nothing is engaged: the `hadPipeline` snapshot
 * keeps it silent on the initial signal-effect run that fires when
 * `audioOnlyEnabled` is already false on page load. And critical to
 * call even when `mpegtsPlayer` is null — see `applyAudioOnlyMode`
 * for the partial-engage cancellation case that this guards against.
 */
function disengageAudioOnly(): void {
  // Snapshot BEFORE we tear anything down so we can decide whether to
  // emit a user-visible log + reload.
  const hadPipeline = mpegtsPlayer !== null || nativePlayerStopped

  // Always bump the generation, even on the no-op path. Cheap, and it
  // means a future engage that races against this disengage can't
  // accidentally pass an earlier gen check.
  engagementGen++
  destroyAudioPipeline()

  if (!hadPipeline) return

  // Reload only when stopPlayback actually landed — `mpegtsPlayer`
  // alone doesn't imply the native player is stopped (the in-flight
  // window between gen-check-2 and stopPlayback exists where nothing
  // is touched yet), and `nativePlayerStopped` is the authoritative
  // signal for "we need to reload to restore video".
  if (nativePlayerStopped) {
    nativePlayerStopped = false
    const player = getLivePlayer()
    if (player?.reload) {
      try {
        player.reload()
        appendLog('🎬 已关闭仅音频模式，正在恢复直播')
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

// === Pending-apply orchestration =========================================
//
// The signal effect must NOT call player APIs / appendLog synchronously
// — that would (a) trip @preact/signals "Cycle detected" because
// appendLog mutates the LogPanel-watched signal that's mid-notification,
// and (b) interleave with bilibili's own setup work in non-obvious ways.
// We bounce through a macrotask so all signal traffic has settled by the
// time we touch the player.

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
    // Re-read so a rapid toggle off→on (or vice versa) before this
    // macrotask fires lands on the latest intent. Same rationale as
    // signal write-from-effect cycle protection.
    const desired = audioOnlyEnabled.value
    try {
      if (desired) {
        // If we're already engaged on the right room, do nothing — this
        // path is hit when the page reloads with audio-only persisted on
        // and the effect re-runs against an already-running pipeline.
        if (mpegtsPlayer && activeRoomId !== null) return
        await engageAudioOnly()
      } else {
        // Always disengage — even when no pipeline is visible yet, an
        // in-flight `engageAudioOnly()` may be partway through its async
        // setup (awaiting `ensureRoomId`, `fetchAudioOnlyStreamUrl`,
        // `loadMpegts`, etc.). `disengageAudioOnly()` bumps
        // `engagementGen`, which forces the in-flight engage to short-
        // circuit on its next gen check rather than completing and
        // leaking a streaming pipeline + stopped native player against
        // the user's intent. The `hadPipeline` guard inside disengage
        // keeps the no-op case (initial effect run when the feature is
        // already off) silent — no spurious log, no `reload()` call.
        disengageAudioOnly()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[audio-only] apply failed:', err)
      appendLog(`⚠️ 仅音频模式启动失败：${msg}`)
      // Best-effort recovery: tear down anything half-built and reload
      // the native player iff we actually stopped it. The
      // `nativePlayerStopped` guard avoids a spurious `reload()` for
      // failures that happened before stopPlayback (e.g. API rejection
      // or mpegts CDN load failure) — those paths never touched the
      // native player, so reloading would just interrupt good video.
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

/**
 * Public entrypoint. Wired up exactly once from `app.tsx` — re-calling
 * is idempotent (the early-return on `stateEffectDispose` keeps it cheap).
 *
 * Note: the toggle BUTTON is a separate Preact component
 * (`components/audio-only-button.tsx`); this module only owns the
 * stylesheet, the signal effect, and the playback pipeline.
 */
export function startAudioOnly(): void {
  if (stateEffectDispose) return
  ensureStyleEl()
  // Single effect drives the entire feature: every toggle of the signal
  // re-applies the player state. `signal.value` is read inside, so
  // @preact/signals tracks the dependency automatically.
  stateEffectDispose = effect(() => {
    applyAudioOnlyMode(audioOnlyEnabled.value)
  })
}

export function stopAudioOnly(): void {
  if (stateEffectDispose) {
    stateEffectDispose()
    stateEffectDispose = null
  }
  clearPendingApply()
  destroyAudioPipeline()
  // Clear so a subsequent `startAudioOnly()` (e.g. HMR remount during
  // development) doesn't think we owe a `reload()` for a stop we no
  // longer remember the context of.
  nativePlayerStopped = false
  document.documentElement.classList.remove(HTML_FLAG_CLASS)
  removeStyleEl()
}
