import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

import { WEB_AUDIO_DEVICE_ID } from '../const'

const entry = join(import.meta.dir, '__raw-ws-test-entry__.ts')
const captureModule = join(import.meta.dir, '__raw-ws-test-capture__.ts')
let bundle: string
let loads = 0

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    files: {
      [entry]: `
        export { createDeepgramEngine } from './deepgram-engine'
        export { createElevenLabsEngine } from './elevenlabs-engine'
        export { captureState } from './__raw-ws-test-capture__'
      `,
      [captureModule]: `
        export const PCM_SAMPLE_RATE = 16000
        export const captureState = {
          starts: 0,
          stops: 0,
          aborted: false,
          lastOptions: null,
          gate: null,
        }
        export async function startPcmCapture(opts) {
          captureState.starts++
          captureState.lastOptions = opts
          if (captureState.gate) {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                captureState.aborted = true
                reject(new DOMException('Aborted', 'AbortError'))
              }
              opts.signal?.addEventListener('abort', onAbort, { once: true })
              captureState.gate.then(() => {
                opts.signal?.removeEventListener('abort', onAbort)
                resolve()
              }, reject)
            })
          }
          return { stop() { captureState.stops++ } }
        }
      `,
    },
    plugins: [
      {
        name: 'raw-ws-engines-test',
        setup(build) {
          build.onResolve({ filter: /\/(?:pcm-capture|__raw-ws-test-capture__)$/ }, () => ({ path: captureModule }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  bundle = await result.outputs[0].text()
})

interface RawWsHarness {
  createDeepgramEngine: typeof import('./deepgram-engine').createDeepgramEngine
  createElevenLabsEngine: typeof import('./elevenlabs-engine').createElevenLabsEngine
  captureState: {
    starts: number
    stops: number
    aborted: boolean
    lastOptions: PcmCaptureOptions | null
    gate: Promise<void> | null
  }
}

async function load(): Promise<RawWsHarness> {
  return import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n//${++loads}`).toString('base64')}`)
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  deferClose = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string | string[]
  ) {
    FakeWebSocket.instances.push(this)
  }

  send(): void {}

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  close(code = 1000): void {
    if (this.deferClose) {
      this.readyState = FakeWebSocket.CLOSING
      return
    }
    this.finishClose(code)
  }

  finishClose(code = 1000): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }
}

const origWebSocket = globalThis.WebSocket
const origFetch = globalThis.fetch

beforeEach(() => {
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.fetch = (async () => Response.json({ token: 'el-token' })) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.WebSocket = origWebSocket
  globalThis.fetch = origFetch
})

const params: SttSessionParams = {
  apiKey: 'secret',
  model: '',
  audioDeviceId: WEB_AUDIO_DEVICE_ID,
  languageHints: ['zh'],
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe('Deepgram and ElevenLabs capture abort propagation', () => {
  test.each(['deepgram', 'elevenlabs'] as const)(
    '%s aborts pending startPcmCapture on stop without emitting AbortError while socket closes',
    async provider => {
      const h = await load()
      h.captureState.gate = new Promise<void>(() => {})
      const events: SttEngineEvent[] = []
      const engine =
        provider === 'deepgram'
          ? h.createDeepgramEngine(params, ev => events.push(ev))
          : h.createElevenLabsEngine(params, ev => events.push(ev))

      engine.start()
      await tick()
      const ws = FakeWebSocket.instances[0]
      ws.deferClose = true
      ws.open()
      expect(h.captureState.starts).toBe(1)

      await engine.stop()
      await tick()
      expect(h.captureState.aborted).toBe(true)
      expect(events.some(ev => ev.type === 'error')).toBe(false)

      ws.finishClose(1000)
      expect(events.at(-1)).toEqual({ type: 'finished' })
      expect(events.some(ev => ev.type === 'error')).toBe(false)
    }
  )

  test.each(['deepgram', 'elevenlabs'] as const)('%s aborts pending startPcmCapture on cancel', async provider => {
    const h = await load()
    h.captureState.gate = new Promise<void>(() => {})
    const events: SttEngineEvent[] = []
    const engine =
      provider === 'deepgram'
        ? h.createDeepgramEngine(params, ev => events.push(ev))
        : h.createElevenLabsEngine(params, ev => events.push(ev))

    engine.start()
    await tick()
    FakeWebSocket.instances[0].open()
    engine.cancel()
    await tick()
    expect(h.captureState.aborted).toBe(true)
    expect(events.some(ev => ev.type === 'error')).toBe(false)
  })

  test.each(['deepgram', 'elevenlabs'] as const)(
    '%s finishes cleanly without handshake error when stopped before socket opens',
    async provider => {
      const h = await load()
      const events: SttEngineEvent[] = []
      const engine =
        provider === 'deepgram'
          ? h.createDeepgramEngine(params, ev => events.push(ev))
          : h.createElevenLabsEngine(params, ev => events.push(ev))

      engine.start()
      await tick()
      await engine.stop()
      expect(events.at(-1)).toEqual({ type: 'finished' })
      expect(events.some(ev => ev.type === 'error')).toBe(false)
    }
  )
})
