import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { join } from 'node:path'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

const entry = join(import.meta.dir, '__soniox-test-entry__.ts')
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
        export { captureState } from './__soniox-test-capture__'
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

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  sent: Array<string | Int16Array> = []
  closed = false
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

  send(data: string | Int16Array): void {
    this.sent.push(data)
  }

  close(code = 1000): void {
    if (this.closed) return
    this.closed = true
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) })
  }
}

const origWebSocket = globalThis.WebSocket

beforeEach(() => {
  FakeWebSocket.instances = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
})

afterEach(() => {
  jest.useRealTimers()
  globalThis.WebSocket = origWebSocket
})

function baseParams(audioDeviceId = '', withTranslation = false): SttSessionParams {
  return {
    apiKey: 'soniox-secret',
    audioDeviceId,
    model: 'stt-rt-v5',
    languageHints: ['zh', 'en'],
    ...(withTranslation ? { translation: { targetLanguage: 'ja' } } : {}),
  }
}

describe('createSonioxEngine (raw WebSocket + unified startPcmCapture)', () => {
  test('authenticates via subprotocol, sends pcm_s16le config, streams PCM frames for any deviceId, and drains on stop', async () => {
    const h = await load()
    const events: SttEngineEvent[] = []
    const engine = h.createSonioxEngine(baseParams(h.WEB_AUDIO_DEVICE_ID, true), ev => events.push(ev))

    engine.start()
    const ws = FakeWebSocket.instances[0]
    expect(ws?.url).toBe('wss://stt-rt.soniox.com/transcribe-websocket')
    expect(ws?.protocols).toEqual(['soniox-api-key', 'soniox-secret'])

    ws.open()
    await Promise.resolve()

    expect(JSON.parse(String(ws.sent[0]))).toEqual({
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['zh', 'en'],
      enable_endpoint_detection: true,
      endpoint_latency_adjustment_level: 1,
      translation: { type: 'one_way', target_language: 'ja' },
    })
    expect(h.captureState.lastOptions?.deviceId).toBe(h.WEB_AUDIO_DEVICE_ID)

    const pcm = new Int16Array([120, -240, 360])
    h.captureState.lastOptions?.onFrame(pcm)
    expect(ws.sent[1]).toBe(pcm)

    // Server returns tokens + `<end>` endpoint marker; `<end>` must be stripped from transcript chunks.
    ws.receive({
      tokens: [
        { text: '你好', is_final: true, translation_status: 'original' },
        { text: 'こんにちは', is_final: true, translation_status: 'translation' },
        { text: '<end>', is_final: true },
      ],
    })
    expect(events).toContainEqual({
      type: 'transcript',
      chunks: [
        { text: '你好', isFinal: true, kind: 'original' },
        { text: 'こんにちは', isFinal: true, kind: 'translation' },
      ],
    })
    expect(events).toContainEqual({ type: 'endpoint' })

    // Graceful stop sends `""` EOF and waits for `{ finished: true }` before resolving.
    let stopResolved = false
    const stopping = engine.stop().then(() => {
      stopResolved = true
    })
    expect(h.captureState.stops).toBe(1)
    expect(ws.sent[2]).toBe('')
    expect(stopResolved).toBe(false)

    ws.receive({
      tokens: [{ text: '尾句', is_final: true }],
      finished: true,
    })
    await stopping
    expect(stopResolved).toBe(true)
    expect(events.at(-1)).toEqual({ type: 'finished' })
  })

  test('pause finalizes and sends periodic keepalives while suppressing audio; finalize sends trailing_silence_ms', async () => {
    jest.useFakeTimers()
    const h = await load()
    const engine = h.createSonioxEngine(baseParams('mic-1'), () => {})

    engine.start()
    const ws = FakeWebSocket.instances[0]
    ws.open()
    await Promise.resolve()

    engine.finalize({ trailingSilenceMs: 400 })
    expect(JSON.parse(String(ws.sent[1]))).toEqual({ type: 'finalize', trailing_silence_ms: 400 })

    engine.pause()
    expect(JSON.parse(String(ws.sent[2]))).toEqual({ type: 'finalize' })

    h.captureState.lastOptions?.onFrame(new Int16Array([42]))
    expect(ws.sent).toHaveLength(3)

    jest.advanceTimersByTime(5000)
    expect(JSON.parse(String(ws.sent[3]))).toEqual({ type: 'keepalive' })

    engine.resume()
    jest.advanceTimersByTime(10_000)
    expect(ws.sent).toHaveLength(4)

    const resumedFrame = new Int16Array([77])
    h.captureState.lastOptions?.onFrame(resumedFrame)
    expect(ws.sent[4]).toBe(resumedFrame)

    engine.cancel()
  })

  test('cancelling while startPcmCapture is pending aborts signal and stops late capture; reports server error frames', async () => {
    const h = await load()
    let releaseGate!: () => void
    h.captureState.gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })

    const engine = h.createSonioxEngine(baseParams(''), () => {})
    engine.start()
    FakeWebSocket.instances[0].open()
    await Promise.resolve()

    engine.cancel()
    expect(h.captureState.aborted).toBe(true)
    releaseGate()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.captureState.stops).toBe(1)

    // Separate session surfaces Soniox server-side `error_message`.
    h.captureState.gate = null
    const errors: string[] = []
    const errEngine = h.createSonioxEngine(baseParams(''), ev => {
      if (ev.type === 'error') errors.push(ev.error.message)
    })
    errEngine.start()
    const errWs = FakeWebSocket.instances[1]
    errWs.open()
    errWs.receive({ error_code: 401, error_message: 'Invalid API key' })
    expect(errors).toEqual(['Invalid API key'])
  })
})
