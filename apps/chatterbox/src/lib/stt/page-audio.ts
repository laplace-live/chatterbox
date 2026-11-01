/** Event-driven live-player audio capture (`#lc-audio-only-stream` / `#live-player video`) for STT. */

import { AUDIO_PREROLLING_ATTR, getAudioOnlyElement, getPlayerVideo, isNativePlayerStreaming } from '../player-dom'

const HAVE_CURRENT_DATA = 2
const DEFAULT_STARTUP_TIMEOUT_MS = 2000
const PREROLL_STARTUP_TIMEOUT_MS = 10_000
const DEFAULT_INTERRUPTION_WARN_MS = 5000

const ERR_UNSUPPORTED = '当前浏览器不支持捕获网页音频（需 Chromium 内核浏览器）'
const ERR_MUTED = '直播音源当前已静音，请先取消静音后重试；不想听声音时可用浏览器标签页静音'
const ERR_NOT_READY = '直播音源尚未就绪或已暂停，请确认直播正在播放后重试'
const ERR_NO_PLAYER = '未找到正在播放的直播音源，请确认直播正在播放'

const DOCUMENT_MEDIA_EVENTS = ['playing', 'loadeddata', 'canplay', 'volumechange', 'emptied', 'pause'] as const
const ELEMENT_MEDIA_EVENTS = ['playing', 'volumechange', 'emptied', 'pause', 'ended'] as const

// Standard `captureStream` only: Firefox's `mozCaptureStream()` detaches speaker output, muting the stream.
type CapturableMediaElement = HTMLMediaElement & {
  captureStream?: () => MediaStream
}

// Chromium silences a newer `el.captureStream()` if an older stream's track stops afterwards; stop prior tracks first.
const activeCaptures = new WeakMap<HTMLMediaElement, MediaStream>()
let cancelPendingAcquire: (() => void) | null = null

interface CapturedElementAudio {
  el: HTMLMediaElement
  src: string
  stream: MediaStream
  track: MediaStreamTrack
}

/** Initial live-player capture handle acquired before constructing the Web Audio worklet graph. */
export interface AcquiredPageAudio extends CapturedElementAudio {
  /** Whether this handle still owns the element's active capture stream. */
  isOwned: () => boolean
  /** Release the captured stream if still owned by this handle. */
  release: () => void
}

/** Options for {@link acquirePageAudio}. */
export interface AcquirePageAudioOptions {
  signal?: AbortSignal
  startupTimeoutMs?: number
}

/** Options for {@link bindPageAudio}. */
export interface BindPageAudioOptions {
  context: AudioContext
  destination: AudioNode
  initial: AcquiredPageAudio
  onLog?: (message: string) => void
  interruptionWarnMs?: number
}

/** Active event-driven binder keeping the live-player audio source connected to the worklet graph. */
export interface PageAudioBinding {
  /** Disconnect audio nodes, remove listeners, and release the active media capture. */
  stop: () => void
}

function supportsCapture(el: HTMLMediaElement): el is HTMLMediaElement & { captureStream: () => MediaStream } {
  return typeof (el as CapturableMediaElement).captureStream === 'function'
}

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

function releaseElementCapture(el: HTMLMediaElement, stream: MediaStream): void {
  if (activeCaptures.get(el) !== stream) return
  activeCaptures.delete(el)
  stopStreamTracks(stream)
}

function captureElement(el: HTMLMediaElement): CapturedElementAudio | null {
  if (!supportsCapture(el)) return null
  const src = el.src
  const prev = activeCaptures.get(el)
  if (prev) {
    activeCaptures.delete(el)
    stopStreamTracks(prev)
  }
  let stream: MediaStream
  try {
    stream = el.captureStream()
  } catch {
    return null
  }
  for (const videoTrack of stream.getVideoTracks()) videoTrack.stop()
  const track = stream.getAudioTracks().find(t => t.readyState === 'live') ?? null
  if (!track) {
    stopStreamTracks(stream)
    return null
  }
  activeCaptures.set(el, stream)
  return { el, src, stream, track }
}

function isAudible(el: HTMLMediaElement): boolean {
  return !el.muted && el.volume > 0
}

function isPrerolling(el: HTMLMediaElement): boolean {
  return el.hasAttribute?.(AUDIO_PREROLLING_ATTR) === true
}

function isPlayable(el: HTMLMediaElement): boolean {
  return !el.paused && !el.ended && el.readyState >= HAVE_CURRENT_DATA
}

function getCandidates(): HTMLMediaElement[] {
  const out: HTMLMediaElement[] = []
  const audio = getAudioOnlyElement()
  if (audio && audio.isConnected !== false) out.push(audio)
  const video = getPlayerVideo()
  if (video && video.isConnected !== false && isNativePlayerStreaming(video)) out.push(video)
  return out
}

