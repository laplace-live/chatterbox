import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { WEB_AUDIO_DEVICE_ID } from '../const'
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

interface FakeGraphNode {
  connectedTo: unknown
  disconnected: boolean
  connect(target: unknown): void
  disconnect(): void
}

type TapProcessorInstance = {
  port: { postMessage: (data: Float32Array) => void }
  process: (inputs: Float32Array[][]) => boolean
}

type TapProcessorCtor = new (opts: { processorOptions: { frameSize: number } }) => TapProcessorInstance

describe('startPcmCapture', () => {
  const origDocument = globalThis.document
  const origAudioContext = globalThis.AudioContext
  const origAudioWorkletNode = globalThis.AudioWorkletNode
  const origNavigator = globalThis.navigator
  const origCreateObjectURL = URL.createObjectURL
  const origRevokeObjectURL = URL.revokeObjectURL

  let workletBlobs: Blob[] = []
  let createdNodeOptions: AudioWorkletNodeOptions[] = []
  let createdSources: Array<FakeGraphNode & { stream: unknown }> = []
  let createdGains: Array<FakeGraphNode & { gain: { value: number } }> = []
  let createdWorkletNodes: Array<
    FakeGraphNode & {
      port: { onmessage: ((ev: MessageEvent<Float32Array>) => void) | null }
      processor: TapProcessorInstance | null
    }
  > = []
  let registeredProcessorCtor: TapProcessorCtor | null = null
  let addModuleError: Error | null = null
  let contextConstructError: Error | null = null
  let lastDestination: object | null = null
  let closedContexts = 0
  let getUserMediaCalls = 0
  let micTrackStops = 0
  let getUserMediaImpl: () => Promise<{ getTracks: () => Array<{ stop: () => void }> }>

  beforeEach(() => {
    workletBlobs = []
    createdNodeOptions = []
    createdSources = []
    createdGains = []
    createdWorkletNodes = []
    registeredProcessorCtor = null
    addModuleError = null
    contextConstructError = null
    lastDestination = null
    closedContexts = 0
    getUserMediaCalls = 0
    micTrackStops = 0
    getUserMediaImpl = async () => ({
      getTracks: () => [
        {
          stop() {
            micTrackStops++
          },
        },
      ],
    })

    URL.createObjectURL = (obj: Blob | MediaSource) => {
      if (obj instanceof Blob) workletBlobs.push(obj)
      return 'blob:test-worklet'
    }
    URL.revokeObjectURL = () => {}

    globalThis.AudioContext = class {
      state: AudioContextState = 'suspended'
      destination = {}
      constructor() {
        if (contextConstructError) throw contextConstructError
        lastDestination = this.destination
      }
      audioWorklet = {
        addModule: async () => {
          if (addModuleError) throw addModuleError
          const blob = workletBlobs.at(-1)
          if (!blob) return
          const code = await blob.text()
          class FakeAudioWorkletProcessor {
            port = { postMessage: (_data: Float32Array) => {} }
          }
          const runner = new Function('AudioWorkletProcessor', 'registerProcessor', code)
          runner(FakeAudioWorkletProcessor, (_name: string, ctor: TapProcessorCtor) => {
            registeredProcessorCtor = ctor
          })
        },
      }
      createMediaStreamSource(stream: unknown) {
        const node: FakeGraphNode & { stream: unknown } = {
          stream,
          connectedTo: null,
          disconnected: false,
          connect(target) {
            this.connectedTo = target
          },
          disconnect() {
            this.disconnected = true
            this.connectedTo = null
          },
        }
        createdSources.push(node)
        return node
      }
      createGain() {
        const node: FakeGraphNode & { gain: { value: number } } = {
          gain: { value: 1 },
          connectedTo: null,
          disconnected: false,
          connect(target) {
            this.connectedTo = target
          },
          disconnect() {
            this.disconnected = true
            this.connectedTo = null
          },
        }
        createdGains.push(node)
        return node
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
      connectedTo: unknown = null
      disconnected = false
      processor: TapProcessorInstance | null = null
      constructor(_ctx: BaseAudioContext, _name: string, options?: AudioWorkletNodeOptions) {
        if (options) createdNodeOptions.push(options)
        const frameSize = Number(options?.processorOptions?.frameSize ?? 4096)
        if (registeredProcessorCtor) {
          const proc = new registeredProcessorCtor({ processorOptions: { frameSize } })
          proc.port.postMessage = (data: Float32Array) => {
            this.port.onmessage?.({ data } as MessageEvent<Float32Array>)
          }
          this.processor = proc
        }
        createdWorkletNodes.push(this)
      }
      connect(target: unknown) {
        this.connectedTo = target
      }
      disconnect() {
        this.disconnected = true
        this.connectedTo = null
      }
    } as unknown as typeof AudioWorkletNode

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => {
            getUserMediaCalls++
            return getUserMediaImpl()
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

  function pumpGraphInput(channels: Float32Array[]): void {
    const source = createdSources.at(-1)
    const worklet = createdWorkletNodes.at(-1)
    const zeroGain = createdGains.at(-1)
    if (!worklet?.processor) throw new Error('worklet processor missing')
    // Only pull audio through the worklet when the full muted graph is wired to destination.
    if (worklet.connectedTo !== zeroGain || zeroGain?.gain.value !== 0 || zeroGain.connectedTo !== lastDestination) {
      return
    }
    const activeInputs = source?.connectedTo === worklet ? [channels] : [[]]
    worklet.processor.process(activeInputs)
  }

  test('wires source → worklet → zero-gain → destination, downmixes stereo (L+R)/2, and emits zeros when disconnected', async () => {
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

    const source = createdSources[0]
    const worklet = createdWorkletNodes[0]
    const zeroGain = createdGains[0]
    expect(source?.connectedTo).toBe(worklet)
    expect(worklet?.connectedTo).toBe(zeroGain)
    expect(zeroGain?.gain.value).toBe(0)
    expect(zeroGain?.connectedTo).toBe(lastDestination)

    // Distinct L (+0.8) and R (+0.2) channels must average to +0.5 rather than dropping channel 1.
    const leftQuantum = new Float32Array(128).fill(0.8)
    const rightQuantum = new Float32Array(128).fill(0.2)
    pumpGraphInput([leftQuantum, rightQuantum])
    expect(frames).toHaveLength(0)

    source.disconnect()
    pumpGraphInput([leftQuantum, rightQuantum])
    expect(frames).toHaveLength(1)
    expect(frames[0].length).toBe(256)
    expect(frames[0][0]).toBe(Math.round(0.5 * 0x7fff))
    expect(frames[0][127]).toBe(Math.round(0.5 * 0x7fff))
    expect(frames[0][128]).toBe(0)
    expect(frames[0][255]).toBe(0)

    cap.stop()
    expect(worklet.disconnected).toBe(true)
    expect(zeroGain.disconnected).toBe(true)
    expect(micTrackStops).toBe(1)
    expect(closedContexts).toBe(1)
  })

  test('aborts pending getUserMedia immediately on signal abort and stops tracks granted afterwards', async () => {
    const { startPcmCapture } = await loadPcmCapture()
    let resolvePrompt!: (stream: { getTracks: () => Array<{ stop: () => void }> }) => void
    getUserMediaImpl = () =>
      new Promise(resolve => {
        resolvePrompt = resolve
      })

    const controller = new AbortController()
    const pending = startPcmCapture({
      deviceId: 'mic-1',
      signal: controller.signal,
      onFrame() {},
    })

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(micTrackStops).toBe(0)

    resolvePrompt({
      getTracks: () => [
        {
          stop() {
            micTrackStops++
          },
        },
      ],
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(micTrackStops).toBe(1)
  })

  test('captures live-player audio for WEB_AUDIO_DEVICE_ID without getUserMedia and releases tracks on AudioContext or worklet failure', async () => {
    const { startPcmCapture } = await loadPcmCapture()
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

    contextConstructError = new Error('AudioContext sampleRate unsupported')
    await expect(startPcmCapture({ deviceId: WEB_AUDIO_DEVICE_ID, onFrame() {} })).rejects.toThrow(
      'AudioContext sampleRate unsupported'
    )
    expect(getUserMediaCalls).toBe(0)
    expect(activeTrackStops).toBe(1)
    expect(closedContexts).toBe(0)

    contextConstructError = null
    addModuleError = new Error('CSP blocked blob worklet')
    await expect(startPcmCapture({ deviceId: WEB_AUDIO_DEVICE_ID, onFrame() {} })).rejects.toThrow(
      'CSP blocked blob worklet'
    )
    expect(getUserMediaCalls).toBe(0)
    expect(activeTrackStops).toBe(2)
    expect(closedContexts).toBe(1)

    addModuleError = null
    const cap = await startPcmCapture({ deviceId: WEB_AUDIO_DEVICE_ID, onFrame() {} })
    expect(getUserMediaCalls).toBe(0)
    expect(trackState).toBe('live')
    expect(createdSources.at(-1)?.connectedTo).toBe(createdWorkletNodes.at(-1))

    cap.stop()
    cap.stop()
    expect(activeTrackStops).toBe(3)
    expect(closedContexts).toBe(2)
  })
})
