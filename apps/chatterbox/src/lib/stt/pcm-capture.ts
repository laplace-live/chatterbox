/**
 * Shared mic → PCM16 capture for every STT engine but Soniox, whose SDK records on its own.
 * Also the page-audio path (`WEB_AUDIO_DEVICE_ID`): captures the live player
 * element and hot-reconnects when that element re-sources underneath us.
 * AudioContext defaults to 16 kHz so the browser resamples; AudioWorklet blob-loaded
 * (userscript has no separate asset for `addModule()`). Targeted Bilibili pages
 * enforce no `script-src` CSP that would block the blob module.
 */

import { appendLog } from '../log'
import { getCaptureMediaCandidates } from '../player-dom'
import { floatTo16 } from './audio'

/** Default capture sample rate in Hz. */
export const PCM_SAMPLE_RATE = 16000

/** Sentinel device id: capture the page's live-player audio instead of a microphone. */
export const WEB_AUDIO_DEVICE_ID = '__web_audio__'

/** `captureStream` / `mozCaptureStream` exist at runtime but aren't declared in lib.dom. */
type CaptureCapableMediaElement = HTMLMediaElement & {
  captureStream?: () => MediaStream
  mozCaptureStream?: () => MediaStream
}

const DEFAULT_FRAME_SAMPLES = 4096

// Page-audio reconnect ladder: the captured element re-sources on quality
// switches, audio-only engage/disengage and the 50-minute FLV refresh, which
// ends our track. Poll for a fresh source instead of going silently silent.
const WEB_AUDIO_RECONNECT_INTERVAL_MS = 500
// Wall clock, not tick count: background tabs clamp timers to >=1s, which would
// stretch a poll-counted budget (same note as openai-compat-engine's poll loop).
const WEB_AUDIO_RECONNECT_BUDGET_MS = 10_000

// Startup can race the player's first buffering: retry briefly before failing the
// session so "刚进直播间还没缓冲好" doesn't surface as a hard error.
const WEB_AUDIO_STARTUP_RETRIES = 3
const WEB_AUDIO_STARTUP_RETRY_INTERVAL_MS = 500

// `ended` is not enough: a paused, muted or re-sourced element may never end its
// track. Poll the bound element cheaply so those cases still reconnect.
const WEB_AUDIO_WATCHDOG_INTERVAL_MS = 1500

// AudioWorklet source (runs in AudioWorkletGlobalScope, not the DOM): batch mono
// input into a fixed Float32 buffer, post each full frame (transferred, zero-copy).
const PCM_TAP_PROCESSOR = `
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this._size = options.processorOptions.frameSize
    this._buf = new Float32Array(this._size)
    this._n = 0
  }
  process(inputs) {
    const channel = inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i]
      if (this._n === this._size) {
        const frame = this._buf.slice(0)
        this.port.postMessage(frame, [frame.buffer])
        this._n = 0
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTapProcessor)
`

export interface PcmCapture {
  /** Stop capture and release the audio source + audio graph. Idempotent. */
  stop: () => void
}

/** A page-audio stream plus the element it was captured from (watchdog identity). */
interface CapturedPageAudio {
  stream: MediaStream
  el: CaptureCapableMediaElement
}

/**
 * Acquire the page's live-player audio: the audio-only `<audio>` first, the
 * native `<video>` second. Candidates that are muted, paused or fail to capture
 * are skipped — only when every candidate fails is the last reason thrown, so a
 * prerolling `<audio>` (volume 0) still falls back to a playing `<video>`.
 * Video tracks are dropped at once; audio tracks are returned un-cloned so our
 * `stop()` really ends the capture registration on the element.
 */
