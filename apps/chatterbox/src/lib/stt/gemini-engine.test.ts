import { afterAll, afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

import { int16ToBase64 } from './audio'

let onFrame: PcmCaptureOptions['onFrame'] = () => {}
let frameSamples: number | undefined
let captureStops = 0
// Holds mic startup open until resolved, like a pending permission prompt.
let captureGate: Promise<void> | null = null

mock.module('./pcm-capture', () => ({
  PCM_SAMPLE_RATE: 16000,
  startPcmCapture: async (opts: PcmCaptureOptions) => {
    onFrame = opts.onFrame
    frameSamples = opts.frameSamples
    if (captureGate) await captureGate
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
  onFrame = () => {}
  captureGate = null
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
    // The mic stays off until setup completes.
    expect(frameSamples).toBeUndefined()

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

  test('goAway between utterances swaps after the next final and replays the audio captured meanwhile', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: { timeLeft: '50s' } })
    // Not a pause: speech too new for an interim may already be on the socket.
    first.receive({ serverContent: {} })
    expect(first.sent.some(m => m.realtimeInput?.audioStreamEnd)).toBe(false)
    first.receive(final('新的一句。'))
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    onFrame(frame(1))
    jest.advanceTimersByTime(1000)
    expect(first.closed).toBe(1)

    const second = sockets[1]
    expect(second.url).toBe(LIVE_URL)
    onFrame(frame(2))
    await ready(second)
    onFrame(frame(3))
    expect(second.audio).toEqual([...LEAD_IN, b64(1), b64(2), b64(3)])
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
  })

  test('goAway mid-utterance keeps streaming until its final, then ends the stream before swapping', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('我觉得'))
    first.receive({ goAway: {} })
    onFrame(frame(1))
    expect(first.audio).toEqual([...LEAD_IN, b64(1)])
    expect(first.sent.some(m => m.realtimeInput?.audioStreamEnd)).toBe(false)

    first.receive(final('我觉得可以。'))
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '我觉得可以。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    onFrame(frame(2))
    jest.advanceTimersByTime(1000)
    expect(first.closed).toBe(1)
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(2)])
  })

  test('a text-less final still ends the utterance, clearing the interim', async () => {
    const { events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('嗯'))
    ws.receive({ serverContent: { inputTranscription: {} } })
    expect(events.slice(-2)).toEqual([{ type: 'transcript', chunks: [] }, { type: 'endpoint' }])
  })

  test('audio captured while the server closes the socket is replayed after the reconnect', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.readyState = 2 // CLOSING: onclose hasn't fired yet
    onFrame(frame(1))
    first.drop(1011)
    await ready(sockets[1])
    expect(first.audio).toEqual(LEAD_IN)
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(1)])
  })

  test('speech that resumed while the pause final was in flight is finalized before the swap', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('我觉得'))
    first.receive({ goAway: {} })
    first.receive(final('我觉得可以。'))
    first.receive(final('大家'))
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '大家', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(first.closed).toBe(1)
    expect(sockets).toHaveLength(2)
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

  test('a forced swap without a final in time keeps the last interim as final', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('嗯'))
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000)
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    jest.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '嗯', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(first.closed).toBe(1)
    expect(sockets).toHaveLength(2)
  })

  test('goAway in silence still ends the stream before the forced swap, so speech with no interim yet gets its final', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000)
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    first.receive(final('大家'))
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '大家', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(first.closed).toBe(1)
    expect(sockets).toHaveLength(2)
  })

  test('goAway in true silence swaps once the short quiet grace lapses', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000)
    onFrame(frame(1))
    jest.advanceTimersByTime(999)
    expect(sockets).toHaveLength(1)
    jest.advanceTimersByTime(1)
    expect(first.closed).toBe(1)
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(1)])
  })

  test('reconnects after an unexpected drop of a long-lived connection', async () => {
    jest.useFakeTimers()
    const { events } = start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.receive(interim('说到一半'))
    first.drop(1011, 'Internal error encountered.')
    // What the dropped connection heard is kept rather than lost with it.
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: '说到一半', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
    ])
    expect(sockets).toHaveLength(2)

    onFrame(frame(1))
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(1)])
    expect(errorMessage(events)).toBeUndefined()
  })

  test('holds a full setup window of audio while a replacement connects', async () => {
    jest.useFakeTimers()
    start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.drop(1011)
    // 17 s: a 2 s drain plus a setup that only just beats its 15 s timeout.
    for (let i = 0; i < 170; i++) onFrame(frame(1 + (i % 5)))
    await ready(sockets[1])
    expect(sockets[1].audio).toHaveLength(LEAD_IN.length + 170)
  })

  test('stop during a reconnect sends the buffered audio to the replacement before finishing', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.drop(1011)
    onFrame(frame(1))
    await engine.stop()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'stopping' })

    const second = sockets[1]
    await ready(second)
    expect(second.audio).toEqual([...LEAD_IN, b64(1)])
    expect(second.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    second.receive(final('最后的话。'))
    expect(events.slice(-4)).toEqual([
      { type: 'transcript', chunks: [{ text: '最后的话。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
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

  test('a server close during stop keeps the open interim as final', async () => {
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    ws.receive(interim('再'))
    await engine.stop()
    ws.drop(1000)
    expect(events.slice(-4)).toEqual([
      { type: 'transcript', chunks: [{ text: '再', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
  })

  test('stop with nothing open still ends the stream, finishing after the short quiet grace', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    jest.advanceTimersByTime(999)
    expect(events.at(-1)).toEqual({ type: 'state', state: 'stopping' })
    jest.advanceTimersByTime(1)
    expect(events.slice(-3)).toEqual([
      { type: 'state', state: 'stopping' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
    expect(ws.closed).toBe(1)
  })

  test('stop with nothing open finishes as soon as a final arrives', async () => {
    const { engine, events } = start()
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    ws.receive(final('大家'))
    expect(events.slice(-4)).toEqual([
      { type: 'transcript', chunks: [{ text: '大家', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
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

  test('stop during a forced swap with audio queued finishes on the replacement', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [first] = sockets
    await ready(first)
    first.receive(interim('最后'))
    first.receive({ goAway: {} })
    jest.advanceTimersByTime(20_000)
    onFrame(frame(1))
    await engine.stop()
    first.receive(final('最后一句。'))

    const second = sockets[1]
    await ready(second)
    expect(second.audio).toEqual([...LEAD_IN, b64(1)])
    expect(second.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    second.receive(final('还有一句。'))
    expect(events.slice(-4)).toEqual([
      { type: 'transcript', chunks: [{ text: '还有一句。', isFinal: true, kind: 'original' }] },
      { type: 'endpoint' },
      { type: 'state', state: 'stopped' },
      { type: 'finished' },
    ])
  })

  test('a stop stuck on a slow reconnect finishes before the tab would force-cancel it', async () => {
    jest.useFakeTimers()
    const { engine, events } = start()
    const [first] = sockets
    await ready(first)
    jest.advanceTimersByTime(60_000)
    first.drop(1011)
    onFrame(frame(1))
    await engine.stop()
    jest.advanceTimersByTime(7999)
    expect(events.at(-1)).toEqual({ type: 'state', state: 'stopping' })
    jest.advanceTimersByTime(1)
    expect(events.slice(-2)).toEqual([{ type: 'state', state: 'stopped' }, { type: 'finished' }])
    expect(sockets[1].closed).toBe(1)
  })

  test('stop or cancel while the mic is still starting releases it when it arrives', async () => {
    jest.useFakeTimers()
    let release = () => {}
    captureGate = new Promise<void>(resolve => {
      release = resolve
    })
    const stopped = start()
    await ready(sockets[0])
    await stopped.engine.stop()
    jest.advanceTimersByTime(1000)
    expect(stopped.events.at(-1)).toEqual({ type: 'finished' })
    const cancelled = start()
    await ready(sockets[1])
    cancelled.engine.cancel()
    const counts = [stopped.events.length, cancelled.events.length]

    release()
    await tick()
    expect(captureStops).toBe(2)
    expect([stopped.events.length, cancelled.events.length]).toEqual(counts)
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

describe('Gemini Live Translate', () => {
  const translationParams = {
    model: 'gemini-3.5-live-translate-preview',
    translation: { targetLanguage: 'zh-Hans' },
  }

  test('requests translated audio transcripts with the canonical setup field placement', async () => {
    const { engine } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    expect(ws.sent[0]).toEqual({
      setup: {
        model: 'models/gemini-3.5-live-translate-preview',
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: 'zh-Hans', echoTargetLanguage: true },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
    })
    onFrame(frame(4))
    expect(ws.audio.at(-1)).toBe(b64(4))
    engine.cancel()
  })

  test('keeps original and translated text separate without inserting spaces into split words', async () => {
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent: { inputTranscription: { text: 'Hello' }, outputTranscription: { text: 'Bon' } } })
    ws.receive({ serverContent: { outputTranscription: { text: 'jour le monde.' } } }, true)
    expect(events.slice(2)).toEqual([
      { type: 'transcript', chunks: [{ text: 'Hello', isFinal: true, kind: 'original' }] },
      { type: 'transcript', chunks: [{ text: 'Bon', isFinal: false, kind: 'translation' }] },
      { type: 'transcript', chunks: [{ text: 'Bonjour le monde.', isFinal: false, kind: 'translation' }] },
    ])
    ws.receive({ serverContent: { generationComplete: true } })
    expect(events.slice(-2)).toEqual([
      { type: 'transcript', chunks: [{ text: 'Bonjour le monde.', isFinal: true, kind: 'translation' }] },
      { type: 'endpoint' },
    ])
    engine.cancel()
  })

  test.each([
    ['3.', '14'],
    ['example.', 'com'],
  ])('does not flush a period inside split translated tokens: %s%s', async (first, rest) => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent: { outputTranscription: { text: first } } })
    jest.advanceTimersByTime(400)
    expect(events.filter(event => event.type === 'endpoint')).toHaveLength(0)
    ws.receive({ serverContent: { outputTranscription: { text: rest } } })
    expect(events.filter(event => event.type === 'endpoint')).toHaveLength(0)
    expect(events.filter(event => event.type === 'transcript').at(-1)).toEqual({
      type: 'transcript',
      chunks: [{ text: first + rest, isFinal: false, kind: 'translation' }],
    })
    ws.receive({ serverContent: { generationComplete: true } })
    const text = events
      .flatMap(event => (event.type === 'transcript' ? event.chunks : []))
      .filter(chunk => chunk.kind === 'translation' && chunk.isFinal)
      .map(chunk => chunk.text)
      .join('')
    expect(text).toBe(first + rest)
    engine.cancel()
  })

  test('cancellation discards an unconfirmed translated tail without a late idle flush', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent: { outputTranscription: { text: 'unfinished' } } })
    engine.cancel()
    const count = events.length
    jest.advanceTimersByTime(10000)
    expect(events).toHaveLength(count)
    expect(events.some(event => event.type === 'endpoint')).toBe(false)
  })

  test('stop waits past source transcription for delayed translated output', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    expect(ws.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    ws.receive({ serverContent: { inputTranscription: { text: 'Last words.' } } })
    jest.advanceTimersByTime(3000)
    expect(events.some(e => e.type === 'finished')).toBe(false)
    ws.receive({ serverContent: { outputTranscription: { text: '最后一句。' } } })
    ws.receive({ serverContent: { generationComplete: true } })
    expect(events.slice(-3)).toEqual([{ type: 'endpoint' }, { type: 'state', state: 'stopped' }, { type: 'finished' }])
    expect(ws.closed).toBe(1)
  })

  test('active translation remains bounded by the 28-second stop deadline', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    for (let elapsed = 4000; elapsed < 28000; elapsed += 4000) {
      jest.advanceTimersByTime(4000)
      expect(errorMessage(events)).toBeUndefined()
      ws.receive({ serverContent: { outputTranscription: { text: 'still streaming ' } } })
    }
    jest.advanceTimersByTime(3999)
    expect(errorMessage(events)).toBeUndefined()
    expect(ws.closed).toBe(0)
    ws.receive({ serverContent: { outputTranscription: { text: 'last fragment' } } })
    jest.advanceTimersByTime(1)
    expect(errorMessage(events)).toBe('等待 Gemini 同传最终结果超时')
    expect(events.some(e => e.type === 'finished')).toBe(false)
    expect(ws.closed).toBe(1)
  })

  test.each([
    { inputTranscription: { text: 'Waiting for translation' } },
    { outputTranscription: { text: 'Punctuation is not a completion marker.' } },
    { modelTurn: { parts: [{ inlineData: { data: 'AA==', mimeType: 'audio/pcm;rate=24000' } }] } },
  ])('stops a quiet continuous translation stream without requiring a turn marker', async serverContent => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent })
    await engine.stop()
    jest.advanceTimersByTime(5000)
    expect(errorMessage(events)).toBeUndefined()
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(ws.closed).toBe(1)
  })

  test('a silent translation session can finish after the idle grace', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    await ready(sockets[0])
    await engine.stop()
    jest.advanceTimersByTime(5000)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
  })

  test('an abnormal close during translation stop is a failure', async () => {
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    ws.drop(1006)
    expect(errorMessage(events)).toContain('1006')
    expect(events.some(e => e.type === 'finished')).toBe(false)
  })

  test('a normal server close completes translation stop', async () => {
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    ws.receive({ serverContent: { outputTranscription: { text: 'Final words' } } })
    ws.drop(1000)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
  })

  test('rotates a quiet translation stream without turn markers and replays buffered audio', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent: { outputTranscription: { text: 'Translation before rotation' } } })
    ws.receive({ goAway: { timeLeft: '50s' } })
    jest.advanceTimersByTime(20000)
    onFrame(frame(2))
    jest.advanceTimersByTime(5000)
    expect(errorMessage(events)).toBeUndefined()
    expect(sockets).toHaveLength(2)
    expect(ws.closed).toBe(1)
    await ready(sockets[1])
    expect(sockets[1].audio).toEqual([...LEAD_IN, b64(2)])
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
    engine.cancel()
  })

  test('stop gives an in-progress translation drain a fresh quiet period and deadline', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ goAway: { timeLeft: '50s' } })
    jest.advanceTimersByTime(24000)
    ws.receive({ serverContent: { outputTranscription: { text: 'Finishing the old stream' } } })
    jest.advanceTimersByTime(3000)
    await engine.stop()
    jest.advanceTimersByTime(1000)
    expect(errorMessage(events)).toBeUndefined()
    expect(events.some(e => e.type === 'finished')).toBe(false)
    expect(ws.closed).toBe(0)
    jest.advanceTimersByTime(3999)
    expect(ws.closed).toBe(0)
    jest.advanceTimersByTime(1)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(sockets).toHaveLength(1)
  })

  test('stop refreshes a rotation drain while preserving queued audio for its replacement', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: { timeLeft: '50s' } })
    jest.advanceTimersByTime(24000)
    first.receive({ serverContent: { outputTranscription: { text: 'Old stream' } } })
    onFrame(frame(2))
    jest.advanceTimersByTime(3000)
    await engine.stop()
    jest.advanceTimersByTime(1000)
    expect(errorMessage(events)).toBeUndefined()
    expect(first.closed).toBe(0)
    first.receive({ serverContent: { outputTranscription: { text: ' tail' }, generationComplete: true } })
    expect(sockets).toHaveLength(2)
    const second = sockets[1]
    await ready(second)
    expect(second.audio).toEqual([...LEAD_IN, b64(2)])
    expect(second.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    second.receive({ serverContent: { outputTranscription: { text: 'Queued speech' }, generationComplete: true } })
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
  })

  test.each([0, 14999])(
    'markerless stop drains both connections with replacement setup delayed by %d ms',
    async setupDelay => {
      jest.useFakeTimers()
      const { engine, events } = start(translationParams)
      const [first] = sockets
      await ready(first)
      first.receive({ goAway: { timeLeft: '50s' } })
      jest.advanceTimersByTime(20000)
      first.receive({ serverContent: { outputTranscription: { text: 'Old translation' } } })
      onFrame(frame(2))
      await engine.stop()
      jest.advanceTimersByTime(5000)
      expect(first.closed).toBe(1)
      expect(sockets).toHaveLength(2)
      const second = sockets[1]
      jest.advanceTimersByTime(setupDelay)
      expect(errorMessage(events)).toBeUndefined()
      await ready(second)
      expect(second.audio).toEqual([...LEAD_IN, b64(2)])
      expect(second.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
      jest.advanceTimersByTime(1000)
      second.receive({ serverContent: { outputTranscription: { text: 'Queued translation' } } })
      jest.advanceTimersByTime(4999)
      expect(second.closed).toBe(0)
      expect(events.some(e => e.type === 'finished')).toBe(false)
      jest.advanceTimersByTime(1)
      expect(errorMessage(events)).toBeUndefined()
      expect(events.at(-1)).toEqual({ type: 'finished' })
      expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
      const finals = events
        .flatMap(event => (event.type === 'transcript' ? event.chunks : []))
        .filter(chunk => chunk.kind === 'translation' && chunk.isFinal)
        .map(chunk => chunk.text)
      expect(finals).toEqual(['Old translation', 'Queued translation'])
    }
  )

  test('rotation without a stop keeps its existing eight-second drain bound', async () => {
    jest.useFakeTimers()
    const { events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ goAway: { timeLeft: '50s' } })
    jest.advanceTimersByTime(24000)
    ws.receive({ serverContent: { outputTranscription: { text: 'still streaming ' } } })
    jest.advanceTimersByTime(3999)
    expect(errorMessage(events)).toBeUndefined()
    ws.receive({ serverContent: { outputTranscription: { text: 'last fragment' } } })
    jest.advanceTimersByTime(1)
    expect(errorMessage(events)).toBe('等待 Gemini 同传最终结果超时')
    expect(sockets).toHaveLength(1)
  })

  test('trailing unused audio does not keep a text-only stop alive', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ serverContent: { outputTranscription: { text: 'Complete text without a turn marker' } } })
    await engine.stop()
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(999)
      ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AA==' } }] } } })
    }
    expect(ws.closed).toBe(0)
    jest.advanceTimersByTime(5)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
    expect(ws.closed).toBe(1)
    jest.advanceTimersByTime(10000)
    expect(events.filter(e => e.type === 'finished')).toHaveLength(1)
    expect(errorMessage(events)).toBeUndefined()
  })

  test('late source and translated text extend the quiet grace and are delivered before finishing', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    jest.advanceTimersByTime(2000)
    ws.receive({ serverContent: { inputTranscription: { text: 'Last words' } } })
    jest.advanceTimersByTime(500)
    ws.receive({ serverContent: { outputTranscription: { text: '最后的译文' } } })
    jest.advanceTimersByTime(4999)
    expect(ws.closed).toBe(0)
    jest.advanceTimersByTime(1)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
    expect(events.filter(e => e.type === 'transcript')).toEqual([
      { type: 'transcript', chunks: [{ text: 'Last words', isFinal: true, kind: 'original' }] },
      { type: 'transcript', chunks: [{ text: '最后的译文', isFinal: false, kind: 'translation' }] },
      { type: 'transcript', chunks: [{ text: '最后的译文', isFinal: true, kind: 'translation' }] },
    ])
  })

  test('late source text alone extends the grace while waiting for a possible translation', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    await engine.stop()
    jest.advanceTimersByTime(2000)
    ws.receive({ serverContent: { inputTranscription: { text: 'Last source fragment' } } })
    jest.advanceTimersByTime(4999)
    expect(ws.closed).toBe(0)
    jest.advanceTimersByTime(1)
    expect(events.at(-1)).toEqual({ type: 'finished' })
    expect(errorMessage(events)).toBeUndefined()
  })

  test('goAway drains translation before rotating and replays buffered source audio', async () => {
    jest.useFakeTimers()
    const { engine, events } = start(translationParams)
    const [first] = sockets
    await ready(first)
    first.receive({ goAway: { timeLeft: '50s' } })
    jest.advanceTimersByTime(20_000)
    expect(first.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    onFrame(frame(2))
    first.receive({ serverContent: { inputTranscription: { text: 'Bye' } } })
    expect(sockets).toHaveLength(1)
    first.receive({ serverContent: { outputTranscription: { text: '再见。' }, turnComplete: true } })
    expect(sockets).toHaveLength(2)
    const second = sockets[1]
    await ready(second)
    expect(second.audio).toEqual([...LEAD_IN, b64(2)])
    expect(events.filter(e => e.type === 'connected')).toHaveLength(1)
    engine.cancel()
  })

  test('reports provider errors and rejects incompatible translation configuration before connecting', async () => {
    const { events } = start(translationParams)
    const [ws] = sockets
    await ready(ws)
    ws.receive({ error: { code: 429, message: 'Translation quota exceeded' } })
    expect(errorMessage(events)).toBe('Translation quota exceeded')
    expect(ws.closed).toBe(1)
    const missing = start({ model: translationParams.model })
    expect(errorMessage(missing.events)).toContain('翻译目标语言')
    const incompatible = start({ translation: translationParams.translation })
    expect(errorMessage(incompatible.events)).toContain('仅支持转录')
    expect(sockets).toHaveLength(1)
  })
})
