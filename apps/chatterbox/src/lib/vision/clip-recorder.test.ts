import { describe, expect, test } from 'bun:test'
import { signal } from '@preact/signals'

import type { ClipCanvas, ClipRecorderDeps, ClipVideo } from './clip-recorder'
import type { VisionAvailability } from './types'

import { loadWithMocks } from '../../testing/load-with-mocks'
import * as config from './config'

// Page imports stubbed: the real frame sampler touches the DOM on import.
const { createClipRecorder, getRecentClip, isClipRecordingSupported, startClipRecorder, stopClipRecorder } =
  await loadWithMocks<typeof import('./clip-recorder')>(new URL('./clip-recorder.ts', import.meta.url), {
    '../log': { appendLog: () => {} },
    '../player-dom': { getStreamingPlayerVideo: () => null },
    '../store': { visionMaxEdge: signal(768) },
    './config': config,
    './frame-sampler': { visionAvailability: signal<VisionAvailability>('off') },
  })

const MIME_TYPES = [
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]

interface FakeStream {
  readonly frameRate: number
}

interface FakeTimer {
  at: number
  period: number | null
  callback: () => void
}

/** Manual clock; `advance` fires due timers in time order. */
function createClock() {
  const timers = new Map<number, FakeTimer>()
  let nextId = 0

  function schedule(callback: () => void, ms: number, period: number | null): () => void {
    const id = ++nextId
    timers.set(id, { at: clock.now + ms, period, callback })
    return () => {
      timers.delete(id)
    }
  }

  function nextDue(end: number): [number, FakeTimer] | null {
    let due: [number, FakeTimer] | null = null
    for (const entry of timers) {
      if (entry[1].at <= end && (!due || entry[1].at < due[1].at)) due = entry
    }
    return due
  }

  const clock = {
    now: 0,
    get pending(): number {
      return timers.size
    },
    every: (callback: () => void, ms: number) => schedule(callback, ms, ms),
    after: (callback: () => void, ms: number) => schedule(callback, ms, null),
    advance(ms: number): void {
      const end = clock.now + ms
      let due = nextDue(end)
      while (due) {
        const [id, timer] = due
        clock.now = timer.at
        if (timer.period === null) timers.delete(id)
        else timer.at += timer.period
        timer.callback()
        due = nextDue(end)
      }
      clock.now = end
    },
  }
  return clock
}

interface FakePage {
  availability: VisionAvailability
  video: ClipVideo | null
  maxEdge: number
  /** Whether a stopped recorder delivers its data and `stop`. */
  finalize: boolean
  /** Error thrown by `MediaRecorder.start`. */
  startError: Error | null
}

type FakeDeps = ClipRecorderDeps<ClipVideo, FakeStream, string>

function createEnv(options: { types?: readonly string[]; deps?: Partial<FakeDeps> } = {}) {
  const clock = createClock()
  const types = options.types ?? MIME_TYPES
  const page: FakePage = {
    availability: 'ok',
    video: { videoWidth: 1920, videoHeight: 1080 },
    maxEdge: 768,
    finalize: true,
    startError: null,
  }
  const probed: string[] = []
  const draws: { at: number; image: ClipVideo; width: number; height: number }[] = []
  const streams: FakeStream[] = []
  const logs: string[] = []
  const recorders: FakeRecorder[] = []

  class FakeRecorder {
    static isTypeSupported(type: string): boolean {
      probed.push(type)
      return types.includes(type)
    }

    readonly id = recorders.length + 1
    readonly stream: FakeStream
    readonly options: { mimeType: string; videoBitsPerSecond: number }
    state: 'inactive' | 'recording' = 'inactive'
    startedAt: number | null = null
    stoppedAt: number | null = null
    ondataavailable: ((event: { data: string }) => void) | null = null
    onstop: (() => void) | null = null

    constructor(stream: FakeStream, recorderOptions: { mimeType: string; videoBitsPerSecond: number }) {
      this.stream = stream
      this.options = recorderOptions
      recorders.push(this)
    }

    start(): void {
      if (page.startError) throw page.startError
      this.state = 'recording'
      this.startedAt = clock.now
    }

    stop(): void {
      this.state = 'inactive'
      this.stoppedAt = clock.now
      if (!page.finalize) return
      // Like MediaRecorder: the final data and `stop` arrive asynchronously.
      queueMicrotask(() => {
        this.ondataavailable?.({ data: `clip-${this.id}` })
        this.onstop?.()
      })
    }
  }

  const canvas: ClipCanvas<ClipVideo, FakeStream> = {
    width: 300,
    height: 150,
    getContext: () => ({
      drawImage: (image, _dx, _dy, width, height) => {
        draws.push({ at: clock.now, image, width, height })
      },
    }),
    captureStream: frameRate => {
      const stream = { frameRate }
      streams.push(stream)
      return stream
    },
  }

  const deps: FakeDeps = {
    createCanvas: () => canvas,
    MediaRecorder: FakeRecorder,
    findVideo: () => page.video,
    availability: () => page.availability,
    maxEdge: () => page.maxEdge,
    now: () => clock.now,
    every: clock.every,
    after: clock.after,
    toBase64: async chunks => btoa(chunks.join('')),
    log: message => {
      logs.push(message)
    },
  }
  const recorder = createClipRecorder({ ...deps, ...options.deps })
  /** [startedAt, stoppedAt] of every recorder created so far. */
  const runs = () => recorders.map(r => [r.startedAt, r.stoppedAt])
  return { clock, page, canvas, recorder, recorders, probed, draws, streams, logs, runs }
}