function acquireWebAudioStream(): CapturedPageAudio {
  const candidates = getCaptureMediaCandidates() as CaptureCapableMediaElement[]
  if (candidates.length === 0) throw new Error('未找到直播间播放器，请确认直播已加载')

  let lastError: Error | null = null
  for (const el of candidates) {
    if (!el.captureStream && !el.mozCaptureStream) {
      lastError = new Error('当前浏览器不支持捕获网页音频（captureStream）')
      continue
    }
    // Older Chromium captures silence from muted elements (crbug 40717757); the
    // render-muted-audio fix only landed in 2025 behind a flag, so stay conservative.
    if (el.muted || el.volume === 0) {
      lastError = new Error('直播音源当前已静音，请先取消静音后重试；不想听声音时可用浏览器标签页静音')
      continue
    }
    // Skipped during handoff windows (audio-only preroll / teardown): the other
    // candidate is the one actually playing right now.
    if (el.paused || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      lastError = new Error('未检测到网页直播音轨，请确认直播正在播放且未暂停')
      continue
    }

    let captured: MediaStream | undefined
    try {
      captured = el.captureStream?.() ?? el.mozCaptureStream?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // e.g. SecurityError on a cross-origin poster; try the other candidate.
      lastError = new Error(`捕获网页音频失败：${msg}`)
      continue
    }
    if (!captured) {
      lastError = new Error('未检测到网页直播音轨，请确认直播正在播放且未暂停')
      continue
    }

    // Video rides along on `<video>` captures; it is pure overhead here.
    for (const track of captured.getVideoTracks()) track.stop()
    const audioTracks = captured.getAudioTracks()
    const liveTracks = audioTracks.filter(track => track.readyState !== 'ended')
    for (const track of audioTracks) {
      if (track.readyState === 'ended') track.stop()
    }
    if (liveTracks.length === 0) {
      for (const track of captured.getTracks()) track.stop()
      lastError = new Error('未检测到网页直播音轨，请确认直播正在播放且未暂停')
      continue
    }
    return { stream: new MediaStream(liveTracks), el }
  }

  throw lastError ?? new Error('未检测到网页直播音轨，请确认直播正在播放且未暂停')
}

/**
 * Startup wrapper: up to 3 attempts, 500 ms apart (1.5 s), then throw the last
 * error so the engine fails the session with a visible message — no silent
 * empty-graph ladder at startup.
 */
async function acquireWebAudioStreamWithRetry(): Promise<CapturedPageAudio> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < WEB_AUDIO_STARTUP_RETRIES; attempt++) {
    try {
      return acquireWebAudioStream()
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
    await new Promise(resolve => setTimeout(resolve, WEB_AUDIO_STARTUP_RETRY_INTERVAL_MS))
  }
  throw lastError ?? new Error('未检测到网页直播音轨，请确认直播正在播放且未暂停')
}

export interface PcmCaptureOptions {
  /** Microphone device id; '' = system default, {@link WEB_AUDIO_DEVICE_ID} = page player audio. */
  deviceId: string
  /** Samples per `onFrame` block; defaults to 4096 (256 ms). */
  frameSamples?: number
  /** Capture sample rate in Hz; defaults to 16000. */
  sampleRate?: number
  /** Called with each Int16 PCM block (little-endian, mono). */
  onFrame: (frame: Int16Array<ArrayBuffer>) => void
}

