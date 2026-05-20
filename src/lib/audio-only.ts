/**
 * Audio-only mode for bilibili live: the official web player has no
 * audio-only toggle (only the mobile app does), so we stand one up
 * ourselves.
 *
 * 多房间观察者刚需 —— heavy 用户开 5 个直播间挂着，主看 1 个、其他听声。
 * 5 个原生 1080P 视频播放器把笔记本烤了。仅音频把每个被动房间的带宽从
 * ~1700 kbps 压到 ~180 kbps，CPU 解码也省掉。
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
 *    the user's previously-selected quality preserved.
 *
 * 3. **Audio-only FLV stream** fetched via the Android app endpoint
 *    `xlive/app-room/v2/index/getRoomPlayInfo?only_audio=1`. We verified
 *    empirically that the returned FLV contains only audio tags (FLV
 *    type 8, AAC) and zero video tags — the JSON response still echoes
 *    a `video_codecs` field but the bytes on the wire really are audio
 *    only. The web endpoint ignores `only_audio=1` so we have to use
 *    the app endpoint.
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
 *    unmistakable "somebody re-engaged the player" signal. Known
 *    offender: BLTH's `SwitchLiveStreamQuality` module auto-restores
 *    quality on page load; without watchdog the user would end up
 *    streaming both 1080P video AND audio-only stream simultaneously.
 *
 * 8. **Graceful fallback**: any failure on enable (mpegts CDN down, API
 *    error, autoplay block, etc.) tears down half-built state, reloads
 *    the native player, and surfaces the error via `appendLog` — so the
 *    worst case is "feature didn't take, native player keeps playing"
 *    rather than a silent broken state.
 *
 * 类型说明：mpegts.js 是 CDN 懒加载的，**不引入 devDependency**（避免在
 * 这个 OneDrive 同步的 fork 里多塞一个会被 bun install 竞态破坏的依赖）。
 * 我们本地定义最小的 `MpegtsLike` 接口覆盖实际用到的 API 表面，类型安全
 * 跟上游 `import type Mpegts from 'mpegts.js'` 等价但不依赖 npm install。
 *
 * Cherry-picked from laplace-live/chatterbox commits ecc1b22 + 43688fe +
 * f763d5d + a7f74c4.
 */

import { effect } from '@preact/signals'

import { unsafeWindow } from '$'
import { ensureRoomId } from './api'
import { MPEGTS_CDN_URL } from './const'
import { loadScript } from './load-script'
import { appendLog } from './log'
import { audioOnlyEnabled } from './store'

const HTML_FLAG_CLASS = 'lc-audio-only'
const STYLE_ID = 'lc-audio-only-style'
// Exported so `auto-seek.ts` can resolve the hidden `<audio>` element by id
// when the user has audio-only mode engaged — same element, different
// pipeline than the page's `<video>`.
export const AUDIO_EL_ID = 'lc-audio-only-stream'

// Stream URLs from getRoomPlayInfo are signed with ~1 hour expiry.
// 50 minutes refresh cadence matches the greasyfork 439875 userscript
// which has been battle-tested in the wild.
const STREAM_REFRESH_MS = 50 * 60 * 1000

// === Local types for mpegts.js (avoid devDependency) =====================
//
// 只定义实际用到的方法/事件签名。完整类型在 `mpegts.js` 包里，但我们
// 不引这个包到 devDependencies —— OneDrive 同步 + bun install 在这个仓里
// 有过竞态破坏 node_modules 的历史（见 memory `project_onedrive_bun_install`），
// 任何新增 devDep 都增加未来 release 卡 install 的风险。
//
// 如果未来 mpegts.js API 变了，这个接口会被 build-time TS 检查发现 —— 那
// 时再考虑是把局部类型扩开还是真的引包，看哪个成本低。

interface MpegtsPlayerLike {
  attachMediaElement(el: HTMLMediaElement): void
  load(): void
  pause(): void
  unload(): void
  detachMediaElement(): void
  destroy(): void
}

interface MpegtsLike {
  createPlayer(config: {
    type: 'flv'
    isLive: boolean
    hasVideo: boolean
    hasAudio: boolean
    url: string
  }): MpegtsPlayerLike
}

