import type { RecentClip, VisionAvailability } from './types'

import { appendLog } from '../log'
import { getStreamingPlayerVideo } from '../player-dom'
import { visionMaxEdge } from '../store'
import { fitLongEdge, resolveVisionEdge } from './config'
import { visionAvailability } from './frame-sampler'

/** Recorder formats in preference order; clips are labelled with the part before `;`. */
const MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const
const CAPTURE_FPS = 4
const DRAW_INTERVAL_MS = 1000 / CAPTURE_FPS
const SEGMENT_MS = 8000
/** The second recorder trails by half a segment, so once both run one of them always holds 4–8 s. */
const STAGGER_MS = 4000
const MIN_CLIP_MS = 3000
/** Give up on a recorder that never delivers its final data. */
const STOP_TIMEOUT_MS = 2000
const VIDEO_BITS_PER_SECOND = 500_000

/** The slice of the player `<video>` the recorder reads. */
export interface ClipVideo {
  readonly videoWidth: number
  readonly videoHeight: number
}

/** The slice of a 2D context used to mirror the player. */
export interface ClipCanvasContext<V> {
  drawImage: (image: V, dx: number, dy: number, dw: number, dh: number) => void
}

/** Detached canvas the recorders capture. */
export interface ClipCanvas<V, S> {
  width: number
  height: number
  getContext: (contextId: '2d', options: { alpha: boolean }) => ClipCanvasContext<V> | null
  captureStream?: (frameRequestRate: number) => S
}

// Method-signature type: its parameter is bivariant, so DOM handlers typed with `this` and BlobEvent still fit.
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack']

/** The slice of a MediaRecorder the recorder drives. */
export interface ClipMediaRecorder<B> {
  readonly state: string
  ondataavailable: Handler<{ readonly data: B }> | null
  onstop: Handler<unknown> | null
  start: () => void
  stop: () => void
}

/** The slice of the MediaRecorder class the recorder uses. */
export interface ClipRecorderClass<S, B> {
  new (stream: S, options: { mimeType: string; videoBitsPerSecond: number }): ClipMediaRecorder<B>
  isTypeSupported: (mimeType: string) => boolean
}

/** DOM and clock access, injected so tests can drive the recorder with fakes. */
export interface ClipRecorderDeps<V extends ClipVideo, S, B> {
  /** A detached canvas, or null without a DOM. */
  createCanvas: () => ClipCanvas<V, S> | null
  /** The MediaRecorder class, or undefined when the browser lacks it. */
  MediaRecorder: ClipRecorderClass<S, B> | undefined
  /** The player video while it streams the room, else null. */
  findVideo: () => V | null
  availability: () => VisionAvailability
  /** Stored long-edge setting (px), before `resolveVisionEdge`. */
  maxEdge: () => number
  /** Wall-clock ms. */
  now: () => number
  /** Call `callback` every `ms`; returns the canceller. */
  every: (callback: () => void, ms: number) => () => void
  /** Call `callback` once after `ms`; returns the canceller. */
  after: (callback: () => void, ms: number) => () => void
  /** Base64 (no `data:` prefix) of the chunks joined into one file. */
  toBase64: (chunks: readonly B[]) => Promise<string>
  log: (message: string) => void
}

/** One rolling recorder; the module-level functions drive the page's shared instance. */
export interface ClipRecorder {
  isSupported: () => boolean
  start: () => void
  stop: () => void
  getRecentClip: () => Promise<RecentClip | null>
}

interface Segment<B> {
  recorder: ClipMediaRecorder<B>
  chunks: B[]
  startedAt: number
}

/** One of the two staggered recorders. */
interface Slot<B> {
  segment: Segment<B> | null
  cancelRotation: (() => void) | null
}

interface Setup<V, S, B> {
  Recorder: ClipRecorderClass<S, B>
  canvas: ClipCanvas<V, S>
  context: ClipCanvasContext<V>
  mimeType: string
  baseMime: string
}

