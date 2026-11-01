import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'

import { applyAudioOnlyVolume } from '../audio-only-volume'
import { AUDIO_EL_ID, PLAYER_VIDEO_SELECTOR } from '../player-dom'
import { acquirePageAudio, bindPageAudio } from './page-audio'

class FakeEventTarget extends EventTarget {
  emit(type: string): void {
    this.dispatchEvent(new Event(type))
  }
}

class FakeTrack extends FakeEventTarget {
  readyState: MediaStreamTrackState = 'live'
  stoppedCount = 0
  readonly seq: number
  private onStopHook?: () => void

  constructor(
    readonly kind: 'audio' | 'video',
    seq: number,
    onStopHook?: () => void
  ) {
    super()
    this.seq = seq
    this.onStopHook = onStopHook
  }

  stop(): void {
    if (this.readyState === 'ended') return
    this.stoppedCount++
    this.readyState = 'ended'
    this.onStopHook?.()
  }

  endFromBrowser(): void {
    if (this.readyState === 'ended') return
    this.readyState = 'ended'
    this.emit('ended')
  }
}

class FakeMediaStream extends FakeEventTarget {
  constructor(private tracks: FakeTrack[]) {
    super()
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks]
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter(t => t.kind === 'audio')
  }

  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter(t => t.kind === 'video')
  }
}

interface FakeMediaOptions {
  tagName: 'AUDIO' | 'VIDEO'
  src?: string
  paused?: boolean
  ended?: boolean
  readyState?: number
  muted?: boolean
  volume?: number
  withCaptureStream?: boolean
  withMozCaptureStream?: boolean
  includeVideoTrack?: boolean
}

class FakeMediaElement extends FakeEventTarget {
  readonly tagName: 'AUDIO' | 'VIDEO'
  id = ''
  src: string
  paused: boolean
  ended: boolean
  readyState: number
  muted: boolean
  volume: number
  isConnected = true
  captureCalls = 0
  // Tracks whether Chromium's stop-after-recapture silencing bug would have been triggered.
  staleStopAfterRecapture = false
  mozCaptureStream?: () => FakeMediaStream
  captureStream?: () => FakeMediaStream

  private nextSeq = 0
  private latestAudioTrack: FakeTrack | null = null
  private attrs = new Set<string>()
  readonly createdStreams: FakeMediaStream[] = []

  constructor(opts: FakeMediaOptions) {
    super()
    this.tagName = opts.tagName
    this.src = opts.src ?? 'blob:https://live.bilibili.com/stream-1'
    this.paused = opts.paused ?? false
    this.ended = opts.ended ?? false
    this.readyState = opts.readyState ?? 4
    this.muted = opts.muted ?? false
    this.volume = opts.volume ?? 1

    if (opts.withMozCaptureStream) {
      this.mozCaptureStream = () => new FakeMediaStream([new FakeTrack('audio', ++this.nextSeq)])
    }
    if (opts.withCaptureStream !== false) {
      this.captureStream = () => {
        this.captureCalls++
        const seq = ++this.nextSeq
        const audioTrack = new FakeTrack('audio', seq, () => {
          if (this.latestAudioTrack && this.latestAudioTrack.seq > seq && this.latestAudioTrack.readyState === 'live') {
            this.staleStopAfterRecapture = true
          }
        })
        this.latestAudioTrack = audioTrack
        const tracks = opts.includeVideoTrack ? [audioTrack, new FakeTrack('video', seq)] : [audioTrack]
        const stream = new FakeMediaStream(tracks)
        this.createdStreams.push(stream)
        return stream
      }
    }
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.attrs.has(name)
    if (next) this.attrs.add(name)
    else this.attrs.delete(name)
    return next
  }

  dispatchMediaEvent(type: string, propagateToDocument = this.isConnected): void {
    this.emit(type)
    if (propagateToDocument) fakeDoc.emitCapture(type)
  }
}

