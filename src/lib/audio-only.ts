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
 * rendered as a sibling of `直播助手` in the bottom-right corner of the
 * page. We previously tried injecting it into bilibili's own player
 * controls (cloning the 小窗模式 tip-wrap), but `stopPlayback()`
 * destroys that whole subtree — and other userscripts in the wild stomp
 * on it too — so the Preact-rendered, outside-the-player approach is
 * simpler and more compatible.
 */

import { effect } from '@preact/signals'
// Type-only import: `Mpegts` is the type of the package's default-
// exported namespace value (createPlayer, isSupported, Events, …)
// — exactly the shape the UMD pins onto `window.mpegts` at runtime,
// so `typeof Mpegts` describes our `getMpegtsFromWindow()` return.
// Nested types like `Mpegts.Player` come from the same declaration.
// The package is installed purely as a devDependency for this import;
// nothing from it is bundled (we lazy-load the UMD from unpkg).
import type Mpegts from 'mpegts.js'

import { unsafeWindow } from '$'
import { ensureRoomId } from './api'
import { MPEGTS_CDN_URL } from './const'
import { loadScript } from './load-script'
import { appendLog } from './log'
import { audioOnlyEnabled } from './store'
import { isIpHost } from './utils'

const HTML_FLAG_CLASS = 'lc-audio-only'
const STYLE_ID = 'lc-audio-only-style'
// Exported so `lib/auto-seek.ts` can target the same hidden audio
// element by id without taking a live reference to it (the element gets
// recreated across stream refresh / disengage cycles; id-lookup stays
// correct across every recreation).
export const AUDIO_EL_ID = 'lc-audio-only-stream'

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

function getLivePlayer(): LivePlayerLike | null {
  // `livePlayer` is bilibili's own global. In Tampermonkey, our code
  // runs in an isolated sandbox; `unsafeWindow` reaches the page's real
  // window where bilibili's player module installs itself.
  const candidate = (unsafeWindow as unknown as { livePlayer?: LivePlayerLike }).livePlayer
  return candidate ?? null
}

/** Selector for bilibili's player `<video>` element. Mounting of this
 *  node is our proxy for "the player bundle has initialised far enough
 *  that `window.livePlayer` should be available". Same selector +
 *  rationale as `lib/auto-quality.ts` — kept in sync intentionally. */
const PLAYER_VIDEO_SELECTOR = '#live-player video'

/**
 * Wait for bilibili's player to be ready, returning the `livePlayer`
 * global once `stopPlayback` is callable (or null on timeout). Closes
 * the cold-start race where the userscript runs at `document-start`
 * (per the `run-at` directive) and `engageAudioOnly()` finishes its
 * async preflight (`ensureRoomId` + `fetchAudioOnlyStreamUrl` +
 * `loadMpegts`) before bilibili's own player bundle has installed the
 * global. The watchdog would catch this case eventually (1.5 s after
 * the player mounts), but waiting up front means:
 *
 *   1. The user's first disengage click works reliably — we actually
 *      called `stopPlayback()` and set `nativePlayerStopped = true`,
 *      so the corresponding `reload()` runs instead of being skipped.
 *   2. No 1.5-second window of doubled streams where bilibili's HLS
 *      pull starts up alongside our audio-only FLV.
 *
 * Dev mode (`bun run dev`) doesn't honour `run-at: document-start` —
 * the script is injected later via vite-plugin-monkey's dev hook, so
 * `livePlayer` is typically already present when our engage runs and
 * the race doesn't reproduce. This wait resolves synchronously on the
 * first check in that case and is load-bearing in prod.
 *
 * Implementation mirrors `lib/auto-quality.ts`: a `MutationObserver`
 * watches `document.documentElement` for the `<video>` mount (the
 * cheap "player is ready" proxy), and a small handful of short
 * setTimeout retries cover the rare "wait-state" race where `<video>`
 * is in the DOM but `livePlayer` JS state lags by a frame or two.
 *
 * Event-driven rather than poll-driven because it matches the project
 * convention and avoids wasted wakeups on idle pages — most mutations
 * on bilibili don't touch `#live-player video` so the observer's
 * `querySelector` filter returns null fast and we no-op.
 *
 * Caps at ~3 s to avoid blocking forever on rooms that never mount a
 * player (deleted room, no permission, etc.) — the caller proceeds
 * without stopping the native player in that case, mpegts attaches its
 * audio pipeline, and the watchdog stays the safety net for any later
 * player engagement.
 */
