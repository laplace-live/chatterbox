import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

import { int16ToBase64 } from './audio'

let onFrame: PcmCaptureOptions['onFrame'] = () => {}
let frameSamples: number | undefined
let captureStops = 0

mock.module('./pcm-capture', () => ({
  PCM_SAMPLE_RATE: 16000,
  startPcmCapture: async (opts: PcmCaptureOptions) => {
    onFrame = opts.onFrame
    frameSamples = opts.frameSamples
    return {
      stop: () => {
        captureStops++
      },
    }
  },
}))

const { createGeminiEngine } = await import('./gemini-engine')

interface ClientMessage {
  setup?: unknown
  realtimeInput?: { audio?: { data: string; mimeType: string }; audioStreamEnd?: boolean }
}

const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = FakeSocket.CONNECTING
  binaryType = 'blob'
  sent: ClientMessage[] = []
  closed = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(readonly url: string) {
    sockets.push(this)
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(): void {
    this.closed++
    this.readyState = FakeSocket.CLOSED
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  receive(message: object, binary = false): void {
    const json = JSON.stringify(message)
    this.onmessage?.({ data: binary ? new TextEncoder().encode(json).buffer : json })
  }

  /** Server-side close. */
  drop(code: number, reason = ''): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.({ code, reason })
  }

  get audio(): string[] {
    return this.sent.flatMap(m => (m.realtimeInput?.audio ? [m.realtimeInput.audio.data] : []))
  }
}

const realWebSocket = globalThis.WebSocket
const setGlobalWebSocket = (value: unknown) =>
  Object.defineProperty(globalThis, 'WebSocket', { value, configurable: true, writable: true })

const LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=k1'

const frame = (fill: number) => new Int16Array(1600).fill(fill)
const b64 = (fill: number) => int16ToBase64(frame(fill))
// Every connection opens with 1 s of silence.
const LEAD_IN: string[] = Array(10).fill(b64(0))
const interim = (text: string) => ({ serverContent: { interimInputTranscription: { text } } })
const final = (text: string) => ({ serverContent: { inputTranscription: { text } } })
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function start(overrides: Partial<SttSessionParams> = {}) {
  const events: SttEngineEvent[] = []
  const params: SttSessionParams = {
    apiKey: 'k1',
    model: 'gemini-3.5-transcribe-live',
    languageHints: [],
    audioDeviceId: '',
    ...overrides,
  }
  const engine = createGeminiEngine(params, event => events.push(event))
  engine.start()
  return { engine, events }
}

async function ready(socket: FakeSocket): Promise<void> {
  socket.open()
  socket.receive({ setupComplete: {} })
  await tick()
}

function errorMessage(events: SttEngineEvent[]): string | undefined {
  const event = events.find(e => e.type === 'error')
  return event?.type === 'error' ? event.error.message : undefined
}

beforeEach(() => {
  sockets.length = 0
  captureStops = 0
  frameSamples = undefined
  setGlobalWebSocket(FakeSocket)
})

afterEach(() => {
  jest.useRealTimers()
})

afterAll(() => {
  setGlobalWebSocket(realWebSocket)
})