/** Mirrors the player into a canvas at ~4 fps and keeps two staggered 8 s recordings of it. */
export function createClipRecorder<V extends ClipVideo, S, B>(deps: ClipRecorderDeps<V, S, B>): ClipRecorder {
  const slots: Slot<B>[] = [
    { segment: null, cancelRotation: null },
    { segment: null, cancelRotation: null },
  ]
  // undefined until probed; null when unsupported or disabled after a failure.
  let setup: Setup<V, S, B> | null | undefined
  let stream: S | undefined
  let refs = 0
  let recording = false
  let cancelDraw: (() => void) | null = null
  let cancelStagger: (() => void) | null = null

  function probe(): Setup<V, S, B> | null {
    try {
      const Recorder = deps.MediaRecorder
      if (!Recorder) return null
      const mimeType = MIME_TYPES.find(type => Recorder.isTypeSupported(type))
      if (!mimeType) return null
      const canvas = deps.createCanvas()
      const context = canvas?.captureStream ? canvas.getContext('2d', { alpha: false }) : null
      if (!canvas || !context) return null
      return { Recorder, canvas, context, mimeType, baseMime: mimeType.split(';')[0] }
    } catch {
      return null
    }
  }

  function resolveSetup(): Setup<V, S, B> | null {
    if (setup === undefined) setup = probe()
    return setup
  }

  function disable(err: unknown): void {
    setup = null
    cancelDraw?.()
    cancelDraw = null
    stopPair()
    deps.log(`⚠️ [画面识别] 无法录制视频片段，已改用截图：${err instanceof Error ? err.message : String(err)}`)
  }

  function startSegment(slot: Slot<B>): boolean {
    const current = setup
    if (!current || stream === undefined) return false
    const chunks: B[] = []
    try {
      const recorder = new current.Recorder(stream, {
        mimeType: current.mimeType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      })
      recorder.ondataavailable = event => {
        chunks.push(event.data)
      }
      recorder.start()
      slot.segment = { recorder, chunks, startedAt: deps.now() }
      return true
    } catch (err) {
      disable(err)
      return false
    }
  }

  function endSegment(slot: Slot<B>): void {
    const segment = slot.segment
    slot.segment = null
    if (!segment) return
    segment.recorder.ondataavailable = null
    stopRecorder(segment.recorder)
  }

  function rotate(slot: Slot<B>): void {
    endSegment(slot)
    startSegment(slot)
  }

  function startSlot(slot: Slot<B>): void {
    if (startSegment(slot)) slot.cancelRotation = deps.every(() => rotate(slot), SEGMENT_MS)
  }

  function startPair(current: Setup<V, S, B>): void {
    try {
      stream ??= current.canvas.captureStream?.(CAPTURE_FPS)
    } catch (err) {
      disable(err)
      return
    }
    recording = true
    startSlot(slots[0])
    if (!recording) return
    cancelStagger = deps.after(() => {
      cancelStagger = null
      startSlot(slots[1])
    }, STAGGER_MS)
  }

  function stopPair(): void {
    if (!recording) return
    recording = false
    cancelStagger?.()
    cancelStagger = null
    for (const slot of slots) {
      slot.cancelRotation?.()
      slot.cancelRotation = null
      endSegment(slot)
    }
  }

  function draw(): void {
    const current = setup
    if (!current) return
    const video = deps.availability() === 'ok' ? deps.findVideo() : null
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      stopPair()
      return
    }
    const { canvas, context } = current
    // Even pixels for the encoders.
    const { width, height } = fitLongEdge(video.videoWidth, video.videoHeight, resolveVisionEdge(deps.maxEdge()), 2)
    if (canvas.width !== width || canvas.height !== height) {
      // Recorders don't reliably survive a resolution change; start over at the new size.
      stopPair()
      canvas.width = width
      canvas.height = height
    }
    try {
      context.drawImage(video, 0, 0, width, height)
    } catch {
      stopPair()
      return
    }
    if (!recording) startPair(current)
  }

  function oldestRecording(): { slot: Slot<B>; segment: Segment<B> } | null {
    let oldest: { slot: Slot<B>; segment: Segment<B> } | null = null
    for (const slot of slots) {
      const segment = slot.segment
      if (segment?.recorder.state !== 'recording') continue
      if (!oldest || segment.startedAt < oldest.segment.startedAt) oldest = { slot, segment }
    }
    return oldest
  }

  async function getRecentClip(): Promise<RecentClip | null> {
    const current = setup
    const found = oldestRecording()
    const endedAt = deps.now()
    if (!current || !found || endedAt - found.segment.startedAt < MIN_CLIP_MS) return null
    const { slot, segment } = found
    try {
      const finished = new Promise<boolean>(resolve => {
        const cancelTimeout = deps.after(() => resolve(false), STOP_TIMEOUT_MS)
        segment.recorder.onstop = () => {
          cancelTimeout()
          resolve(true)
        }
      })
      slot.segment = null
      stopRecorder(segment.recorder)
      // The slot keeps its rotation schedule, so the pair stays staggered.
      startSegment(slot)
      if (!(await finished) || segment.chunks.length === 0) return null
      const base64 = await deps.toBase64(segment.chunks)
      if (!base64) return null
      return {
        dataUrl: `data:${current.baseMime};base64,${base64}`,
        mimeType: current.baseMime,
        durationMs: endedAt - segment.startedAt,
        endedAt,
      }
    } catch {
      return null
    }
  }

  return {
    isSupported: () => resolveSetup() !== null,
    start() {
      refs++
      if (refs > 1 || !resolveSetup()) return
      cancelDraw = deps.every(draw, DRAW_INTERVAL_MS)
    },
    stop() {
      if (refs === 0) return
      refs--
      if (refs > 0) return
      cancelDraw?.()
      cancelDraw = null
      stopPair()
    },
    getRecentClip,
  }
}