const STYLE = `
/* Hide the actual video element while audio keeps playing. The static
 * MP4 poster bilibili's player shows after stopPlayback() also lives
 * inside #live-player, so this rule covers the "stopped" state too. */
html.${HTML_FLAG_CLASS} #live-player video {
  visibility: hidden;
}

/* Visual hint that the player frame is intentionally blank rather than
 * broken: a centered "🎧 仅音频模式" label fades in while the flag is
 * set. Anchored to #live-player so it tracks on resize. */
html.${HTML_FLAG_CLASS} #live-player {
  position: relative;
}
html.${HTML_FLAG_CLASS} #live-player::after {
  content: '🎧 弹幕助手 · 仅音频模式';
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
 * overlay sits on a separate layer and would otherwise stay visible —
 * obscuring our "🎧 仅音频模式" hint label. Scope to the audio-only
 * flag so we don't hide the cover during normal video playback. */
html.${HTML_FLAG_CLASS} .web-player-video-cover-img-wrap {
  display: none !important;
}
`

/**
 * Minimal shape of the global `livePlayer` instance bilibili exposes on
 * `window`. Only the methods we actually call.
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
  // `livePlayer` 是 B 站自己的全局。Tampermonkey 沙箱里看不到，必须用
  // `unsafeWindow` 拿到真 page window。
  const candidate = (unsafeWindow as unknown as { livePlayer?: LivePlayerLike }).livePlayer
  return candidate ?? null
}

function getMpegtsFromWindow(): MpegtsLike | null {
  const candidate = (unsafeWindow as unknown as { mpegts?: MpegtsLike }).mpegts
  return candidate ?? null
}

// === Lazy mpegts.js loader ===============================================

function loadMpegts(): Promise<MpegtsLike> {
  return loadScript(MPEGTS_CDN_URL, getMpegtsFromWindow)
}

// === Audio-only stream URL fetch =========================================
//
// Bilibili's Android app endpoint honours `only_audio=1` and returns a
// genuine audio-only FLV (verified: ~300 audio tags, 0 video tags in a
// 138 KB sample). The web `xlive/web-room/v2` endpoint silently returns
// the regular video stream regardless of the flag, so we have to talk
// to the app endpoint with matching mobi_app/platform params or bilibili
// rejects with `argument illegal`.
//
// The `appkey`, `build`, `device`, etc. fields are hard-coded to values
// the greasyfork 439875 userscript has used successfully for years —
// bilibili occasionally tightens signing but has not deprecated this
// client identity at the time of writing.

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

  // `live_status === 1` 是正在直播。其他值：0（未开播）、2（轮播）。
  // 这两个都没有可以挂的音频流，短路。
  if (data.data?.live_status !== 1) {
    return { url: '', unavailable: true }
  }

  // 优先取 FLV —— mpegts.js 直接 demux 这个容器。HLS (m3u8) 需要 hls.js
  // 或手写 fmp4 appender，不值得为已有 FLV 替代的场景再多引一个库。
  const streams = data.data?.playurl_info?.playurl?.stream ?? []
  for (const stream of streams) {
    if (stream.protocol_name !== 'http_stream') continue
    for (const format of stream.format ?? []) {
      if (format.format_name !== 'flv') continue
      const codec = format.codec?.[0]
      const urlInfo = codec?.url_info?.[0]
      if (!codec?.base_url || !urlInfo?.host) continue
      const full = `${urlInfo.host}${codec.base_url}${urlInfo.extra ?? ''}`
      // 安卓 app 端返回的多是 http://，直播页本身是 https，混合内容会被
      // 浏览器掐死。CDN 双向都服务，强升级到 https。
      return { url: full.replace(/^http:\/\//, 'https://') }
    }
  }
  return { url: '', unavailable: true }
}

// === Playback pipeline ===================================================

let audioEl: HTMLAudioElement | null = null
let mpegtsPlayer: MpegtsPlayerLike | null = null
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
 * Why: other userscripts (e.g. BLTH's `SwitchLiveStreamQuality` module
 * auto-restoring quality on page load) call `switchQualityAsync()` after
 * we stop the player, which silently re-engages the HLS pull. Without
 * watchdog the user streams both 1080P video AND our audio-only stream
 * simultaneously — worst-of-both-worlds for bandwidth.
 *
 * `<video>` element's `src` is the detector: bilibili uses `blob:` URLs
 * (MediaSource handle) when actively streaming, plain
 * `https://i0.hdslb.com/...mp4` poster after `stopPlayback()`. A blob
 * src while we're in audio-only mode is "someone re-engaged".
 *
 * 1.5s cadence — slow enough that the BLTH-style one-shot auto-quality
 * module finishes a single cycle before we intervene (no oscillation
 * fight), fast enough that the user doesn't hear sustained doubled audio.
 */
