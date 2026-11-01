import { beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AudioSource, AudioSourceHandlers } from '@soniox/client'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

const entry = join(import.meta.dir, '__soniox-test-entry__.ts')
const sonioxLoaderModule = join(import.meta.dir, '__soniox-test-loader__.ts')
const captureModule = join(import.meta.dir, '__soniox-test-capture__.ts')
let bundle: string
let loads = 0

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    files: {
      [entry]: `
        export { createSonioxEngine } from './soniox-engine'
        export { WEB_AUDIO_DEVICE_ID } from './page-audio'
        export { sonioxState } from './__soniox-test-loader__'
        export { captureState } from './__soniox-test-capture__'
      `,
      [sonioxLoaderModule]: `
        export const sonioxState = {
          recordOptions: null,
          micConstraints: null,
          handlers: null,
          paused: 0,
          resumed: 0,
          stopped: 0,
          canceled: 0,
        }
        class FakeMicrophoneSource {
          constructor(opts) {
            sonioxState.micConstraints = opts?.constraints ?? null
            this.kind = 'mic'
          }
        }
        class FakeSonioxClient {
          realtime = {
            record: opts => {
              sonioxState.recordOptions = opts
              if (opts.source && typeof opts.source.start === 'function') {
                void opts.source.start({
                  onData: chunk => sonioxState.onData?.(chunk),
                  onError: err => sonioxState.onError?.(err),
                })
                sonioxState.handlers = opts.source
              }
              return {
                on() {},
                async stop() {
                  sonioxState.stopped++
                  opts.source?.stop?.()
                },
                cancel() {
                  sonioxState.canceled++
                  opts.source?.stop?.()
                },
                pause() {
                  sonioxState.paused++
                  opts.source?.pause?.()
                },
                resume() {
                  sonioxState.resumed++
                  opts.source?.resume?.()
                },
                finalize() {},
              }
            },
          }
        }
        export async function loadSoniox() {
          return { SonioxClient: FakeSonioxClient, MicrophoneSource: FakeMicrophoneSource }
        }
      `,
      [captureModule]: `
        export const PCM_SAMPLE_RATE = 16000
        export const captureState = {
          starts: 0,
          stops: 0,
          lastOptions: null,
          gate: null,
          aborted: false,
        }
        export async function startPcmCapture(opts) {
          captureState.starts++
          captureState.lastOptions = opts
          opts.signal?.addEventListener('abort', () => { captureState.aborted = true }, { once: true })
          if (captureState.gate) await captureState.gate
          return { stop() { captureState.stops++ } }
        }
      `,
    },
    plugins: [
      {
        name: 'soniox-engine-test',
        setup(build) {
          build.onResolve({ filter: /\/(?:soniox|__soniox-test-loader__)$/ }, () => ({ path: sonioxLoaderModule }))
          build.onResolve({ filter: /\/(?:pcm-capture|__soniox-test-capture__)$/ }, () => ({ path: captureModule }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  bundle = await result.outputs[0].text()
})

interface SonioxHarness {
  createSonioxEngine: typeof import('./soniox-engine').createSonioxEngine
  WEB_AUDIO_DEVICE_ID: string
  sonioxState: {
    recordOptions: Record<string, unknown> | null
    micConstraints: MediaTrackConstraints | null
    handlers: AudioSource | null
    onData?: AudioSourceHandlers['onData']
    onError?: AudioSourceHandlers['onError']
    paused: number
    resumed: number
    stopped: number
    canceled: number
  }
  captureState: {
    starts: number
    stops: number
    lastOptions: PcmCaptureOptions | null
    gate: Promise<void> | null
    aborted: boolean
  }
}

async function load(): Promise<SonioxHarness> {
  return import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n//${++loads}`).toString('base64')}`)
}

function baseParams(audioDeviceId: string): SttSessionParams {
  return {
    apiKey: 'soniox-test-key',
    audioDeviceId,
    model: 'stt-rt-v4',
    languageHints: ['zh', 'en'],
  }
}

describe('createSonioxEngine', () => {
  test('uses MicrophoneSource for pinned mic IDs and default SDK mic when empty', async () => {
    const h = await load()
    const events: SttEngineEvent[] = []

    const defaultEngine = h.createSonioxEngine(baseParams(''), ev => events.push(ev))
    defaultEngine.start()
    await Promise.resolve()
    expect(h.sonioxState.recordOptions?.source).toBeUndefined()
    expect(h.sonioxState.recordOptions?.audio_format).toBeUndefined()
    expect(h.captureState.starts).toBe(0)

    const pinnedEngine = h.createSonioxEngine(baseParams('mic-usb-1'), ev => events.push(ev))
    pinnedEngine.start()
    await Promise.resolve()
    expect(h.sonioxState.micConstraints).toMatchObject({
      deviceId: { exact: 'mic-usb-1' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 16000,
    })
    expect(h.sonioxState.recordOptions?.audio_format).toBeUndefined()
  })

  test('streams 16 kHz mono pcm_s16le via custom AudioSource for WEB_AUDIO_DEVICE_ID and honors pause/resume/stop', async () => {
    const h = await load()
    const chunks: ArrayBuffer[] = []
    h.sonioxState.onData = chunk => chunks.push(chunk)

    const engine = h.createSonioxEngine(baseParams(h.WEB_AUDIO_DEVICE_ID), () => {})
    engine.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(h.sonioxState.recordOptions).toMatchObject({
      model: 'stt-rt-v4',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
    })
    expect(h.captureState.starts).toBe(1)
    expect(h.captureState.lastOptions?.deviceId).toBe(h.WEB_AUDIO_DEVICE_ID)

    const sampleA = new Int16Array([100, -200, 300])
    h.captureState.lastOptions?.onFrame(sampleA)
    expect(chunks).toHaveLength(1)
    expect(new Int16Array(chunks[0])).toEqual(sampleA)

    engine.pause()
    h.captureState.lastOptions?.onFrame(new Int16Array([999]))
    expect(chunks).toHaveLength(1)

    engine.resume()
    const sampleB = new Int16Array([400, -500])
    h.captureState.lastOptions?.onFrame(sampleB)
    expect(chunks).toHaveLength(2)
    expect(new Int16Array(chunks[1])).toEqual(sampleB)

    await engine.stop()
    expect(h.captureState.stops).toBe(1)
  })

  test('cancelling while startPcmCapture is in-flight aborts signal and stops late capture', async () => {
    const h = await load()
    let releaseGate!: () => void
    h.captureState.gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })

    const engine = h.createSonioxEngine(baseParams(h.WEB_AUDIO_DEVICE_ID), () => {})
    engine.start()
    await Promise.resolve()

    expect(h.captureState.starts).toBe(1)
    engine.cancel()
    expect(h.captureState.aborted).toBe(true)

    releaseGate()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.captureState.stops).toBe(1)
  })
})