function checkUnsupportedBrowser(candidates: readonly HTMLMediaElement[]): Error | null {
  const probe = candidates[0] ?? getPlayerVideo() ?? getAudioOnlyElement()
  if (probe && !supportsCapture(probe)) return new Error(ERR_UNSUPPORTED)
  return null
}

function tryCaptureCandidates(candidates: readonly HTMLMediaElement[]): AcquiredPageAudio | null {
  for (const candidate of candidates) {
    if (!isPlayable(candidate) || !isAudible(candidate)) continue
    const captured = captureElement(candidate)
    if (captured) {
      return {
        ...captured,
        isOwned: () => activeCaptures.get(captured.el) === captured.stream,
        release: () => releaseElementCapture(captured.el, captured.stream),
      }
    }
  }
  return null
}

/** Normalize an `AbortSignal`'s reason into an `Error` (`DOMException('Aborted', 'AbortError')` fallback). */
export function toAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('Aborted', 'AbortError')
}

type ProbeOutcome =
  | { kind: 'acquired'; value: AcquiredPageAudio }
  | { kind: 'fatal'; error: Error }
  | { kind: 'pending'; error: Error }

function probePageAudio(): ProbeOutcome {
  const candidates = getCandidates()
  const unsupported = checkUnsupportedBrowser(candidates)
  if (unsupported) return { kind: 'fatal', error: unsupported }
  const acquired = tryCaptureCandidates(candidates)
  if (acquired) return { kind: 'acquired', value: acquired }
  if (candidates.length > 0 && candidates.every(el => !isAudible(el) && !isPrerolling(el))) {
    return { kind: 'fatal', error: new Error(ERR_MUTED) }
  }
  return { kind: 'pending', error: new Error(candidates.length > 0 ? ERR_NOT_READY : ERR_NO_PLAYER) }
}

