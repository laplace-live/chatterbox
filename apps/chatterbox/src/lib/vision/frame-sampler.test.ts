import { describe, expect, spyOn, test } from 'bun:test'

import type { FrameSamplerDeps, SamplerVideo } from './frame-sampler'
import type { SceneCutEvent, VisionAvailability } from './types'

import { loadWithFakeGm } from '../../testing/fake-gm'
import { KEEP_DIFF, LUMA_HEIGHT, LUMA_WIDTH, SCENE_CUT_DIFF } from './luma'

/** page-visibility.ts reads `Document.prototype` on load, and Bun has no DOM. */
async function loadFrameSampler() {
  const stubbed = !('Document' in globalThis)
  if (stubbed) Reflect.set(globalThis, 'Document', class {})
  try {
    return await loadWithFakeGm<typeof import('./frame-sampler')>(new URL('./frame-sampler.ts', import.meta.url))
  } finally {
    if (stubbed) Reflect.deleteProperty(globalThis, 'Document')
  }
}

const mod = await loadFrameSampler()

const T0 = 1_000_000

/** A textured picture; `lumaDiff(picture(a), picture(b))` is exactly |a − b|. */
function picture(level: number): Uint8Array {
  return Uint8Array.from({ length: LUMA_WIDTH * LUMA_HEIGHT }, (_, i) => level + (i % LUMA_WIDTH))
}

