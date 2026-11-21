import { type ReadonlySignal, type Signal, signal } from '@preact/signals'

import type { SceneCutEvent, VisionAvailability, VisionFrame } from './types'

import { appendLog } from '../log'
import { isTabHidden } from '../page-visibility'
import { getStreamingPlayerVideo } from '../player-dom'
import { audioOnlyActive, visionMaxEdge } from '../store'
import { fitLongEdge, resolveVisionEdge } from './config'
import {
  BLANK_VARIANCE,
  KEEP_DIFF,
  LUMA_HEIGHT,
  LUMA_WIDTH,
  lumaDiff,
  lumaVariance,
  rgbaToLuma,
  SCENE_CUT_DIFF,
} from './luma'

const TICK_MS = 1000
/** No frame progress for longer than this reads as a frozen stream. */
const STALL_MS = 2500
/** Keep a frame at least this often, even on a static picture. */
const REFRESH_MS = 5000
const KEEP_WINDOW_MS = 30_000
const MAX_KEPT = 12
const HAVE_CURRENT_DATA = 2
const THUMB_EDGE = 160
const FRAME_QUALITY = 0.75
const THUMB_QUALITY = 0.7

/** The slice of the player `<video>` the sampler reads. */
export interface SamplerVideo {
  readonly paused: boolean
  readonly ended: boolean
  readonly readyState: number
  readonly currentTime: number
  getVideoPlaybackQuality(): { readonly totalVideoFrames: number }
}

/** DOM and clock access, injected so tests can drive the sampler with fakes. */
export interface FrameSamplerDeps<V extends SamplerVideo> {
  /** The player video while it streams the room, else null. */
  findVideo: () => V | null
  isTabHidden: () => boolean
  isAudioOnly: () => boolean
  /** Wall-clock ms. */
  now: () => number
  /** Call `callback` every `ms`; returns the canceller. */
  repeat: (callback: () => void, ms: number) => () => void
  /** LUMA_WIDTH×LUMA_HEIGHT luma of the current picture. */
  captureLuma: (video: V) => Promise<Uint8Array>
  /** The current picture as JPEG data URLs: `dataUrl` at `longEdge`, `thumbUrl` at ~160 px. */
  encodeFrame: (video: V, longEdge: number) => Promise<{ dataUrl: string; thumbUrl: string }>
  /** Stored long-edge setting (px), before `resolveVisionEdge`. */
  maxEdge: () => number
  log: (message: string) => void
}

/** One sampler; the module-level functions drive the page's shared instance. */
export interface FrameSampler {
  readonly availability: ReadonlySignal<VisionAvailability>
  start: () => void
  stop: () => void
  keptFrames: () => readonly VisionFrame[]
  grabCurrentFrame: () => Promise<VisionFrame | null>
  /** Luma of the newest 'ok' sample, kept or not. */
  latestLuma: () => Uint8Array | null
  onSceneCut: (listener: (event: SceneCutEvent) => void) => () => void
}