class FakeDocument {
  body = {}
  audioEl: FakeMediaElement | null = null
  videoEl: FakeMediaElement | null = null
  private captureListeners = new Map<string, Set<EventListener>>()

  getElementById(id: string): unknown {
    if (id === AUDIO_EL_ID && this.audioEl?.isConnected) return this.audioEl
    return null
  }

  querySelector(selector: string): unknown {
    if (selector === PLAYER_VIDEO_SELECTOR && this.videoEl?.isConnected) return this.videoEl
    return null
  }

  addEventListener(type: string, listener: EventListener, capture?: boolean | AddEventListenerOptions): void {
    if (!capture) return
    let set = this.captureListeners.get(type)
    if (!set) {
      set = new Set()
      this.captureListeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: EventListener, capture?: boolean | AddEventListenerOptions): void {
    if (!capture) return
    this.captureListeners.get(type)?.delete(listener)
  }

  emitCapture(type: string): void {
    for (const listener of [...(this.captureListeners.get(type) ?? [])]) {
      listener(new Event(type))
    }
  }

  totalCaptureListeners(): number {
    let total = 0
    for (const set of this.captureListeners.values()) total += set.size
    return total
  }
}

class FakeSourceNode {
  connectedTo: unknown = null
  disconnected = false

  constructor(readonly stream: FakeMediaStream) {}

  connect(dest: unknown): void {
    this.connectedTo = dest
  }

  disconnect(): void {
    this.disconnected = true
    this.connectedTo = null
  }
}

class FakeAudioContext {
  state: AudioContextState = 'running'
  resumeCalls = 0
  readonly sources: FakeSourceNode[] = []

  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNode {
    const node = new FakeSourceNode(stream as unknown as FakeMediaStream)
    this.sources.push(node)
    return node as unknown as MediaStreamAudioSourceNode
  }

  async resume(): Promise<void> {
    this.resumeCalls++
    this.state = 'running'
  }
}

const originalDocument = globalThis.document
let fakeDoc: FakeDocument

beforeEach(() => {
  fakeDoc = new FakeDocument()
  globalThis.document = fakeDoc as unknown as Document
})

afterEach(() => {
  globalThis.document = originalDocument
})

describe('acquirePageAudio', () => {
  test('captures streaming #live-player video and immediately stops video tracks', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', includeVideoTrack: true })
    fakeDoc.videoEl = video

    const acquired = await acquirePageAudio()
    expect(acquired.el).toBe(video as unknown as HTMLMediaElement)
    expect(acquired.track.readyState).toBe('live')

    const [videoTrack] = video.createdStreams[0].getVideoTracks()
    expect(videoTrack.readyState).toBe('ended')

    acquired.release()
    expect(acquired.track.readyState).toBe('ended')
  })

  test('ignores non-streaming poster .mp4 video after stopPlayback() or off-air', async () => {
    fakeDoc.videoEl = new FakeMediaElement({
      tagName: 'VIDEO',
      src: 'https://i0.hdslb.com/bfs/live/poster.mp4',
    })

    await expect(acquirePageAudio({ startupTimeoutMs: 10 })).rejects.toThrow('未找到正在播放的直播音源')
  })

  test('rejects browsers without standard captureStream even if mozCaptureStream exists', async () => {
    fakeDoc.videoEl = new FakeMediaElement({
      tagName: 'VIDEO',
      withCaptureStream: false,
      withMozCaptureStream: true,
    })

    await expect(acquirePageAudio()).rejects.toThrow('需 Chromium 内核浏览器')
  })

  test('rejects muted or zero-volume active player immediately with browser-tab-mute guidance', async () => {
    fakeDoc.videoEl = new FakeMediaElement({ tagName: 'VIDEO', muted: true })
    await expect(acquirePageAudio()).rejects.toThrow('浏览器标签页静音')

    fakeDoc.videoEl = new FakeMediaElement({ tagName: 'VIDEO', volume: 0 })
    await expect(acquirePageAudio()).rejects.toThrow('浏览器标签页静音')
  })

  test('waits event-driven on cold start / mid-buffer and resolves as soon as playing fires', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', paused: true, readyState: 1 })
    fakeDoc.videoEl = video

    const pending = acquirePageAudio({ startupTimeoutMs: 1000 })
    setTimeout(() => {
      video.paused = false
      video.readyState = 4
      video.dispatchMediaEvent('playing')
    }, 5)

    const acquired = await pending
    expect(acquired.el).toBe(video as unknown as HTMLMediaElement)
    expect(fakeDoc.totalCaptureListeners()).toBe(0)
    acquired.release()
  })