function stopRecorder<B>(recorder: ClipMediaRecorder<B>): void {
  if (recorder.state !== 'inactive') recorder.stop()
}

function blobsToBase64(chunks: readonly Blob[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('无法读取视频片段'))
    reader.readAsDataURL(new Blob([...chunks]))
  })
}

function browserDeps(): ClipRecorderDeps<HTMLVideoElement, MediaStream, Blob> {
  return {
    createCanvas: () => (typeof document === 'undefined' ? null : document.createElement('canvas')),
    MediaRecorder: typeof MediaRecorder === 'undefined' ? undefined : MediaRecorder,
    findVideo: getStreamingPlayerVideo,
    availability: () => visionAvailability.peek(),
    maxEdge: () => visionMaxEdge.peek(),
    now: () => Date.now(),
    every: (callback, ms) => {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
    after: (callback, ms) => {
      const id = setTimeout(callback, ms)
      return () => clearTimeout(id)
    },
    toBase64: blobsToBase64,
    log: message => appendLog(message),
  }
}

let pageRecorder: ClipRecorder | null = null

function clipRecorder(): ClipRecorder {
  pageRecorder ??= createClipRecorder(browserDeps())
  return pageRecorder
}

/** Whether this browser can record clips (MediaRecorder, canvas.captureStream and a supported mime type). */
export function isClipRecordingSupported(): boolean {
  return clipRecorder().isSupported()
}

/** Ref-counted start of the rolling recorder. */
export function startClipRecorder(): void {
  clipRecorder().start()
}

/** Ref-counted stop of the rolling recorder. */
export function stopClipRecorder(): void {
  clipRecorder().stop()
}

/** Finalize and return the most recent 3–8 s clip, or null when not recording, unsupported or too short. */
export function getRecentClip(): Promise<RecentClip | null> {
  return clipRecorder().getRecentClip()
}