function waitForLivePlayer(maxWaitMs = 3000): Promise<LivePlayerLike | null> {
  /** Short retry delay for the rare race where `<video>` is in the DOM
   *  but `livePlayer.stopPlayback` hasn't been installed yet. The JS
   *  state usually catches up within a frame or two; 100ms × 5 = 500ms
   *  of grace before we give up on the wait-state race and trust the
   *  observer alone for any later remount. */
  const STATE_LAG_RETRY_MS = 100
  const MAX_STATE_LAG_RETRIES = 5

  return new Promise(resolve => {
    // Fast path: player is already there, no need to install anything.
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
      // The `<video>` mount is what triggers us via the observer; if
      // it's gone the player isn't ready in any sense and there's
      // nothing to do — let the observer keep waiting.
      if (!document.querySelector(PLAYER_VIDEO_SELECTOR)) return
      const player = getLivePlayer()
      if (player?.stopPlayback) {
        finish(player)
        return
      }
      // `<video>` is in the DOM but `livePlayer` JS state lags — same
      // race auto-quality handles. Short retry rather than waiting for
      // the next unrelated mutation, which might never come in this
      // transient window.
      if (stateLagTimer !== null) return // already scheduled
      if (stateLagRetries >= MAX_STATE_LAG_RETRIES) return
      stateLagRetries++
      stateLagTimer = setTimeout(() => {
        stateLagTimer = null
        attempt()
      }, STATE_LAG_RETRY_MS)
    }

    observer = new MutationObserver(() => {
      // Cheap query: most mutations on bilibili pages don't touch
      // `#live-player video`, so this returns null fast and we no-op.
      if (!document.querySelector(PLAYER_VIDEO_SELECTOR)) return
      // Reset retry counter on each fresh mount — a new `<video>`
      // appearing means a new state-lag window is acceptable.
      stateLagRetries = 0
      attempt()
    })
    // `childList + subtree` on documentElement is the cheapest tier
    // that catches added nodes anywhere in the SPA's render tree —
    // same setup auto-quality uses.
    observer.observe(document.documentElement, { childList: true, subtree: true })

    // Cold-start probe: in case `<video>` is already in the DOM by
    // the time we get here (e.g. SPA navigation within the same tab,
    // or our engage racing the player by just a beat), run one
    // attempt immediately rather than waiting for the next unrelated
    // mutation to fire the callback.
    attempt()

    timeoutTimer = setTimeout(() => finish(getLivePlayer()), maxWaitMs)
  })
}

function getMpegtsFromWindow(): typeof Mpegts | null {
  const candidate = (unsafeWindow as unknown as { mpegts?: typeof Mpegts }).mpegts
  return candidate ?? null
}

// === Lazy mpegts.js loader ===============================================
//
// Lazy-injected via `loadScript()` rather than declared as @require /
// `externalGlobals` so users who never enable audio-only never pay the
// ~120 KB CDN fetch. See `lib/load-script.ts` for the shared shape —
// concurrent toggle attempts share a single in-flight fetch.