describe('createGeminiEngine', () => {
  test('sends setup on open and streams 100 ms audio frames only after setupComplete', async () => {
    const { events } = start({ languageHints: ['cmn-Hans-CN'] })
    const [ws] = sockets
    expect(ws.url).toBe(LIVE_URL)
    expect(ws.binaryType).toBe('arraybuffer')

    ws.open()
    expect(ws.sent).toEqual([
      {
        setup: {
          model: 'models/gemini-3.5-transcribe-live',
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: { languageCodes: ['cmn-Hans-CN'] },
        },
      },
    ])
    expect(events).toEqual([])

    ws.receive({ setupComplete: {} })
    await tick()
    expect(events).toEqual([{ type: 'state', state: 'running' }, { type: 'connected' }])
    expect(frameSamples).toBe(1600)
    onFrame(frame(1))
    expect(ws.audio).toEqual([...LEAD_IN, b64(1)])
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audio: { data: b64(1), mimeType: 'audio/pcm;rate=16000' } } })
  })

  test('accepts a typed model id with or without the models/ prefix, and falls back when empty', () => {
    for (const model of ['gemini-4-transcribe-live', 'models/gemini-4-transcribe-live', '']) {
      start({ model })
      const ws = sockets[sockets.length - 1]
      ws.open()
      expect(ws.sent[0]).toMatchObject({
        setup: { model: model ? 'models/gemini-4-transcribe-live' : 'models/gemini-3.5-transcribe-live' },
      })
    }
  })

  test('maps interim and final transcriptions from text and binary frames', async () => {
    const { events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('你好'))
    ws.receive(final('你好世界。'), true)
    expect(events.slice(2)).toEqual([
      { type: 'transcript', chunks: [{ text: '你好', isFinal: false, kind: 'original' }] },
      { type: 'transcript', chunks: [{ text: '你好世界。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
  })

  test('goAway between utterances swaps connections and replays the audio captured meanwhile', async () => {
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: { timeLeft: '50s' } })
    expect(first.closed).toBe(1)

    const second = sockets[1]
    expect(second.url).toBe(LIVE_URL)
    onFrame(frame(1))
    onFrame(frame(2))
    await ready(second)
    onFrame(frame(3))
    expect(second.audio).toEqual([...LEAD_IN, b64(1), b64(2), b64(3)])
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
  })

  test('goAway mid-utterance keeps streaming and swaps at the next pause', async () => {
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('我觉得'))
    first.receive({ goAway: {} })
    onFrame(frame(1))
    expect(first.audio).toEqual([...LEAD_IN, b64(1)])
    expect(sockets).toHaveLength(1)

    first.receive(final('我觉得可以。'))
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '我觉得可以。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(first.closed).toBe(1)
    expect(first.sent.some(m => m.realtimeInput?.audioStreamEnd)).toBe(false)
    onFrame(frame(2))
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(2)])
  })

  test('without a pause in 20 s, ends the stream and swaps once the final lands', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('一直说'))
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(19_999)
    expect(first.sent.some(m => m.realtimeInput?.audioStreamEnd)).toBe(false)
    jest.advanceTimersByTime(1)
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })

    onFrame(frame(1))
    expect(first.audio).toEqual(LEAD_IN)
    first.receive(final('一直说个不停。'))
    expect(first.closed).toBe(1)
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(1)])
  })

  test('a forced swap goes ahead without a final once the grace period lapses', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('嗯'))
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000 + 1999)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(first.closed).toBe(1)
    expect(sockets).toHaveLength(2)
  })

  test('reconnects after an unexpected drop of a long-lived connection', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.drop(1011, 'Internal error encountered.')
    expect(sockets).toHaveLength(2)

    onFrame(frame(1))
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(1)])
    expect(errorMessage(events)).toBeUndefined()
  })

  test('a drop while a swap waits for a pause reconnects once', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.receive(interim('还没说完'))
    first.receive({ goAway: {} })
    first.drop(1000)
    expect(sockets).toHaveLength(2)
    await ready(sockets[1])
    jest.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(2)
    expect(sockets[1].closed).toBe(0)
  })

  test('reports a close before setup, or soon after it, as an error', async () => {
    const rejected = start()
    sockets[0].open()
    sockets[0].drop(1008, 'API key not valid. Please pass a valid API key.')
    expect(errorMessage(rejected.events)).toBe('连接已关闭（1008）：API key not valid. Please pass a valid API key.')

    const unreachable = start()
    sockets[1].drop(1006)
    expect(errorMessage(unreachable.events)).toBe('连接失败，请检查网络或接口地址')

    const flaky = start()
    await ready(sockets[2])
    sockets[2].drop(1011)
    expect(errorMessage(flaky.events)).toBe('连接已关闭（1011）')
    expect(sockets).toHaveLength(3)
  })

  test('fails a connection that never completes setup', () => {
    jest.useFakeTimers()
    const { events } = start()
    sockets[0].open()
    jest.advanceTimersByTime(15_000)
    expect(errorMessage(events)).toBe('连接超时：服务器未响应')
    expect(sockets[0].closed).toBe(1)
  })

  test('fails fast on an unusable API address', () => {
    const { events } = start({ baseUrl: 'ftp://example.com' })
    expect(sockets).toHaveLength(0)
    expect(errorMessage(events)).toBe('接口地址须以 https:// 或 http:// 开头')
  })

  test('stop finalizes the open utterance before finishing', async () => {
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('再见'))
    await engine.stop()
    expect(captureStops).toBe(1)
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    expect(events.at(-1)).toEqual({ type: 'state', state: 'stopping' })

    ws.receive(final('再见。'))
    expect(events.slice(-4)).toEqual([
      { type: 'transcript', chunks: [{ text: '再见。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
    expect(ws.closed).toBe(1)
  })

  test('stop with nothing pending finishes at once', async () => {
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    expect(events.slice(-3)).toEqual([
      { type: 'state', state: 'stopping' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
    expect(ws.closed).toBe(1)
  })

  test('stop while a swap waits for a pause finishes instead of reconnecting', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('最后'))
    ws.receive({ goAway: {} })
    await engine.stop()
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    ws.receive(final('最后一句。'))
    expect(events.at(-1)).toEqual({ type: 'finished' })
    jest.advanceTimersByTime(30_000)
    expect(sockets).toHaveLength(1)
  })

  test('stop during a forced swap finishes on the final instead of reconnecting', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('最后'))
    ws.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000)
    await engine.stop()
    ws.receive(final('最后一句。'))
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(sockets).toHaveLength(1)
  })

  test('cancel releases everything and goes quiet', async () => {
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    const before = events.length
    engine.cancel()
    expect(ws.closed).toBe(1)
    expect(captureStops).toBe(1)
    ws.receive(final('迟到的结果'))
    ws.drop(1000)
    expect(events).toHaveLength(before)
  })

  test('cancel while a swap waits for a pause opens no new connection later', async () => {
    jest.useFakeTimers()
    const { engine } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('等一下'))
    ws.receive({ goAway: {} })
    engine.cancel()
    jest.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })
})