/** Ref-counted ~1 Hz sampler of the player picture; reports its state through `availability`. */
export function createFrameSampler<V extends SamplerVideo>(
  deps: FrameSamplerDeps<V>,
  availability: Signal<VisionAvailability> = signal('off')
): FrameSampler {
  const listeners = new Set<(event: SceneCutEvent) => void>()
  let refs = 0
  // Bumped on the final stop so work still in flight from the old run is dropped.
  let run = 0
  let busy = false
  let cancelTimer: (() => void) | null = null
  let kept: VisionFrame[] = []
  let latestLuma: Uint8Array | null = null
  let progress: { video: V; time: number; frames: number; at: number } | null = null
  let errorLogged = false

  function findPlaying(): { video: V } | { status: VisionAvailability } {
    if (deps.isAudioOnly()) return { status: 'audio-only' }
    if (deps.isTabHidden()) return { status: 'hidden' }
    const video = deps.findVideo()
    if (!video) return { status: 'no-video' }
    if (video.paused || video.ended || video.readyState < HAVE_CURRENT_DATA) return { status: 'paused' }
    return { video }
  }

  /** Whether `video` showed no new frame for over STALL_MS; any progress or a new element restarts the clock. */
  function isStalled(video: V, now: number): boolean {
    const time = video.currentTime
    const frames = video.getVideoPlaybackQuality().totalVideoFrames
    if (progress?.video === video && progress.time === time && progress.frames === frames) {
      return now - progress.at > STALL_MS
    }
    progress = { video, time, frames, at: now }
    return false
  }

  /** The video to read now, or why there is none. */
  function locate(now: number): { video: V } | { status: VisionAvailability } {
    const found = findPlaying()
    if ('status' in found) {
      progress = null
      return found
    }
    return isStalled(found.video, now) ? { status: 'stalled' } : found
  }

  async function encode(video: V, at: number, luma: Uint8Array): Promise<VisionFrame> {
    const { dataUrl, thumbUrl } = await deps.encodeFrame(video, resolveVisionEdge(deps.maxEdge()))
    return { at, luma, dataUrl, thumbUrl }
  }

  function prune(now: number): void {
    const newest = kept.at(-1)
    kept = kept.filter(frame => frame === newest || now - frame.at <= KEEP_WINDOW_MS).slice(-MAX_KEPT)
  }

  function notify(event: SceneCutEvent): void {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (err) {
        console.error('[LAPLACE Chatterbox] onSceneCut listener failed:', err)
      }
    }
  }

  async function sample(): Promise<void> {
    const current = run
    const now = deps.now()
    try {
      prune(now)
      const found = locate(now)
      if ('status' in found) {
        availability.value = found.status
        return
      }
      const luma = await deps.captureLuma(found.video)
      if (current !== run) return
      if (lumaVariance(luma) < BLANK_VARIANCE) {
        availability.value = 'blank'
        return
      }
      const last = kept.at(-1)
      const cut = latestLuma !== null && lumaDiff(latestLuma, luma) >= SCENE_CUT_DIFF
      const keep = cut || !last || now - last.at >= REFRESH_MS || lumaDiff(last.luma, luma) >= KEEP_DIFF
      const frame = keep ? await encode(found.video, now, luma) : null
      if (current !== run) return
      if (frame) {
        kept = [...kept, frame]
        prune(now)
      }
      latestLuma = luma
      availability.value = 'ok'
      if (cut && frame) notify({ at: now, before: last ?? null, after: frame })
    } catch (err) {
      if (current !== run) return
      availability.value = 'error'
      if (errorLogged) return
      errorLogged = true
      deps.log(`⚠️ [画面识别] 无法读取直播画面：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function tick(): Promise<void> {
    if (refs === 0 || busy) return
    busy = true
    try {
      await sample()
    } finally {
      busy = false
    }
  }

  return {
    availability,
    start() {
      refs++
      if (refs > 1) return
      cancelTimer = deps.repeat(() => void tick(), TICK_MS)
      // Deferred so a start from inside an effect never writes `availability` during that effect.
      queueMicrotask(() => void tick())
    },
    stop() {
      if (refs === 0) return
      refs--
      if (refs > 0) return
      cancelTimer?.()
      cancelTimer = null
      run++
      kept = []
      latestLuma = null
      progress = null
      errorLogged = false
      availability.value = 'off'
    },
    keptFrames: () => kept,
    async grabCurrentFrame() {
      if (refs === 0) return null
      const current = run
      const now = deps.now()
      try {
        const found = locate(now)
        if ('status' in found) return null
        const luma = await deps.captureLuma(found.video)
        if (lumaVariance(luma) < BLANK_VARIANCE) return null
        const frame = await encode(found.video, now, luma)
        return current === run ? frame : null
      } catch {
        return null
      }
    },
    latestLuma: () => latestLuma,
    onSceneCut(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

async function toJpegDataUrl(
  image: ImageBitmap,
  size: { width: number; height: number },
  quality: number
): Promise<string> {
  const canvas = new OffscreenCanvas(size.width, size.height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建画布')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, size.width, size.height)
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('无法编码画面'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('无法编码画面'))
    reader.readAsDataURL(blob)
  })
}

async function encodeVideoFrame(video: HTMLVideoElement, longEdge: number) {
  const size = fitLongEdge(video.videoWidth, video.videoHeight, longEdge)
  const bitmap = await createImageBitmap(video, {
    resizeWidth: size.width,
    resizeHeight: size.height,
    resizeQuality: 'high',
  })
  try {
    const [dataUrl, thumbUrl] = await Promise.all([
      toJpegDataUrl(bitmap, size, FRAME_QUALITY),
      toJpegDataUrl(bitmap, fitLongEdge(size.width, size.height, THUMB_EDGE), THUMB_QUALITY),
    ])
    return { dataUrl, thumbUrl }
  } finally {
    bitmap.close()
  }
}

function browserDeps(): FrameSamplerDeps<HTMLVideoElement> {
  let lumaContext: OffscreenCanvasRenderingContext2D | null = null
  return {
    findVideo: getStreamingPlayerVideo,
    isTabHidden,
    isAudioOnly: () => audioOnlyActive.peek(),
    now: () => Date.now(),
    repeat: (callback, ms) => {
      const id = setInterval(callback, ms)
      return () => clearInterval(id)
    },
    captureLuma: async video => {
      const bitmap = await createImageBitmap(video, {
        resizeWidth: LUMA_WIDTH,
        resizeHeight: LUMA_HEIGHT,
        resizeQuality: 'low',
      })
      try {
        lumaContext ??= new OffscreenCanvas(LUMA_WIDTH, LUMA_HEIGHT).getContext('2d', { willReadFrequently: true })
        if (!lumaContext) throw new Error('无法创建画布')
        lumaContext.drawImage(bitmap, 0, 0)
        return rgbaToLuma(lumaContext.getImageData(0, 0, LUMA_WIDTH, LUMA_HEIGHT).data)
      } finally {
        bitmap.close()
      }
    },
    encodeFrame: encodeVideoFrame,
    maxEdge: () => visionMaxEdge.peek(),
    log: message => appendLog(message),
  }
}

/** Current availability; 'off' while stopped. */
export const visionAvailability = signal<VisionAvailability>('off')

let pageSampler: FrameSampler | null = null

function sampler(): FrameSampler {
  pageSampler ??= createFrameSampler(browserDeps(), visionAvailability)
  return pageSampler
}

/** Ref-counted start; samples ~1 Hz while running. */
export function startFrameSampler(): void {
  sampler().start()
}

/** Ref-counted stop; at zero clears the buffer and sets 'off'. */
export function stopFrameSampler(): void {
  sampler().stop()
}

/** Kept distinct frames from the last ~30 s, oldest first. */
export function getKeptFrames(): readonly VisionFrame[] {
  return sampler().keptFrames()
}

/** Capture the current frame now (JPEG + thumb + luma), or null when unavailable or stopped. */
export function grabCurrentFrame(): Promise<VisionFrame | null> {
  return sampler().grabCurrentFrame()
}

/** Luma of the latest successful sample, or null. */
export function getLatestLuma(): Uint8Array | null {
  return sampler().latestLuma()
}

/** Subscribe to scene cuts; returns unsubscribe. */
export function onSceneCut(listener: (event: SceneCutEvent) => void): () => void {
  return sampler().onSceneCut(listener)
}