function startWatchdog(): void {
  clearWatchdog()
  watchdogTimer = setInterval(() => {
    if (!audioOnlyEnabled.value) return
    const v = document.querySelector<HTMLVideoElement>('#live-player video')
    if (!v) return
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
 * still being interrogable after `stopPlayback()` — `getPlayerInfo()`
 * returns null then, so any "live" sync would be reading garbage.
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
 * Errors from each step are swallowed individually so a transient
 * failure mid-teardown doesn't leak handles to the next enable.
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
async function attachMpegtsPlayer(url: string, mpegts: MpegtsLike): Promise<void> {
  if (!audioEl) {
    audioEl = document.createElement('audio')
    audioEl.id = AUDIO_EL_ID
    // `display: none` 既挪出 layout 也挪出 tab order，两个都想要 ——
    // 用户从不直接与它交互。
    audioEl.style.display = 'none'
    document.body.appendChild(audioEl)
  } else if (mpegtsPlayer) {
    // Refresh path：同一 audio 元素上已有 player，destroy 后再 attach。
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

  // `play()` 可能因 autoplay 策略被拒。Chrome 通常允许（页面之前已有
  // 媒体交互 —— B 站原生 player 在我们 toggle 之前已经播了）。失败
  // 的用户可见后果就是"无声"，log 一下方便诊断。
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
    // 瞬时 API / CDN 错误不要永久杀死仅音频模式，按同样的 cadence 再试。
    if (gen === engagementGen) scheduleStreamRefresh(roomId, gen)
  }
}

/**
 * Engage true audio-only mode: lazy-load mpegts, fetch the audio FLV
 * URL, stop the native HLS pull, and start the audio pipeline.
 *
 * Throws on any failure so the caller can degrade gracefully (CSS hide
 * stays applied either way, so worst case is "video hidden, native
 * audio keeps playing").
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

  // Volume snapshot 必须在 stopPlayback 之前 —— stopPlayback 之后
  // `getPlayerInfo()` 返回 null，任何 later read 都读不到东西。
  captureNativeVolume()

  // 顺序很关键：stopPlayback 在 attach 我们的 pipeline 之前。反过来
  // 会有一个窗口两个流都在跑。
  const player = getLivePlayer()
  if (player?.stopPlayback) {
    try {
      player.stopPlayback()
      // 这一行必须在下一个 await 之前 —— 让并发的 disengage 知道：
      // 即便 mpegtsPlayer 还没就位，native player 已经停了，需要 reload。
      nativePlayerStopped = true
    } catch (err) {
      console.warn('[audio-only] stopPlayback failed:', err)
    }
  }

  activeRoomId = roomId
  await attachMpegtsPlayer(info.url, mpegts)
  if (gen !== engagementGen) {
    // 有人在 attach 期间 bump 了 gen —— 一定是 disengageAudioOnly()（每次
    // off→on 切换都先 disengage）。Disengage 已经清掉它看得到的 module-
    // level state，并且 iff nativePlayerStopped 已 reload 过 native player。
    // 这里**故意不**再 destroy：如果一个后续的 engage 已经起了自己的
    // pipeline，我们的 destroy 会踩它的 mpegtsPlayer / audioEl。本次
    // attachMpegtsPlayer 设的 state 已经在那次 disengage 里被清掉了，
    // 这里没东西可漏。
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
 * 可在没 engage 时安全调用：`hadPipeline` snapshot 让初始 effect 触发
 * （`audioOnlyEnabled` 默认 false）时保持沉默。即使 `mpegtsPlayer` 为
 * null 也必须可调 —— 见 `applyAudioOnlyMode` 里的 partial-engage 取消
 * 路径。
 */
function disengageAudioOnly(): void {
  const hadPipeline = mpegtsPlayer !== null || nativePlayerStopped

  // 无论 no-op 路径与否都 bump gen。便宜，且能让一个 race 中的 engage
  // 在自己下一个 gen check 时短路。
  engagementGen++
  destroyAudioPipeline()

  if (!hadPipeline) return

  // 只有 stopPlayback 真的落地过才 reload。`mpegtsPlayer` 单独存在不
  // 等于 native player 已停（gen-check-2 和 stopPlayback 之间的窗口
  // 什么都还没碰），`nativePlayerStopped` 才是"我们需要 reload 来恢复
  // 视频"的权威信号。
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
// Signal effect 必须**不**同步调 player API / appendLog —— 那会 (a)
// 触发 @preact/signals "Cycle detected"（appendLog mutate 一个被
// LogPanel 监听的 signal，正好在通知周期中），(b) 跟 B 站自己的 setup
// 工作非显式地交织在一起。我们 bounce 到 macrotask，让所有 signal
// 流量在我们碰 player 之前落定。

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
    // 重读一次，让快速 toggle off→on（或反过来）在这个 macrotask 触发
    // 前的最新 intent 生效。同样的 signal write-from-effect cycle 防护。
    const desired = audioOnlyEnabled.value
    try {
      if (desired) {
        // 已经 engage 在同一个房间就什么都不做 —— 这条路径是页面 reload
        // 时 audio-only 持久化为 on，effect 在已经 running 的 pipeline 上
        // 再次跑。
        if (mpegtsPlayer && activeRoomId !== null) return
        await engageAudioOnly()
      } else {
        // 即使没看到 pipeline 也始终调 disengage —— 一个在飞的
        // `engageAudioOnly()` 可能在 `ensureRoomId`/`fetchAudioOnly
        // StreamUrl`/`loadMpegts` 之类的 await 中部。`disengageAudio
        // Only()` bump `engagementGen` 强迫那个在飞 engage 在下一个 gen
        // check 短路而不是完整跑完，然后留下一个流水线 + 停掉的 native
        // player 跟用户意图相反的状态。Disengage 里的 `hadPipeline`
        // guard 保证 no-op 情形（feature 已经 off 时的初始 effect 触发）
        // 安静 —— 不假 log，不假 `reload()`。
        disengageAudioOnly()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[audio-only] apply failed:', err)
      appendLog(`⚠️ 仅音频模式启动失败：${msg}`)
      // Best-effort 恢复：拆掉一半 build 的东西，iff 真停过 native player
      // 就 reload。`nativePlayerStopped` guard 避免对 stopPlayback 之前
      // 就失败的路径（API 拒、mpegts CDN 挂）做无意义 reload —— 那些
      // 路径根本没碰 native player，reload 反而打断好好的视频。
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
 * Public entrypoint. Wired up一次从 `app.tsx` —— re-call 是 idempotent
 * （`stateEffectDispose` 早 return 保持便宜）。
 *
 * 注意：toggle BUTTON 是另一个 Preact 组件（`audio-only-button.tsx`）；
 * 这个 module 只管 stylesheet、signal effect、playback pipeline。
 */
export function startAudioOnly(): void {
  if (stateEffectDispose) return
  ensureStyleEl()
  // Single effect 驱动整个 feature：每次 signal toggle 重新 apply player
  // state。`signal.value` 在内读，所以 @preact/signals 自动追依赖。
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
  // 清掉 nativePlayerStopped，让后续 startAudioOnly（HMR remount）不会
  // 认为还欠一次 reload。
  nativePlayerStopped = false
  document.documentElement.classList.remove(HTML_FLAG_CLASS)
  removeStyleEl()
}