export async function startPcmCapture(opts: PcmCaptureOptions): Promise<PcmCapture> {
  const webAudio = opts.deviceId === WEB_AUDIO_DEVICE_ID
  let currentStream: MediaStream
  let initialEl: CaptureCapableMediaElement | null = null
  if (webAudio) {
    const acquired = await acquireWebAudioStreamWithRetry()
    currentStream = acquired.stream
    initialEl = acquired.el
  } else {
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        // DSP off explicitly: raw transcribes best, and pinning a device otherwise
        // re-enables the browser's echo-cancellation / NS / AGC defaults.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    }
    currentStream = await navigator.mediaDevices.getUserMedia(constraints)
  }

  const stopStream = (stream: MediaStream): void => {
    for (const track of stream.getTracks()) track.stop()
  }

  let context: AudioContext
  try {
    context = new AudioContext({ sampleRate: opts.sampleRate ?? PCM_SAMPLE_RATE })
  } catch (err) {
    // Never leak an acquired mic / page capture if the context can't be built.
    stopStream(currentStream)
    throw err
  }

  try {
    const moduleUrl = URL.createObjectURL(new Blob([PCM_TAP_PROCESSOR], { type: 'application/javascript' }))
    try {
      await context.audioWorklet.addModule(moduleUrl)
    } finally {
      URL.revokeObjectURL(moduleUrl)
    }
    const node = new AudioWorkletNode(context, 'pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { frameSize: opts.frameSamples ?? DEFAULT_FRAME_SAMPLES },
    })
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      opts.onFrame(floatTo16(event.data))
    }
    // Muted sink: node needs a path to destination to keep getting pulled; zero
    // gain stops the mic playing back.
    const zeroGain = context.createGain()
    zeroGain.gain.value = 0
    node.connect(zeroGain)
    zeroGain.connect(context.destination)

    let stopped = false
    /** Fast reconnect spent its budget for this interruption; the watchdog retries slowly. */
    let interrupted = false
    /** Last acquire / bind failure, surfaced when the fast ladder gives up. */
    let lastFailureReason = ''
    let currentSource: MediaStreamAudioSourceNode | null = null
    let currentEl: CaptureCapableMediaElement | null = null
    let currentSrc = ''
    let currentTrack: MediaStreamTrack | null = null
    let reconnectTimer: ReturnType<typeof setInterval> | null = null
    let watchdogTimer: ReturnType<typeof setInterval> | null = null
    /** A preferred candidate acquire proved unusable; it must not veto a healthy bind. */
    let suppressedPreferred: CaptureCapableMediaElement | null = null
    let suppressedPreferredSrc = ''
    /**
     * Superseded captures, released only at `stop()`. Verified on Chromium/Edge 156:
     * `stop()` on an older capture's track silences the element's NEWEST capture
     * (which stays `live` and never fires `ended`), so a mid-session stop here would
     * mute the rebind. A new `captureStream()` on the same element already starves
     * older streams by itself — retiring them is only about avoiding that stop.
     */
    const retiredStreams: MediaStream[] = []

    const clearReconnect = (): void => {
      if (reconnectTimer !== null) {
        clearInterval(reconnectTimer)
        reconnectTimer = null
      }
    }

    const clearWatchdog = (): void => {
      if (watchdogTimer !== null) {
        clearInterval(watchdogTimer)
        watchdogTimer = null
      }
    }

    /** Both the fast ladder and the watchdog funnel a successful rebind through here. */
    const markRecovered = (): void => {
      if (!interrupted) return
      interrupted = false
      lastFailureReason = ''
      appendLog('🎤 网页直播音源已自动恢复')
    }

    /**
     * A candidate acquire already skipped (capture threw / no live track) must not
     * keep forcing rebinds of the element we are happily bound to. The suppression
     * lapses once that element is gone or re-sources, so it gets re-evaluated.
     */
    const isSuppressedPreferred = (el: CaptureCapableMediaElement): boolean => {
      if (suppressedPreferred === null) return false
      const src = suppressedPreferred.currentSrc || suppressedPreferred.src
      if (!suppressedPreferred.isConnected || src !== suppressedPreferredSrc) {
        suppressedPreferred = null
        return false
      }
      return suppressedPreferred === el
    }

    /** First candidate that is actually audible right now, in priority order. */
    const preferredActiveCandidate = (): CaptureCapableMediaElement | null => {
      for (const el of getCaptureMediaCandidates() as CaptureCapableMediaElement[]) {
        if (!el.captureStream && !el.mozCaptureStream) continue
        if (!el.isConnected || el.paused || el.muted || el.volume === 0) continue
        if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue
        return el
      }
      return null
    }

    /**
     * Bind a stream to the worklet, make-before-break: the new source is live
     * before the old one is released, so the worklet keeps posting (silent)
     * frames while we recover — Deepgram drops sockets after 10 s without audio.
     * Returns false when the track is already dead (the acquire → bind window
     * spans `addModule`), leaving the caller to retry instead of binding a corpse.
     */
    const bindStream = (stream: MediaStream, el: CaptureCapableMediaElement | null): boolean => {
      const track = stream.getAudioTracks()[0]
      if (!track) return false
      if (webAudio) {
        // Element re-sourcing ends the track; re-acquire instead of going silent.
        track.addEventListener('ended', restartWebAudio, { once: true })
        if (track.readyState === 'ended') return false
      }
      const nextSource = context.createMediaStreamSource(stream)
      nextSource.connect(node)
      const previousStream = currentStream
      const previousSource = currentSource
      currentSource = nextSource
      currentStream = stream
      currentEl = el
      if (suppressedPreferred === el) suppressedPreferred = null
      currentSrc = el ? el.currentSrc || el.src : ''
      currentTrack = track
      previousSource?.disconnect()
      // Never stop the old capture mid-session (see `retiredStreams`): stopping it
      // immediately after the new capture went live mutes the new one on Chromium.
      // Its `ended` listener is dropped too — a retired track must not trigger rebinds.
      if (previousStream !== stream) {
        previousStream.getAudioTracks()[0]?.removeEventListener('ended', restartWebAudio)
        retiredStreams.push(previousStream)
      }
      return true
    }

    /**
     * One rebind attempt: acquire a fresh page source and swap it in. Records the
     * failure reason so a spent ladder can report something actionable.
     */
    const tryRebind = (): boolean => {
      const previousEl = currentEl
      let next: CapturedPageAudio
      try {
        next = acquireWebAudioStream()
      } catch (err) {
        lastFailureReason = err instanceof Error ? err.message : String(err)
        return false
      }
      if (stopped) {
        stopStream(next.stream)
        return false
      }
      let bound = false
      try {
        bound = bindStream(next.stream, next.el)
      } catch (err) {
        lastFailureReason = err instanceof Error ? err.message : String(err)
      } finally {
        if (!bound) stopStream(next.stream)
      }
      if (bound && next.el === previousEl) {
        // A rebind pushed by `preferred !== currentEl` landed back on the same
        // element: acquire could not use that preferred candidate. Blacklist it
        // so the watchdog stops re-triggering on the same unusable preference.
        const preferred = preferredActiveCandidate()
        if (preferred !== null && preferred !== next.el) {
          suppressedPreferred = preferred
          suppressedPreferredSrc = preferred.currentSrc || preferred.src
        }
      }
      return bound
    }

    const restartWebAudio = (): void => {
      if (stopped) return
      clearReconnect()
      // Real-time deadline: a hidden tab clamps timers to >=1s, which would
      // stretch a tick-counted budget far past 10s.
      const deadline = Date.now() + WEB_AUDIO_RECONNECT_BUDGET_MS
      reconnectTimer = setInterval(() => {
        if (stopped) {
          clearReconnect()
          return
        }
        if (Date.now() >= deadline) {
          clearReconnect()
          // Don't lock out: the watchdog keeps retrying at its own pace.
          if (!interrupted) {
            interrupted = true
            appendLog(`⚠️ 网页直播音源已中断：${lastFailureReason || '未知原因'}（恢复后将自动重连）`)
          }
          return
        }
        if (tryRebind()) {
          clearReconnect()
          markRecovered()
        }
      }, WEB_AUDIO_RECONNECT_INTERVAL_MS)
    }

    /**
     * `ended` alone misses paused / muted / re-sourced elements; poll the bound
     * element instead. No-op while a reconnect poll is already running.
     */
    const startWatchdog = (): void => {
      if (watchdogTimer !== null) return
      watchdogTimer = setInterval(() => {
        if (stopped) return
        // A suspended context stops pulling the worklet; same symptom as a dead source.
        if (context.state === 'suspended') void context.resume().catch(() => {})
        if (reconnectTimer !== null) return
        if (interrupted) {
          // Low-frequency self-heal once the fast ladder is spent.
          if (tryRebind()) markRecovered()
          return
        }
        const el = currentEl
        const track = currentTrack
        if (!el || !track) return
        const preferred = preferredActiveCandidate()
        const preferredViable = preferred !== null && !isSuppressedPreferred(preferred)
        const broken =
          track.readyState === 'ended' ||
          !el.isConnected ||
          el.paused ||
          el.muted ||
          el.volume === 0 ||
          el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
          (el.currentSrc || el.src) !== currentSrc ||
          (preferredViable && preferred !== el)
        if (broken) restartWebAudio()
      }, WEB_AUDIO_WATCHDOG_INTERVAL_MS)
    }

    if (webAudio) {
      let bound = false
      try {
        bound = bindStream(currentStream, initialEl)
      } catch (err) {
        lastFailureReason = err instanceof Error ? err.message : String(err)
      }
      if (!bound) {
        // Keep the session alive: retry through the ladder instead of tearing down.
        stopStream(currentStream)
        restartWebAudio()
      }
      startWatchdog()
    } else {
      bindStream(currentStream, null)
    }

    // Context created several awaits after the click gesture can start suspended
    // under the autoplay policy; resume so the node pulls audio.
    void context.resume().catch(() => {})

    return {
      stop: () => {
        if (stopped) return
        stopped = true
        clearReconnect()
        clearWatchdog()
        node.port.onmessage = null
        currentSource?.disconnect()
        currentSource = null
        stopStream(currentStream)
        for (const stream of retiredStreams) stopStream(stream)
        retiredStreams.length = 0
        node.disconnect()
        zeroGain.disconnect()
        void context.close().catch(() => {})
      },
    }
  } catch (err) {
    // Worklet load / node construction failed (e.g. enforcing host CSP blocks the
    // blob module): release the audio source + context so they don't leak, then rethrow.
    stopStream(currentStream)
    void context.close().catch(() => {})
    throw err
  }
}