describe('support', () => {
  test('probes mime types in preference order and stops at the first supported one', () => {
    const env = createEnv({ types: ['video/webm;codecs=vp8', 'video/webm'] })
    expect(env.recorder.isSupported()).toBe(true)
    expect(env.probed).toEqual(['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8'])
  })

  const cases: [string, { types?: readonly string[]; deps?: Partial<FakeDeps> }][] = [
    ['MediaRecorder is missing', { deps: { MediaRecorder: undefined } }],
    ['no mime type is supported', { types: [] }],
    ['there is no DOM', { deps: { createCanvas: () => null } }],
    [
      'canvas.captureStream is missing',
      { deps: { createCanvas: () => ({ width: 300, height: 150, getContext: () => ({ drawImage: () => {} }) }) } },
    ],
    [
      'the canvas has no 2d context',
      {
        deps: {
          createCanvas: () => ({
            width: 300,
            height: 150,
            getContext: () => null,
            captureStream: frameRate => ({ frameRate }),
          }),
        },
      },
    ],
  ]
  for (const [label, options] of cases) {
    test(`unsupported when ${label}`, async () => {
      const env = createEnv(options)
      expect(env.recorder.isSupported()).toBe(false)
      env.recorder.start()
      expect(env.clock.pending).toBe(0)
      env.clock.advance(10_000)
      expect(env.recorders).toHaveLength(0)
      expect(await env.recorder.getRecentClip()).toBeNull()
      env.recorder.stop()
    })
  }

  test('the page instance is unsupported outside a browser and never throws', async () => {
    expect(isClipRecordingSupported()).toBe(false)
    startClipRecorder()
    expect(await getRecentClip()).toBeNull()
    stopClipRecorder()
  })
})

describe('mime type', () => {
  const cases: [readonly string[], string, string][] = [
    [MIME_TYPES, 'video/mp4;codecs=avc1', 'video/mp4'],
    [['video/mp4', 'video/webm;codecs=vp9', 'video/webm'], 'video/mp4', 'video/mp4'],
    [['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'], 'video/webm;codecs=vp9', 'video/webm'],
    [['video/webm;codecs=vp8', 'video/webm'], 'video/webm;codecs=vp8', 'video/webm'],
    [['video/webm'], 'video/webm', 'video/webm'],
  ]
  for (const [types, mimeType, baseMime] of cases) {
    test(`records ${mimeType} and labels the clip ${baseMime}`, async () => {
      const env = createEnv({ types })
      env.recorder.start()
      env.clock.advance(3250)
      expect(env.recorders[0].options).toEqual({ mimeType, videoBitsPerSecond: 500_000 })
      const clip = await env.recorder.getRecentClip()
      expect(clip?.mimeType).toBe(baseMime)
      expect(clip?.dataUrl).toBe(`data:${baseMime};base64,${btoa('clip-1')}`)
    })
  }
})

describe('drawing', () => {
  test('mirrors the player at 4 fps at the configured long edge', () => {
    const env = createEnv()
    const video: ClipVideo = { videoWidth: 1920, videoHeight: 1080 }
    env.page.video = video
    env.recorder.start()
    env.clock.advance(1000)
    expect(env.draws).toEqual([250, 500, 750, 1000].map(at => ({ at, image: video, width: 768, height: 432 })))
    expect([env.canvas.width, env.canvas.height]).toEqual([768, 432])
    expect(env.streams).toEqual([{ frameRate: 4 }])
  })

  const sizes: [string, ClipVideo, number, [number, number]][] = [
    ['portrait', { videoWidth: 1080, videoHeight: 1920 }, 768, [432, 768]],
    ['a smaller video, without upscaling', { videoWidth: 640, videoHeight: 360 }, 768, [640, 360]],
    ['the low edge', { videoWidth: 1920, videoHeight: 1080 }, 512, [512, 288]],
    ['odd sizes, in even pixels', { videoWidth: 1366, videoHeight: 768 }, 1024, [1024, 576]],
    ['an unknown setting, at the default edge', { videoWidth: 1920, videoHeight: 1080 }, 999, [768, 432]],
  ]
  for (const [label, video, maxEdge, size] of sizes) {
    test(`sizes the canvas for ${label}`, () => {
      const env = createEnv()
      env.page.video = video
      env.page.maxEdge = maxEdge
      env.recorder.start()
      env.clock.advance(250)
      expect([env.canvas.width, env.canvas.height]).toEqual(size)
    })
  }

  test('skips draws and stops recording while frames are unavailable, then starts a fresh pair', () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(4250)
    env.page.availability = 'hidden'
    env.clock.advance(1000)
    expect(env.draws).toHaveLength(17)
    expect(env.runs()).toEqual([
      [250, 4500],
      [4250, 4500],
    ])
    expect(env.clock.pending).toBe(1)
    env.page.availability = 'ok'
    env.clock.advance(4250)
    expect(env.runs().slice(2)).toEqual([
      [5500, null],
      [9500, null],
    ])
  })

  test('stops recording when the player video goes away', () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(4250)
    env.page.video = null
    env.clock.advance(250)
    expect(env.recorders.map(r => r.state)).toEqual(['inactive', 'inactive'])
    expect(env.draws).toHaveLength(17)
  })

  test('starts a fresh pair at the new size when the long edge changes', () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(4250)
    env.page.maxEdge = 512
    env.clock.advance(250)
    expect([env.canvas.width, env.canvas.height]).toEqual([512, 288])
    expect(env.runs()).toEqual([
      [250, 4500],
      [4250, 4500],
      [4500, null],
    ])
  })
})

