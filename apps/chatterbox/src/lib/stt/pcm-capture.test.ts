import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { PLAYER_VIDEO_SELECTOR } from '../player-dom'

const entry = join(import.meta.dir, '__pcm-capture-test-entry__.ts')
const logModule = join(import.meta.dir, '__pcm-capture-test-log__.ts')
let bundle: string
let loads = 0

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    files: {
      [entry]: `export * from './pcm-capture'; export { logs } from './__pcm-capture-test-log__'`,
      [logModule]: `
        export const logs = []
        export function appendLog(msg) { logs.push(msg) }
      `,
    },
    plugins: [
      {
        name: 'pcm-capture-test',
        setup(build) {
          build.onResolve({ filter: /\/(?:log|__pcm-capture-test-log__)$/ }, () => ({ path: logModule }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  bundle = await result.outputs[0].text()
})

async function loadPcmCapture() {
  return import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n//${++loads}`).toString('base64')}`) as Promise<
    typeof import('./pcm-capture') & { logs: string[] }
  >
}

describe('startPcmCapture', () => {
  const origDocument = globalThis.document
  const origAudioContext = globalThis.AudioContext
  const origAudioWorkletNode = globalThis.AudioWorkletNode
  const origNavigator = globalThis.navigator
  const origCreateObjectURL = URL.createObjectURL
  const origRevokeObjectURL = URL.revokeObjectURL

  let workletBlobs: Blob[] = []
  let createdNodeOptions: AudioWorkletNodeOptions[] = []
  let activeWorkletPort: { onmessage: ((ev: MessageEvent<Float32Array>) => void) | null } | null = null
  let addModuleError: Error | null = null
  let closedContexts = 0
  let getUserMediaCalls = 0

  beforeEach(() => {
    workletBlobs = []
    createdNodeOptions = []
    activeWorkletPort = null
    addModuleError = null
    closedContexts = 0
    getUserMediaCalls = 0

    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob) workletBlobs.push(obj)
      return 'blob:test-worklet'
    }
    URL.revokeObjectURL = () => {}

    globalThis.AudioContext = class {
      state: AudioContextState = 'suspended'
      destination = {}
      audioWorklet = {
        addModule: async () => {
          if (addModuleError) throw addModuleError
        },
      }
      createMediaStreamSource() {
        return { connect() {}, disconnect() {} }
      }
      createGain() {
        return { gain: { value: 1 }, connect() {}, disconnect() {} }
      }
      async resume() {
        this.state = 'running'
      }
      async close() {
        closedContexts++
        this.state = 'closed'
      }
    } as unknown as typeof AudioContext

    globalThis.AudioWorkletNode = class {
      port = { onmessage: null as ((ev: MessageEvent<Float32Array>) => void) | null }
      constructor(_ctx: BaseAudioContext, _name: string, options?: AudioWorkletNodeOptions) {
        if (options) createdNodeOptions.push(options)
        activeWorkletPort = this.port
      }
      connect() {}
      disconnect() {}
    } as unknown as typeof AudioWorkletNode

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            getUserMediaCalls++
            return { getTracks: () => [{ stop() {} }] }
          },
        },
      },
    })
  })

  afterEach(() => {
    globalThis.document = origDocument
    globalThis.AudioContext = origAudioContext
    globalThis.AudioWorkletNode = origAudioWorkletNode
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNavigator })
    URL.createObjectURL = origCreateObjectURL
    URL.revokeObjectURL = origRevokeObjectURL
  })

  test('configures explicit mono downmix on AudioWorkletNode and emits zero frames when disconnected', async () => {
    const { startPcmCapture } = await loadPcmCapture()
    const frames: Int16Array[] = []
    const cap = await startPcmCapture({
      deviceId: '',
      frameSamples: 256,
      onFrame: frame => frames.push(frame),
    })

    expect(getUserMediaCalls).toBe(1)
    expect(createdNodeOptions).toHaveLength(1)
    expect(createdNodeOptions[0]).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { frameSize: 256 },
    })

    // Evaluate the actual AudioWorklet script passed into `addModule()` to verify `PcmTapProcessor`.
    const workletCode = await workletBlobs[0].text()
    let RegisteredProcessor:
      | (new (opts: {
          processorOptions: { frameSize: number }
        }) => {
          port: { postMessage: (data: Float32Array) => void }
          process: (inputs: Float32Array[][]) => boolean
        })
      | null = null

    class FakeAudioWorkletProcessor {
      port = {
        postMessage: (data: Float32Array) => {
          activeWorkletPort?.onmessage?.({ data } as MessageEvent<Float32Array>)
        },
      }
    }
    const runner = new Function('AudioWorkletProcessor', 'registerProcessor', workletCode)
    runner(FakeAudioWorkletProcessor, (_name: string, ctor: typeof RegisteredProcessor) => {
      RegisteredProcessor = ctor
    })

    if (!RegisteredProcessor) throw new Error('pcm-tap processor was not registered')
    const ProcessorCtor: new (opts: {
      processorOptions: { frameSize: number }
    }) => {
      port: { postMessage: (data: Float32Array) => void }
      process: (inputs: Float32Array[][]) => boolean
    } = RegisteredProcessor
    const proc = new ProcessorCtor({ processorOptions: { frameSize: 256 } })

    // 1st quantum: 128 live samples at +0.5; 2nd quantum: disconnected source (`[[]]`) emits 128 zeros.
    const liveQuantum = new Float32Array(128).fill(0.5)
    proc.process([[liveQuantum]])
    expect(frames).toHaveLength(0)

    proc.process([[]])
    expect(frames).toHaveLength(1)
    expect(frames[0].length).toBe(256)
    expect(frames[0][0]).toBe(Math.round(0.5 * 0x7fff))
    expect(frames[0][127]).toBe(Math.round(0.5 * 0x7fff))
    expect(frames[0][128]).toBe(0)
    expect(frames[0][255]).toBe(0)

    cap.stop()
    expect(closedContexts).toBe(1)
  })

  test('captures live-player audio for WEB_AUDIO_DEVICE_ID without getUserMedia and releases tracks on failure or stop', async () => {
    const { startPcmCapture, WEB_AUDIO_DEVICE_ID } = await loadPcmCapture()
    let activeTrackStops = 0
    let trackState: MediaStreamTrackState = 'live'

    const fakeVideo = {
      tagName: 'VIDEO',
      src: 'blob:https://live.bilibili.com/live-1',
      paused: false,
      ended: false,
      readyState: 4,
      muted: false,
      volume: 1,
      isConnected: true,
      addEventListener() {},
      removeEventListener() {},
      captureStream() {
        trackState = 'live'
        const audioTrack = {
          kind: 'audio',
          get readyState() {
            return trackState
          },
          stop() {
            if (trackState === 'ended') return
            trackState = 'ended'
            activeTrackStops++
          },
          addEventListener() {},
          removeEventListener() {},
        }
        return {
          getTracks: () => [audioTrack],
          getAudioTracks: () => [audioTrack],
          getVideoTracks: () => [],
          addEventListener() {},
          removeEventListener() {},
        }
      },
    }

    globalThis.document = {
      getElementById: () => null,
      querySelector: (sel: string) => (sel === PLAYER_VIDEO_SELECTOR ? fakeVideo : null),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as Document

    // Worklet `addModule` failure must release the captured page-audio track and close AudioContext.
    addModuleError = new Error('CSP blocked blob worklet')
    await expect(startPcmCapture({ deviceId: WEB_AUDIO_DEVICE_ID, onFrame() {} })).rejects.toThrow(
      'CSP blocked blob worklet'
    )
    expect(getUserMediaCalls).toBe(0)
    expect(activeTrackStops).toBe(1)
    expect(closedContexts).toBe(1)

    // Subsequent start succeeds and cleans up idempotently on `stop()`.
    addModuleError = null
    const cap = await startPcmCapture({ deviceId: WEB_AUDIO_DEVICE_ID, onFrame() {} })
    expect(getUserMediaCalls).toBe(0)
    expect(trackState).toBe('live')

    cap.stop()
    cap.stop()
    expect(activeTrackStops).toBe(2)
    expect(closedContexts).toBe(2)
  })
})