/** Acquire an audible, live audio track from the active Bilibili player, waiting briefly on cold start. */
export function acquirePageAudio(opts: AcquirePageAudioOptions = {}): Promise<AcquiredPageAudio> {
  const { signal, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS } = opts
  const allowPrerollExtension = opts.startupTimeoutMs === undefined && PREROLL_STARTUP_TIMEOUT_MS > startupTimeoutMs
  if (signal?.aborted) return Promise.reject(toAbortError(signal))
  cancelPendingAcquire?.()

  const initial = probePageAudio()
  if (initial.kind === 'acquired') return Promise.resolve(initial.value)
  if (initial.kind === 'fatal' || startupTimeoutMs <= 0) return Promise.reject(initial.error)

  return new Promise<AcquiredPageAudio>((resolve, reject) => {
    let settled = false
    let extendedForPreroll = false
    let observer: MutationObserver | null = null
    let timer: ReturnType<typeof setTimeout>

    const onSupersede = (): void => {
      fail(new DOMException('Aborted', 'AbortError'))
    }

    const cleanup = (): void => {
      if (cancelPendingAcquire === onSupersede) cancelPendingAcquire = null
      clearTimeout(timer)
      observer?.disconnect()
      observer = null
      signal?.removeEventListener('abort', onAbort)
      for (const evt of DOCUMENT_MEDIA_EVENTS) {
        document.removeEventListener(evt, check, true)
      }
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const check = (): void => {
      if (settled) return
      const outcome = probePageAudio()
      if (outcome.kind === 'acquired') {
        settled = true
        cleanup()
        resolve(outcome.value)
      } else if (outcome.kind === 'fatal') {
        fail(outcome.error)
      }
    }

    const onAbort = (): void => {
      if (signal) fail(toAbortError(signal))
    }

    const onTimeout = (): void => {
      const outcome = probePageAudio()
      if (outcome.kind === 'acquired') {
        settled = true
        cleanup()
        resolve(outcome.value)
        return
      }
      if (
        outcome.kind === 'pending' &&
        allowPrerollExtension &&
        !extendedForPreroll &&
        getCandidates().some(isPrerolling)
      ) {
        extendedForPreroll = true
        timer = setTimeout(onTimeout, PREROLL_STARTUP_TIMEOUT_MS - startupTimeoutMs)
        return
      }
      fail(outcome.error)
    }

    timer = setTimeout(onTimeout, startupTimeoutMs)

    cancelPendingAcquire = onSupersede
    signal?.addEventListener('abort', onAbort, { once: true })
    for (const evt of DOCUMENT_MEDIA_EVENTS) {
      document.addEventListener(evt, check, true)
    }
    if (typeof MutationObserver === 'function' && document.body) {
      observer = new MutationObserver(check)
      observer.observe(document.body, { childList: true })
    }
  })
}

/** Keep `destination` fed from the highest-priority audible live-player element across stream swaps. */
export function bindPageAudio(opts: BindPageAudioOptions): PageAudioBinding {
  const { context, destination, initial, onLog, interruptionWarnMs = DEFAULT_INTERRUPTION_WARN_MS } = opts
  if (!initial.isOwned()) return { stop: () => {} }

  let stopped = false
  let warnTimer: ReturnType<typeof setTimeout> | null = null
  let warnedInterrupted = false
  let bodyObserver: MutationObserver | null = null

  interface BoundSource extends CapturedElementAudio {
    source: MediaStreamAudioSourceNode
    unbindListeners: () => void
  }

  let bound: BoundSource | null = null

  const clearWarnTimer = (): void => {
    if (warnTimer !== null) {
      clearTimeout(warnTimer)
      warnTimer = null
    }
  }

  const detachBound = (): void => {
    if (!bound) return
    const current = bound
    bound = null
    current.unbindListeners()
    try {
      current.source.disconnect()
    } catch {}
    releaseElementCapture(current.el, current.stream)
  }

  const updateInterruptionState = (candidates: readonly HTMLMediaElement[]): void => {
    const healthy = bound !== null && bound.track.readyState === 'live' && isPlayable(bound.el) && isAudible(bound.el)
    if (healthy) {
      clearWarnTimer()
      if (warnedInterrupted) {
        warnedInterrupted = false
        onLog?.('🎤 网页直播音源已自动恢复')
      }
      return
    }
    if (warnedInterrupted || warnTimer !== null) return
    warnTimer = setTimeout(() => {
      warnTimer = null
      if (stopped || warnedInterrupted) return
      const ref = bound?.el ?? candidates[0]
      warnedInterrupted = true
      if (ref && !isAudible(ref)) {
        onLog?.('⚠️ 网页直播音源已静音，转录暂停输出（取消静音后将自动恢复）')
      } else if (ref?.paused) {
        onLog?.('⚠️ 网页直播音源已暂停（恢复播放后将自动重连）')
      } else {
        onLog?.('⚠️ 网页直播音源已中断（恢复播放后将自动重连）')
      }
    }, interruptionWarnMs)
  }

  const attach = (captured: CapturedElementAudio): void => {
    detachBound()
    let source: MediaStreamAudioSourceNode
    try {
      source = context.createMediaStreamSource(captured.stream)
      source.connect(destination)
    } catch (err) {
      releaseElementCapture(captured.el, captured.stream)
      throw err
    }

    // Direct listeners catch queued media tasks on `el` after `audioEl.remove()` detaches it from `document`.
    const onElementEvent = (event: Event): void => {
      if (event.type === 'ended' || captured.el.isConnected !== true) reconcile()
    }
    captured.track.addEventListener('ended', reconcile)
    captured.stream.addEventListener('addtrack', reconcile)
    captured.stream.addEventListener('removetrack', reconcile)
    for (const evt of ELEMENT_MEDIA_EVENTS) {
      captured.el.addEventListener(evt, onElementEvent)
    }

    bound = {
      ...captured,
      source,
      unbindListeners: () => {
        captured.track.removeEventListener('ended', reconcile)
        captured.stream.removeEventListener('addtrack', reconcile)
        captured.stream.removeEventListener('removetrack', reconcile)
        for (const evt of ELEMENT_MEDIA_EVENTS) {
          captured.el.removeEventListener(evt, onElementEvent)
        }
      },
    }
  }

  function reconcile(): void {
    if (stopped) return
    if (context.state === 'suspended') {
      void context.resume().catch(() => {})
    }

    const candidates = getCandidates()
    if (bound && (bound.track.readyState !== 'live' || !candidates.includes(bound.el) || bound.el.src !== bound.src)) {
      detachBound()
    }

    for (const candidate of candidates) {
      if (!isPlayable(candidate) || !isAudible(candidate)) continue
      if (bound?.el === candidate) break
      const captured = captureElement(candidate)
      if (captured) {
        try {
          attach(captured)
          break
        } catch {}
      }
    }

    updateInterruptionState(candidates)
  }

  attach(initial)

  for (const evt of DOCUMENT_MEDIA_EVENTS) {
    document.addEventListener(evt, reconcile, true)
  }
  // `subtree: false`: `audio-only.ts` mounts `#lc-audio-only-stream` directly on `document.body`, avoiding danmaku churn.
  if (typeof MutationObserver === 'function' && document.body) {
    bodyObserver = new MutationObserver(reconcile)
    bodyObserver.observe(document.body, { childList: true })
  }

  reconcile()

  return {
    stop: () => {
      if (stopped) return
      stopped = true
      clearWarnTimer()
      bodyObserver?.disconnect()
      bodyObserver = null
      for (const evt of DOCUMENT_MEDIA_EVENTS) {
        document.removeEventListener(evt, reconcile, true)
      }
      detachBound()
    },
  }
}