  test('aborts immediately when signal aborts during cold-start wait', async () => {
    fakeDoc.videoEl = new FakeMediaElement({ tagName: 'VIDEO', paused: true, readyState: 1 })
    const ac = new AbortController()
    const pending = acquirePageAudio({ signal: ac.signal, startupTimeoutMs: 5000 })
    ac.abort(new Error('cancelled by user'))

    await expect(pending).rejects.toThrow('cancelled by user')
    expect(fakeDoc.totalCaptureListeners()).toBe(0)
  })

  test('waits across silent audio-only preroll instead of failing with ERR_MUTED, while still rejecting genuinely muted audio-only', async () => {
    const audio = new FakeMediaElement({ tagName: 'AUDIO', src: 'blob:https://live.bilibili.com/ao-1' })
    audio.id = AUDIO_EL_ID
    applyAudioOnlyVolume(audio, 0.8, false, true)
    fakeDoc.audioEl = audio
    fakeDoc.videoEl = new FakeMediaElement({
      tagName: 'VIDEO',
      src: 'https://i0.hdslb.com/bfs/live/poster.mp4',
      paused: true,
    })

    const pending = acquirePageAudio({ startupTimeoutMs: 1000 })
    audio.dispatchMediaEvent('playing')
    setTimeout(() => {
      applyAudioOnlyVolume(audio, 0.8, false, false)
      audio.dispatchMediaEvent('volumechange')
    }, 5)

    const acquired = await pending
    expect(acquired.el).toBe(audio as unknown as HTMLMediaElement)
    acquired.release()

    applyAudioOnlyVolume(audio, 0.8, false, true)
    await expect(acquirePageAudio({ startupTimeoutMs: 10 })).rejects.toThrow('直播音源尚未就绪或已暂停')

    applyAudioOnlyVolume(audio, 0.8, true, true)
    await expect(acquirePageAudio()).rejects.toThrow('浏览器标签页静音')
  })

  test('extends default 2s startup window up to 10s while audio-only preroll is active, but keeps 2s timeout otherwise', async () => {
    jest.useFakeTimers()
    try {
      const audio = new FakeMediaElement({ tagName: 'AUDIO', src: 'blob:https://live.bilibili.com/ao-slow' })
      audio.id = AUDIO_EL_ID
      applyAudioOnlyVolume(audio, 0.8, false, true)
      fakeDoc.audioEl = audio

      let settled = false
      const pending = acquirePageAudio().then(res => {
        settled = true
        return res
      })

      jest.advanceTimersByTime(4500)
      await Promise.resolve()
      expect(settled).toBe(false)

      applyAudioOnlyVolume(audio, 0.8, false, false)
      audio.dispatchMediaEvent('volumechange')
      const acquired = await pending
      expect(acquired.el).toBe(audio as unknown as HTMLMediaElement)
      acquired.release()

      // Without preroll, default timeout still rejects at 2000 ms.
      fakeDoc.audioEl = null
      fakeDoc.videoEl = new FakeMediaElement({ tagName: 'VIDEO', paused: true, readyState: 1 })
      const rejected = acquirePageAudio()
      jest.advanceTimersByTime(2000)
      await expect(rejected).rejects.toThrow('直播音源尚未就绪或已暂停')
    } finally {
      jest.useRealTimers()
    }
  })