function blank(): Uint8Array {
  return new Uint8Array(LUMA_WIDTH * LUMA_HEIGHT).fill(16)
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A promise that stays pending until `open()`. */
function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

interface FakeVideo extends SamplerVideo {
  paused: boolean
  ended: boolean
  readyState: number
  currentTime: number
  totalVideoFrames: number
}

function fakeVideo(): FakeVideo {
  const video: FakeVideo = {
    paused: false,
    ended: false,
    readyState: 4,
    currentTime: 0,
    totalVideoFrames: 0,
    getVideoPlaybackQuality: () => ({ totalVideoFrames: video.totalVideoFrames }),
  }
  return video
}

interface Env {
  now: number
  audioOnly: boolean
  hidden: boolean
  video: FakeVideo | null
  /** Advance the video's clock and frame counter on every tick. */
  playing: boolean
  luma: Uint8Array
  /** When set, captures wait on it first. */
  captureGate: Promise<void> | null
  /** When set, encodes wait on it first. */
  encodeGate: Promise<void> | null
  captureError: Error | null
  encodeError: Error | null
  maxEdge: number
}

function setup(overrides: Partial<Env> = {}) {
  const video = fakeVideo()
  const env: Env = {
    now: T0,
    audioOnly: false,
    hidden: false,
    video,
    playing: true,
    luma: picture(100),
    captureGate: null,
    encodeGate: null,
    captureError: null,
    encodeError: null,
    maxEdge: 768,
    ...overrides,
  }
  const timers: { ms: number; callback: () => void; cancelled: boolean }[] = []
  const captures: FakeVideo[] = []
  const edges: number[] = []
  const logs: string[] = []
  const deps: FrameSamplerDeps<FakeVideo> = {
    findVideo: () => env.video,
    isTabHidden: () => env.hidden,
    isAudioOnly: () => env.audioOnly,
    now: () => env.now,
    repeat: (callback, ms) => {
      const timer = { ms, callback, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    captureLuma: async target => {
      captures.push(target)
      if (env.captureGate) await env.captureGate
      if (env.captureError) throw env.captureError
      return env.luma
    },
    encodeFrame: async (_target, longEdge) => {
      edges.push(longEdge)
      if (env.encodeGate) await env.encodeGate
      if (env.encodeError) throw env.encodeError
      return {
        dataUrl: `data:image/jpeg;base64,frame${edges.length}`,
        thumbUrl: `data:image/jpeg;base64,thumb${edges.length}`,
      }
    },
    maxEdge: () => env.maxEdge,
    log: message => {
      logs.push(message)
    },
  }
  const sampler = mod.createFrameSampler(deps)
  return {
    env,
    video,
    sampler,
    captures,
    edges,
    logs,
    activeTimers: () => timers.filter(timer => !timer.cancelled),
    status: () => sampler.availability.value,
    /** Kept frame times relative to T0. */
    keptAt: () => sampler.keptFrames().map(frame => frame.at - T0),
    async start() {
      sampler.start()
      await settle()
    },
    /** Advance the clock by `ms`, fire the sampling timer and let the sample finish. */
    async tick(ms = 1000) {
      env.now += ms
      if (env.playing && env.video) {
        env.video.currentTime += ms / 1000
        env.video.totalVideoFrames += Math.round(ms / 40)
      }
      for (const timer of timers) if (!timer.cancelled) timer.callback()
      await settle()
    },
  }
}

describe('availability', () => {
  test('stays off until started', async () => {
    const h = setup()
    await h.tick()
    expect(h.status()).toBe('off')
    expect(h.captures).toHaveLength(0)
  })

  test('ranks audio-only > hidden > no-video > paused > error > blank > ok', async () => {
    const h = setup({ audioOnly: true, hidden: true, video: null, captureError: new Error('boom'), luma: blank() })
    const fixes: [Partial<Env>, Partial<FakeVideo>, VisionAvailability][] = [
      [{ audioOnly: false }, {}, 'hidden'],
      [{ hidden: false }, {}, 'no-video'],
      [{ video: h.video }, { paused: true }, 'paused'],
      [{}, { paused: false, ended: true }, 'paused'],
      [{}, { ended: false, readyState: 1 }, 'paused'],
      [{}, { readyState: 2 }, 'error'],
      [{ captureError: null }, {}, 'blank'],
      [{ luma: picture(100) }, {}, 'ok'],
    ]
    await h.start()
    expect(h.status()).toBe('audio-only')
    for (const [env, video, status] of fixes) {
      Object.assign(h.env, env)
      Object.assign(h.video, video)
      await h.tick()
      expect(h.status()).toBe(status)
    }
    expect(h.captures).toHaveLength(3)
  })

  test('reports stalled only after 2.5 s without frame progress', async () => {
    const h = setup()
    await h.start()
    h.env.playing = false
    await h.tick(1000)
    await h.tick(1500)
    expect(h.status()).toBe('ok')
    await h.tick(1)
    expect(h.status()).toBe('stalled')
    const captured = h.captures.length
    await h.tick()
    expect(h.captures).toHaveLength(captured)
    h.video.totalVideoFrames++
    await h.tick()
    expect(h.status()).toBe('ok')
  })

  test('counts either the clock or the frame counter moving as progress', async () => {
    const h = setup()
    await h.start()
    h.env.playing = false
    for (let i = 0; i < 4; i++) {
      h.video.totalVideoFrames += 25
      await h.tick()
    }
    for (let i = 0; i < 4; i++) {
      h.video.currentTime += 1
      await h.tick()
    }
    expect(h.status()).toBe('ok')
  })

  test('restarts the stall clock after the player was unavailable or replaced', async () => {
    const h = setup()
    await h.start()
    h.env.playing = false
    await h.tick(2000)
    h.env.hidden = true
    await h.tick(5000)
    expect(h.status()).toBe('hidden')
    h.env.hidden = false
    await h.tick(1000)
    await h.tick(2000)
    expect(h.status()).toBe('ok')
    h.env.video = fakeVideo()
    await h.tick(1000)
    expect(h.status()).toBe('ok')
    await h.tick(2501)
    expect(h.status()).toBe('stalled')
  })

  test('reports a capture failure as error and logs it once per run', async () => {
    const h = setup({ captureError: new Error('canvas tainted') })
    await h.start()
    expect(h.status()).toBe('error')
    await h.tick()
    h.env.captureError = null
    await h.tick()
    expect(h.status()).toBe('ok')
    h.env.captureError = new Error('decode failed')
    await h.tick()
    expect(h.status()).toBe('error')
    expect(h.logs).toEqual(['⚠️ [画面识别] 无法读取直播画面：canvas tainted'])
    h.sampler.stop()
    await h.start()
    expect(h.logs).toEqual([
      '⚠️ [画面识别] 无法读取直播画面：canvas tainted',
      '⚠️ [画面识别] 无法读取直播画面：decode failed',
    ])
  })

  test('reports a failed encode as error and keeps the frame on the next tick', async () => {
    const h = setup({ encodeError: new Error('encoder busy') })
    await h.start()
    expect(h.status()).toBe('error')
    expect(h.sampler.keptFrames()).toEqual([])
    expect(h.sampler.latestSample()).toBeNull()
    h.env.encodeError = null
    await h.tick()
    expect(h.status()).toBe('ok')
    expect(h.keptAt()).toEqual([1000])
  })
})

describe('kept frames', () => {
  test('keeps the first frame, then a KEEP_DIFF change from the last kept one', async () => {
    const h = setup()
    await h.start()
    h.env.luma = picture(100 + KEEP_DIFF - 1)
    await h.tick()
    h.env.luma = picture(100 + KEEP_DIFF)
    await h.tick()
    expect(h.keptAt()).toEqual([0, 2000])
    expect(h.sampler.keptFrames()[1]).toEqual({
      at: T0 + 2000,
      luma: picture(100 + KEEP_DIFF),
      dataUrl: 'data:image/jpeg;base64,frame2',
      thumbUrl: 'data:image/jpeg;base64,thumb2',
    })
  })

  test('refreshes a static picture every 5 s', async () => {
    const h = setup()
    await h.start()
    for (let i = 0; i < 4; i++) await h.tick()
    expect(h.keptAt()).toEqual([0])
    await h.tick()
    expect(h.keptAt()).toEqual([0, 5000])
  })

  test('encodes at the resolved long edge', async () => {
    const h = setup({ maxEdge: 999 })
    await h.start()
    h.env.maxEdge = 1024
    h.env.luma = picture(120)
    await h.tick()
    expect(h.edges).toEqual([768, 1024])
  })

  test('drops frames older than 30 s but always keeps the newest', async () => {
    const h = setup()
    await h.start()
    h.env.luma = picture(110)
    await h.tick()
    h.env.hidden = true
    await h.tick(29_000)
    expect(h.keptAt()).toEqual([0, 1000])
    await h.tick(1)
    expect(h.keptAt()).toEqual([1000])
    await h.tick(60_000)
    expect(h.keptAt()).toEqual([1000])
  })

  test('caps the buffer at the newest 12 frames', async () => {
    const h = setup()
    await h.start()
    for (let i = 1; i <= 14; i++) {
      h.env.luma = picture(i % 2 ? 110 : 100)
      await h.tick()
    }
    expect(h.keptAt()).toEqual(Array.from({ length: 12 }, (_, i) => (i + 3) * 1000))
  })

  test('latestSample follows the newest ok sample, kept or not, with its capture time', async () => {
    const h = setup()
    expect(h.sampler.latestSample()).toBeNull()
    await h.start()
    h.env.luma = picture(102)
    await h.tick()
    expect(h.sampler.keptFrames()).toHaveLength(1)
    expect(h.sampler.latestSample()).toEqual({ at: T0 + 1000, luma: picture(102) })
    h.env.luma = picture(103)
    await h.tick()
    expect(h.sampler.keptFrames()).toHaveLength(1)
    expect(h.sampler.latestSample()).toEqual({ at: T0 + 2000, luma: picture(103) })
    h.env.luma = blank()
    await h.tick()
    expect(h.sampler.latestSample()).toEqual({ at: T0 + 2000, luma: picture(103) })
  })
})

describe('scene cuts', () => {
  test('fire on a SCENE_CUT_DIFF jump between ok samples, with the last kept frame as before', async () => {
    const h = setup({ luma: picture(50) })
    const events: SceneCutEvent[] = []
    h.sampler.onSceneCut(event => events.push(event))
    await h.start()
    const [first] = h.sampler.keptFrames()
    h.env.luma = picture(53)
    await h.tick()
    h.env.luma = picture(53 + SCENE_CUT_DIFF)
    await h.tick()
    expect(events).toHaveLength(1)
    expect(events[0].at).toBe(T0 + 2000)
    expect(events[0].before).toBe(first)
    expect(events[0].after).toBe(h.sampler.keptFrames()[1])
    expect(h.keptAt()).toEqual([0, 2000])

    h.env.luma = picture(53 + 2 * SCENE_CUT_DIFF - 1)
    await h.tick()
    expect(events).toHaveLength(1)

    h.env.luma = blank()
    await h.tick()
    h.env.luma = picture(53 + 3 * SCENE_CUT_DIFF)
    await h.tick()
    expect(events).toHaveLength(2)
    expect(events[1].before?.at).toBe(T0 + 3000)
    expect(events[1].after.at).toBe(T0 + 5000)
  })

  test('notify only once the cut frame is kept and the state is ok', async () => {
    const h = setup()
    const seen: [string, boolean][] = []
    h.sampler.onSceneCut(event => seen.push([h.status(), h.sampler.keptFrames().at(-1) === event.after]))
    await h.start()
    h.env.luma = blank()
    await h.tick()
    h.env.luma = picture(100 + SCENE_CUT_DIFF)
    await h.tick()
    expect(seen).toEqual([['ok', true]])
  })

  test('skip unsubscribed listeners and survive a throwing one', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = setup()
      const events: SceneCutEvent[] = []
      h.sampler.onSceneCut(() => {
        throw new Error('listener failed')
      })
      const unsubscribe = h.sampler.onSceneCut(event => events.push(event))
      await h.start()
      h.env.luma = picture(100 + SCENE_CUT_DIFF)
      await h.tick()
      expect(events).toHaveLength(1)
      expect(h.status()).toBe('ok')
      expect(consoleError).toHaveBeenCalledTimes(1)
      unsubscribe()
      h.env.luma = picture(100)
      await h.tick()
      expect(events).toHaveLength(1)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('start and stop', () => {
  test('share one timer across nested starts and reset on the final stop', async () => {
    const h = setup()
    h.sampler.start()
    h.sampler.start()
    await settle()
    expect(h.activeTimers().map(timer => timer.ms)).toEqual([1000])
    expect(h.captures).toHaveLength(1)
    h.sampler.stop()
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.status()).toBe('ok')
    expect(h.sampler.keptFrames()).toHaveLength(1)
    h.sampler.stop()
    expect(h.activeTimers()).toHaveLength(0)
    expect(h.status()).toBe('off')
    expect(h.sampler.keptFrames()).toEqual([])
    expect(h.sampler.latestSample()).toBeNull()

    h.sampler.stop()
    const events: SceneCutEvent[] = []
    h.sampler.onSceneCut(event => events.push(event))
    h.env.luma = picture(100 + SCENE_CUT_DIFF)
    await h.start()
    expect(h.activeTimers()).toHaveLength(1)
    expect(h.status()).toBe('ok')
    expect(events).toEqual([])
  })

  test.each([
    ['capture', 0],
    ['encode', 1],
  ])('drop a sample whose %s finishes after the final stop', async (stage, encodes) => {
    const h = setup()
    const pending = gate()
    if (stage === 'capture') h.env.captureGate = pending.promise
    else h.env.encodeGate = pending.promise
    await h.start()
    h.sampler.stop()
    pending.open()
    await settle()
    expect(h.status()).toBe('off')
    expect(h.sampler.keptFrames()).toEqual([])
    expect(h.sampler.latestSample()).toBeNull()
    expect(h.edges).toHaveLength(encodes)
  })

  test('skip ticks while the previous sample is still running', async () => {
    const h = setup()
    const capture = gate()
    h.env.captureGate = capture.promise
    await h.start()
    await h.tick()
    await h.tick()
    expect(h.captures).toHaveLength(1)
    h.env.captureGate = null
    capture.open()
    await settle()
    expect(h.status()).toBe('ok')
    await h.tick()
    expect(h.captures).toHaveLength(2)
  })
})

describe('grabCurrentFrame', () => {
  test('is null while stopped, without reading the player', async () => {
    const h = setup()
    expect(await h.sampler.grabCurrentFrame()).toBeNull()
    await h.start()
    h.sampler.stop()
    expect(await h.sampler.grabCurrentFrame()).toBeNull()
    expect(h.captures).toHaveLength(1)
  })

  test('captures a fresh frame without touching the buffer', async () => {
    const h = setup({ maxEdge: 1024 })
    await h.start()
    h.env.now += 400
    h.env.luma = picture(150)
    expect(await h.sampler.grabCurrentFrame()).toEqual({
      at: T0 + 400,
      luma: picture(150),
      dataUrl: 'data:image/jpeg;base64,frame2',
      thumbUrl: 'data:image/jpeg;base64,thumb2',
    })
    expect(h.edges).toEqual([1024, 1024])
    expect(h.keptAt()).toEqual([0])
    expect(h.sampler.latestSample()?.luma).toEqual(picture(100))
  })

  const unavailable: [string, Partial<Env>][] = [
    ['audio-only', { audioOnly: true }],
    ['the tab is hidden', { hidden: true }],
    ['there is no video', { video: null }],
    ['the video is paused', { video: Object.assign(fakeVideo(), { paused: true }) }],
    ['the picture is blank', { luma: blank() }],
    ['capture fails', { captureError: new Error('boom') }],
    ['encoding fails', { encodeError: new Error('boom') }],
  ]

  test.each(unavailable)('is null when %s', async (_label, change) => {
    const h = setup()
    await h.start()
    Object.assign(h.env, change)
    expect(await h.sampler.grabCurrentFrame()).toBeNull()
    expect(h.logs).toEqual([])
  })

  test('is null once the stream has stalled', async () => {
    const h = setup()
    await h.start()
    h.env.playing = false
    await h.tick(3000)
    expect(h.status()).toBe('stalled')
    expect(await h.sampler.grabCurrentFrame()).toBeNull()
  })

  test('is null when the sampler stops mid-capture', async () => {
    const h = setup()
    await h.start()
    const capture = gate()
    h.env.captureGate = capture.promise
    const grabbing = h.sampler.grabCurrentFrame()
    h.sampler.stop()
    capture.open()
    expect(await grabbing).toBeNull()
  })
})

describe('page sampler', () => {
  test('stays inert while stopped and reports through visionAvailability', async () => {
    expect(mod.visionAvailability.value).toBe('off')
    expect(mod.getKeptFrames()).toEqual([])
    expect(mod.getLatestSample()).toBeNull()
    expect(await mod.grabCurrentFrame()).toBeNull()
    const unsubscribe = mod.onSceneCut(() => {})
    unsubscribe()

    mod.visionAvailability.value = 'ok'
    mod.startFrameSampler()
    mod.stopFrameSampler()
    mod.stopFrameSampler()
    await settle()
    expect(mod.visionAvailability.peek()).toBe('off')
  })
})