describe('recording', () => {
  test('staggers two recorders by 4 s and restarts each every 8 s', () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(250)
    expect(env.runs()).toEqual([[250, null]])
    env.clock.advance(4000)
    expect(env.runs()).toEqual([
      [250, null],
      [4250, null],
    ])
    env.clock.advance(4000)
    expect(env.runs()).toEqual([
      [250, 8250],
      [4250, null],
      [8250, null],
    ])
    env.clock.advance(4000)
    expect(env.runs()).toEqual([
      [250, 8250],
      [4250, 12250],
      [8250, null],
      [12250, null],
    ])
    expect(env.streams).toHaveLength(1)
    expect(env.recorders.every(r => r.stream === env.streams[0])).toBe(true)
  })

  test('getRecentClip finalizes the longest-running recorder, restarts it and returns the clip', async () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(6250)
    expect(await env.recorder.getRecentClip()).toEqual({
      dataUrl: `data:video/mp4;base64,${btoa('clip-1')}`,
      mimeType: 'video/mp4',
      durationMs: 6000,
      endedAt: 6250,
    })
    expect(env.runs()).toEqual([
      [250, 6250],
      [4250, null],
      [6250, null],
    ])
    env.clock.advance(1000)
    expect(await env.recorder.getRecentClip()).toEqual({
      dataUrl: `data:video/mp4;base64,${btoa('clip-2')}`,
      mimeType: 'video/mp4',
      durationMs: 3000,
      endedAt: 7250,
    })
  })

  test('a restarted recorder keeps its 8 s rotation', async () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(6250)
    await env.recorder.getRecentClip()
    env.clock.advance(2000)
    expect(env.runs()).toEqual([
      [250, 6250],
      [4250, null],
      [6250, 8250],
      [8250, null],
    ])
  })

  test('getRecentClip returns null until a recorder has run 3 s', async () => {
    const env = createEnv()
    expect(await env.recorder.getRecentClip()).toBeNull()
    env.recorder.start()
    env.clock.advance(3249)
    expect(await env.recorder.getRecentClip()).toBeNull()
    expect(env.runs()).toEqual([[250, null]])
    env.clock.advance(1)
    expect(await env.recorder.getRecentClip()).toMatchObject({ durationMs: 3000 })
  })

  test('getRecentClip returns null when the recorder never finalizes', async () => {
    const env = createEnv()
    env.recorder.start()
    env.clock.advance(6250)
    env.page.finalize = false
    const clip = env.recorder.getRecentClip()
    env.clock.advance(2000)
    expect(await clip).toBeNull()
  })

  test('ref-counts start/stop; the last stop ends both recorders and the draw timer', async () => {
    const env = createEnv()
    env.recorder.start()
    env.recorder.start()
    env.clock.advance(4250)
    env.recorder.stop()
    env.clock.advance(250)
    expect(env.draws).toHaveLength(18)
    expect(env.recorders.map(r => r.state)).toEqual(['recording', 'recording'])
    env.recorder.stop()
    expect(env.recorders.map(r => r.state)).toEqual(['inactive', 'inactive'])
    expect(env.clock.pending).toBe(0)
    env.clock.advance(10_000)
    expect(env.draws).toHaveLength(18)
    expect(await env.recorder.getRecentClip()).toBeNull()
    env.recorder.stop()
    env.recorder.start()
    env.clock.advance(250)
    expect(env.recorders).toHaveLength(3)
    env.recorder.stop()
    expect(env.clock.pending).toBe(0)
  })

  test('a recorder that fails to start disables clips and logs once', () => {
    const env = createEnv()
    env.page.startError = new Error('boom')
    env.recorder.start()
    env.clock.advance(1000)
    expect(env.recorder.isSupported()).toBe(false)
    expect(env.clock.pending).toBe(0)
    expect(env.logs).toEqual(['⚠️ [画面识别] 无法录制视频片段，已改用截图：boom'])
    env.recorder.stop()
    env.recorder.start()
    expect(env.clock.pending).toBe(0)
  })
})