function loadMpegts(): Promise<typeof Mpegts> {
  return loadScript(MPEGTS_CDN_URL, getMpegtsFromWindow)
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
    // Request a transcoded variant (`qn=250` = 720P) rather than the
    // raw `qn=10000` original passthrough. Bilibili's encoder farm
    // strips the video track only on transcoded outputs — the original
    // passthrough is the streamer's raw RTMP feed served as-is, so
    // `only_audio=1` is silently ignored on it and we'd end up with
    // either a video+audio FLV or, worse, a non-pushed stub URL whose
    // CDN edge returns nothing (the `is_pushing: false` case we saw
    // in the wild — see `accept_qn: [10000]`-only rooms).
    //
    // Asking for `qn=250` makes bilibili pick the audio-only transcode
    // when one exists; rooms that only have the original variant fall
    // through to the `accept_qn`/`is_pushing` checks below and surface
    // a clear "unavailable" rather than streaming silence.
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
      if (!codec?.base_url || !codec.url_info?.length) continue

      // Reject responses where the returned variant is the raw original
      // passthrough (`qn=10000` only, no transcodes available) — even
      // though we asked for `qn=250`, bilibili falls back to whatever
      // the streamer offers, and `accept_qn: [10000]` rooms produce a
      // FLV URL whose edge doesn't actually serve audio-only bytes.
      // `is_pushing: false` is the corroborating signal: the CDN slot
      // exists in the response but no live data is being relayed
      // through it (verified against a known-broken room sample whose
      // `video_codecs` / `audio_codecs` came back as empty `{}`).
      //
      // Surfacing this as "unavailable" rather than silently attaching
      // mpegts to a dead URL means the user gets a clear log line and
      // the native player is left intact (no `stopPlayback()` call
      // happens for the unavailable path).
      const acceptQn = codec.accept_qn ?? []
      const hasTranscode = acceptQn.some(q => q !== 10000)
      if (!hasTranscode || codec.is_pushing === false) {
        return { url: '', unavailable: true }
      }
      // Skip raw-IP hosts and prefer hostname-based CDN entries.
      //
      // For users inside mainland China the app endpoint frequently
      // returns the IP-address variant as the FIRST `url_info` entry
      // (e.g. `https://203.0.113.5/...`). The Android app accepts that
      // because it ships with the bilibili CDN's cert pinned and
      // doesn't enforce hostname matching the same way browsers do.
      // The web page is HTTPS, so the browser refuses the connection
      // because the cert is issued for `*.bilivideo.com` (or similar)
      // and the SAN doesn't include the bare IP — TLS handshake fails
      // and the audio stream never starts. Hostname-based entries from
      // the SAME response work fine because their cert matches.
      //
      // Strategy: prefer the first non-IP host; only fall back to an
      // IP host if no hostname entry exists at all (better to try and
      // fail loudly than to return nothing).
      const urlInfo = codec.url_info.find(u => u.host && !isIpHost(u.host)) ?? codec.url_info[0]
      if (!urlInfo?.host) continue
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
let mpegtsPlayer: Mpegts.Player | null = null
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
        // Critical: mark the native player as stopped here too. The
        // initial `engageAudioOnly()` `stopPlayback()` call is the
        // common path that sets this flag — but in the cold-start race
        // (audio-only persisted ON at `document-start`, our engage
        // runs before bilibili's player bundle has installed
        // `window.livePlayer`) the engage-time call is a silent no-op
        // (`getLivePlayer()` returns null), so `nativePlayerStopped`
        // stays false. The watchdog is what *actually* halts the
        // player a moment later once bilibili finishes loading, and if
        // we don't record that here the very first disengage skips
        // `livePlayer.reload()` — leaving the user staring at a frozen
        // poster until they toggle off→on→off again. Setting the flag
        // here closes that gap for both the cold-start race and the
        // mid-session "BLTH re-engaged the player" case.
        nativePlayerStopped = true
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
async function attachMpegtsPlayer(url: string, mpegts: typeof Mpegts): Promise<void> {
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
    // Two distinct unavailability modes share this branch:
    //   1. Room is not actively broadcasting (`live_status !== 1`).
    //   2. Room only offers the original (`qn=10000`) passthrough
    //      variant, which bilibili's encoder farm never strips video
    //      from — so audio-only isn't truly served and the CDN slot
    //      is a dead URL (`is_pushing: false`).
    // The user-visible message covers both: either the streamer is
    // offline, or their room doesn't expose a transcoded variant
    // (typically because no one's watching at a non-original quality
    // for bilibili's encoder farm to spin up a transcode).
    throw new Error('该直播间未提供仅音频流（未开播或主播未启用转码）')
  }

  // Wait briefly for bilibili's player bundle to install
  // `window.livePlayer` if it hasn't already — see `waitForLivePlayer`
  // for the cold-start race this guards against. In dev mode this is
  // a near-instant single check; in prod with audio-only persisted
  // on, this is where we hold for ~hundreds of ms while bilibili's
  // bundle finishes loading.
  const player = await waitForLivePlayer()
  if (gen !== engagementGen) return

  // Snapshot the volume/mute BEFORE we tear down the native player —
  // `getPlayerInfo()` returns null after `stopPlayback()` so any later
  // read would be useless. Done after the wait so `getPlayerInfo()`
  // actually has data to return.
  captureNativeVolume()

  // Halt the native HLS pull before we start ours so the user isn't
  // streaming both pipes at once. Order matters: stopPlayback first,
  // then attach our pipeline. If we attached first, there'd be a
  // window where both streams are flowing.
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
  // If `player` is still null after the wait (deleted room / no
  // permission / extreme cold-start), we skip stopPlayback entirely —
  // there's no native pipe to halt. The watchdog stays installed as
  // the safety net in case the player mounts later, and it'll set
  // `nativePlayerStopped = true` the moment it stops the player so
  // disengage→reload still works correctly.

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
  appendLog('🎧 已开启仅音频模式')
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
