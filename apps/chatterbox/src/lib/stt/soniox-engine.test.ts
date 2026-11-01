import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from 'bun:test'
import { join } from 'node:path'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

import { WEB_AUDIO_DEVICE_ID } from '../const'

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
          rejectWith: null,
        }
        export async function startPcmCapture(opts) {
          captureState.starts++
          captureState.lastOptions = opts
          if (captureState.rejectWith) throw captureState.rejectWith
          if (captureState.gate) {
            await new Promise((resolve, reject) => {
              const onAbort = () => {
                captureState.aborted = true
                reject(new DOMException('Aborted', 'AbortError'))
              }
              if (opts.signal?.aborted) {
                onAbort()
                return
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
  captureState: {
    starts: number
    stops: number
    lastOptions: PcmCaptureOptions | null
    gate: Promise<void> | null
    aborted: boolean
    rejectWith: Error | null
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
    const engine = h.createSonioxEngine(baseParams(WEB_AUDIO_DEVICE_ID, true), ev => events.push(ev))

    engine.start()
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    expect(ws?.url).toBe('wss://stt-rt.soniox.com/transcribe-websocket')
    expect(ws?.protocols).toEqual(['soniox-api-key', 'soniox-secret'])

    const preopenPcm = new Int16Array([11, -22])
    h.captureState.lastOptions?.onFrame(preopenPcm)
    expect(ws.sent).toHaveLength(0)

    ws.open()

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
    expect(ws.sent[1]).toBe(preopenPcm)
    expect(h.captureState.lastOptions?.deviceId).toBe(WEB_AUDIO_DEVICE_ID)

    const pcm = new Int16Array([120, -240, 360])
    h.captureState.lastOptions?.onFrame(pcm)
    expect(ws.sent[2]).toBe(pcm)

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

    let stopResolved = false
    const stopping = engine.stop().then(() => {
      stopResolved = true
    })
    expect(h.captureState.stops).toBe(1)
    expect(ws.sent[3]).toBe('')
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
    await Promise.resolve()
    const ws = FakeWebSocket.instances[0]
    ws.open()

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

  test('acquires audio before opening WebSocket so capture failures never emit connected and slow mic prompts do not time out', async () => {
    jest.useFakeTimers()
    const h = await load()
    h.captureState.rejectWith = new Error('直播音源当前已静音')

    const failedEvents: SttEngineEvent[] = []
    const failedEngine = h.createSonioxEngine(baseParams(WEB_AUDIO_DEVICE_ID), ev => failedEvents.push(ev))
    failedEngine.start()
    await Promise.resolve()
    await Promise.resolve()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(failedEvents).toEqual([
      { type: 'state', state: 'connecting' },
      { type: 'error', error: new Error('直播音源当前已静音') },
    ])

    h.captureState.rejectWith = null
    let releasePrompt!: () => void
    h.captureState.gate = new Promise<void>(resolve => {
      releasePrompt = resolve
    })

    const slowEvents: SttEngineEvent[] = []
    const slowEngine = h.createSonioxEngine(baseParams(''), ev => slowEvents.push(ev))
    slowEngine.start()
    jest.advanceTimersByTime(25_000)
    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(slowEvents).toEqual([{ type: 'state', state: 'connecting' }])

    releasePrompt()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].open()
    expect(slowEvents).toContainEqual({ type: 'connected' })
    slowEngine.cancel()
  })

  test('cancelling or stopping while startPcmCapture is pending aborts signal without error; reports server error frames', async () => {
    const h = await load()
    let releaseGate!: () => void
    h.captureState.gate = new Promise<void>(resolve => {
      releaseGate = resolve
    })

    const cancelEvents: SttEngineEvent[] = []
    const engine = h.createSonioxEngine(baseParams(''), ev => cancelEvents.push(ev))
    engine.start()

    engine.cancel()
    expect(h.captureState.aborted).toBe(true)
    expect(FakeWebSocket.instances).toHaveLength(0)
    releaseGate()
    await Promise.resolve()
    await Promise.resolve()
    expect(cancelEvents).toEqual([{ type: 'state', state: 'connecting' }])

    h.captureState.aborted = false
    h.captureState.gate = new Promise<void>(() => {})
    const stopEvents: SttEngineEvent[] = []
    const stopEngine = h.createSonioxEngine(baseParams(''), ev => stopEvents.push(ev))
    stopEngine.start()
    await stopEngine.stop()
    expect(h.captureState.aborted).toBe(true)
    expect(stopEvents.at(-1)).toEqual({ type: 'finished' })
    expect(stopEvents.some(ev => ev.type === 'error')).toBe(false)

    h.captureState.gate = null
    const errors: string[] = []
    const errEngine = h.createSonioxEngine(baseParams(''), ev => {
      if (ev.type === 'error') errors.push(ev.error.message)
    })
    errEngine.start()
    await Promise.resolve()
    const errWs = FakeWebSocket.instances[0]
    errWs.open()
    errWs.receive({ error_code: 401, error_message: 'Invalid API key' })
    expect(errors).toEqual(['Invalid API key'])
  })

  test('classifies pre-open error+close, unexpected 1000 close without finished, and mid-stop drop as errors', async () => {
    const h = await load()
    const run = async () => {
      const events: SttEngineEvent[] = []
      const engine = h.createSonioxEngine(baseParams(''), ev => events.push(ev))
      engine.start()
      await Promise.resolve()
      const ws = FakeWebSocket.instances.at(-1)
      if (!ws) throw new Error('expected WebSocket instance')
      return { engine, events, ws }
    }

    const handshake = await run()
    handshake.ws.onerror?.()
    handshake.ws.close(1006)
    expect(handshake.events.at(-1)).toEqual({
      type: 'error',
      error: new Error('连接失败，请检查 Soniox API Key 或网络'),
    })

    const midSession = await run()
    midSession.ws.open()
    midSession.ws.close(1000)
    expect(midSession.events.at(-1)).toEqual({
      type: 'error',
      error: new Error('Soniox 连接意外关闭'),
    })
    expect(midSession.events.some(ev => ev.type === 'finished')).toBe(false)

    const midStop = await run()
    midStop.ws.open()
    const stopping = midStop.engine.stop()
    midStop.ws.onerror?.()
    midStop.ws.close(1000)
    await stopping
    expect(midStop.events.at(-1)).toEqual({
      type: 'error',
      error: new Error('Soniox 连接在返回最终结果前关闭'),
    })
    expect(midStop.events.some(ev => ev.type === 'finished')).toBe(false)
  })
})