  test('supersedes an un-aborted pending wait when a newer acquirePageAudio starts', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', paused: true, readyState: 1 })
    fakeDoc.videoEl = video

    const stalePending = acquirePageAudio({ startupTimeoutMs: 5000 })
    const activePending = acquirePageAudio({ startupTimeoutMs: 5000 })

    await expect(stalePending).rejects.toMatchObject({ name: 'AbortError' })

    video.paused = false
    video.readyState = 4
    video.dispatchMediaEvent('playing')

    const acquired = await activePending
    expect(acquired.track.readyState).toBe('live')
    expect(video.captureCalls).toBe(1)
    expect(fakeDoc.totalCaptureListeners()).toBe(0)
    acquired.release()
  })
})

describe('bindPageAudio', () => {
  test('skips silent prerolling <audio> (volume = 0) and hot-swaps on volumechange when audio-only engages', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', src: 'blob:https://live.bilibili.com/v1' })
    const audio = new FakeMediaElement({ tagName: 'AUDIO', src: 'blob:https://live.bilibili.com/a1', volume: 0 })
    audio.id = AUDIO_EL_ID
    fakeDoc.videoEl = video
    fakeDoc.audioEl = audio

    const initial = await acquirePageAudio()
    expect(initial.el).toBe(video as unknown as HTMLMediaElement)

    const ctx = new FakeAudioContext()
    const destination = {} as unknown as AudioNode
    const binding = bindPageAudio({
      context: ctx as unknown as AudioContext,
      destination,
      initial,
    })
    expect(ctx.sources).toHaveLength(1)
    expect(ctx.sources[0].stream).toBe(video.createdStreams[0])

    // Finish audio-only preroll: stopPlayback() reverts video to poster .mp4 and audio raises volume.
    video.src = 'https://i0.hdslb.com/bfs/live/poster.mp4'
    audio.volume = 0.8
    audio.dispatchMediaEvent('volumechange')

    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0].disconnected).toBe(true)
    expect(video.createdStreams[0].getAudioTracks()[0].readyState).toBe('ended')
    expect(ctx.sources[1].stream).toBe(audio.createdStreams[0])
    expect(ctx.sources[1].connectedTo).toBe(destination)

    binding.stop()
    expect(fakeDoc.totalCaptureListeners()).toBe(0)
    expect(audio.createdStreams[0].getAudioTracks()[0].readyState).toBe('ended')
  })

  test('switches back from <audio> to <video> when audio-only disengages and detaches <audio>', async () => {
    const audio = new FakeMediaElement({ tagName: 'AUDIO', src: 'blob:https://live.bilibili.com/a1' })
    audio.id = AUDIO_EL_ID
    const video = new FakeMediaElement({
      tagName: 'VIDEO',
      src: 'https://i0.hdslb.com/bfs/live/poster.mp4',
      paused: true,
    })
    fakeDoc.audioEl = audio
    fakeDoc.videoEl = video

    const initial = await acquirePageAudio()
    const ctx = new FakeAudioContext()
    const destination = {} as unknown as AudioNode
    const binding = bindPageAudio({
      context: ctx as unknown as AudioContext,
      destination,
      initial,
    })
    expect(ctx.sources).toHaveLength(1)

    // Native video reloads while <audio> stays live — must not switch twice during overlap.
    video.src = 'blob:https://live.bilibili.com/v2'
    video.paused = false
    video.readyState = 4
    video.dispatchMediaEvent('playing')
    expect(ctx.sources).toHaveLength(1)

    // `destroyAudioPipeline()` detaches `<audio>` synchronously before queued `pause`/`emptied` tasks fire.
    audio.paused = true
    audio.src = ''
    audio.isConnected = false
    fakeDoc.audioEl = null
    audio.dispatchMediaEvent('emptied', false)

    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0].disconnected).toBe(true)
    expect(ctx.sources[1].stream).toBe(video.createdStreams[0])
    expect(ctx.sources[1].connectedTo).toBe(destination)

    binding.stop()
  })

  test('stops prior captureStream tracks BEFORE recapturing on quality switch and across cancelled sessions', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', src: 'blob:https://live.bilibili.com/q1' })
    fakeDoc.videoEl = video

    const sessionA = await acquirePageAudio()
    const sessionB = await acquirePageAudio()
    expect(sessionA.track.readyState).toBe('ended')
    expect(sessionB.track.readyState).toBe('live')

    sessionA.release()
    expect(sessionB.track.readyState).toBe('live')
    expect(video.staleStopAfterRecapture).toBe(false)

    const staleCtx = new FakeAudioContext()
    const staleBinding = bindPageAudio({
      context: staleCtx as unknown as AudioContext,
      destination: {} as unknown as AudioNode,
      initial: sessionA,
    })
    expect(staleCtx.sources).toHaveLength(0)
    expect(sessionB.track.readyState).toBe('live')
    expect(video.captureCalls).toBe(2)
    staleBinding.stop()

    const ctx = new FakeAudioContext()
    const destination = {} as unknown as AudioNode
    const binding = bindPageAudio({
      context: ctx as unknown as AudioContext,
      destination,
      initial: sessionB,
    })

    // Quality switch on the same `<video>` swaps to a fresh MSE `blob:` URL.
    video.src = 'blob:https://live.bilibili.com/q2'
    video.dispatchMediaEvent('loadeddata')

    expect(video.captureCalls).toBe(3)
    expect(video.staleStopAfterRecapture).toBe(false)
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[1].stream).toBe(video.createdStreams[2])

    binding.stop()
    expect(video.staleStopAfterRecapture).toBe(false)
  })

  test('keeps live binding across brief pause without recapturing, and logs once on prolonged interruption + recovery', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO' })
    fakeDoc.videoEl = video

    const initial = await acquirePageAudio()
    const ctx = new FakeAudioContext()
    const logs: string[] = []
    const binding = bindPageAudio({
      context: ctx as unknown as AudioContext,
      destination: {} as unknown as AudioNode,
      initial,
      onLog: msg => logs.push(msg),
      interruptionWarnMs: 25,
    })

    video.paused = true
    video.dispatchMediaEvent('pause')
    video.paused = false
    video.dispatchMediaEvent('playing')
    await new Promise(r => setTimeout(r, 40))
    expect(video.captureCalls).toBe(1)
    expect(logs).toEqual([])

    video.muted = true
    video.dispatchMediaEvent('volumechange')
    await new Promise(r => setTimeout(r, 40))
    video.dispatchMediaEvent('volumechange')
    expect(logs).toEqual(['⚠️ 网页直播音源已静音，转录暂停输出（取消静音后将自动恢复）'])

    video.muted = false
    video.dispatchMediaEvent('volumechange')
    expect(logs).toEqual(['⚠️ 网页直播音源已静音，转录暂停输出（取消静音后将自动恢复）', '🎤 网页直播音源已自动恢复'])
    expect(video.captureCalls).toBe(1)

    binding.stop()
  })

  test('recaptures immediately if video blob src rotated between acquirePageAudio and bindPageAudio', async () => {
    const video = new FakeMediaElement({ tagName: 'VIDEO', src: 'blob:https://live.bilibili.com/s1' })
    fakeDoc.videoEl = video

    const initial = await acquirePageAudio()
    video.src = 'blob:https://live.bilibili.com/s2'

    const ctx = new FakeAudioContext()
    const destination = {} as unknown as AudioNode
    const binding = bindPageAudio({
      context: ctx as unknown as AudioContext,
      destination,
      initial,
    })

    expect(video.captureCalls).toBe(2)
    expect(video.createdStreams[0].getAudioTracks()[0].readyState).toBe('ended')
    expect(ctx.sources).toHaveLength(2)
    expect(ctx.sources[0].disconnected).toBe(true)
    expect(ctx.sources[1].stream).toBe(video.createdStreams[1])
    expect(ctx.sources[1].connectedTo).toBe(destination)

    binding.stop()
  })
})
