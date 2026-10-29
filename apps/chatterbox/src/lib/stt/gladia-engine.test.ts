import { afterEach, beforeAll, beforeEach, expect, jest, test } from 'bun:test'
import { join } from 'node:path'

import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

const entry = join(import.meta.dir, '__gladia-test-entry__.ts')
const captureModule = join(import.meta.dir, '__gladia-test-capture__.ts')
let bundle: string
let loads = 0

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    files: {
      [entry]: `export { createGladiaEngine } from './gladia-engine'; export { captureState } from './__gladia-test-capture__'`,
      [captureModule]: `
        export const PCM_SAMPLE_RATE = 16000
        export const captureState = { starts: 0, stops: 0, onFrame: () => {}, gate: null }
        export async function startPcmCapture(opts) {
          captureState.starts++
          captureState.onFrame = opts.onFrame
          if (captureState.gate) await captureState.gate
          return { stop() { captureState.stops++ } }
        }
      `,
    },
    plugins: [
      {
        name: 'capture',
        setup(build) {
          build.onResolve({ filter: /\/(?:pcm-capture|__gladia-test-capture__)$/ }, () => ({ path: captureModule }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  bundle = await result.outputs[0].text()
})

async function load() {
  return import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n//${++loads}`).toString('base64')}`) as Promise<
    typeof import('./gladia-engine') & {
      captureState: { starts: number; stops: number; onFrame: PcmCaptureOptions['onFrame']; gate: Promise<void> | null }
    }
  >
}

const sockets: FakeSocket[] = []
class FakeSocket {
  static OPEN = 1
  readyState = 0
  sent: unknown[] = []
  closed = 0
  onopen?: () => void
  onmessage?: (event: { data: string }) => void
  onclose?: (event: { code: number }) => void
  onerror?: () => void
  constructor(readonly url: string) {
    sockets.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed++
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  drop(code = 1000) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}
const realWebSocket = globalThis.WebSocket
const realFetch = globalThis.fetch
let request: RequestInit | undefined
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

beforeEach(() => {
  sockets.length = 0
  request = undefined
  Object.defineProperty(globalThis, 'WebSocket', { value: FakeSocket, configurable: true, writable: true })
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    request = init
    return Response.json({ url: 'wss://test.invalid/session' })
  }) as typeof fetch
})
afterEach(() => {
  Object.defineProperty(globalThis, 'WebSocket', { value: realWebSocket, configurable: true, writable: true })
  globalThis.fetch = realFetch
  jest.useRealTimers()
})

async function start(overrides: Partial<SttSessionParams> = {}) {
  const mod = await load()
  const events: SttEngineEvent[] = []
  const engine = mod.createGladiaEngine(
    {
      apiKey: 'test-key',
      model: 'solaria-1',
      audioDeviceId: '',
      languageHints: ['en'],
      ...overrides,
    },
    event => events.push(event)
  )
  engine.start()
  await tick()
  return { engine, events, capture: mod.captureState }
}
const transcript = (text: string, final = true) => ({
  type: 'transcript',
  data: { id: 'u1', is_final: final, utterance: { text } },
})
const translation = (text: string, id = 'u1', language = 'zh') => ({
  type: 'translation',
  error: null,
  data: { utterance_id: id, translated_utterance: { text, language } },
})
const textEvents = (events: SttEngineEvent[]) => events.filter(e => e.type === 'transcript')

test('requests native translation and waits for translated final before endpoint', async () => {
  const { engine, events, capture } = await start({ translation: { targetLanguage: 'zh' } })
  expect(JSON.parse(request?.body as string)).toMatchObject({
    model: 'solaria-1',
    realtime_processing: { translation: true, translation_config: { target_languages: ['zh'], model: 'base' } },
    messages_config: { receive_realtime_processing_events: true },
  })
  sockets[0].open()
  await tick()
  capture.onFrame(new Int16Array(10))
  expect(sockets[0].sent).toHaveLength(1)
  sockets[0].receive(transcript('hello'))
  expect(events.filter(e => e.type === 'endpoint')).toHaveLength(0)
  sockets[0].receive(translation('你好'))
  sockets[0].receive(translation('你好'))
  sockets[0].receive(translation('bonjour', 'u2', 'fr'))
  expect(textEvents(events)).toEqual([
    { type: 'transcript', chunks: [{ text: 'hello', kind: 'original', isFinal: true }] },
    { type: 'transcript', chunks: [{ text: '你好 ', kind: 'translation', isFinal: true }] },
  ])
  expect(events.filter(e => e.type === 'endpoint')).toHaveLength(1)
  engine.cancel()
})

test('transcription-only sessions omit translation settings and retain original endpoints', async () => {
  const { engine, events } = await start()
  expect(JSON.parse(request?.body as string).realtime_processing).toBeUndefined()
  sockets[0].open()
  sockets[0].receive(transcript('hel', false))
  sockets[0].receive(transcript('hello'))
  sockets[0].receive(translation('你好'))
  expect(textEvents(events)).toHaveLength(2)
  expect(events.filter(e => e.type === 'endpoint')).toHaveLength(1)
  engine.cancel()
})

test('stop drains translation after end_recording and ignores frames after end_session', async () => {
  jest.useFakeTimers()
  const { engine, events } = await start({ translation: { targetLanguage: 'zh' } })
  const socket = sockets[0]
  socket.open()
  await tick()
  await engine.stop()
  expect(socket.sent).toContainEqual({ type: 'stop_recording' })
  socket.receive({ type: 'end_recording' })
  jest.advanceTimersByTime(2500)
  expect(socket.closed).toBe(0)
  socket.receive(translation('最后一句'))
  socket.receive({ type: 'end_session' })
  expect(events.slice(-2)).toEqual([{ type: 'state', state: 'stopped' }, { type: 'finished' }])
  const count = events.length
  socket.receive(translation('too late', 'u2'))
  jest.runAllTimers()
  expect(events).toHaveLength(count)
  expect(socket.closed).toBe(1)
})

test('translation failures and stalled stop are terminal errors with cleanup', async () => {
  jest.useFakeTimers()
  const first = await start({ translation: { targetLanguage: 'zh' } })
  sockets[0].open()
  await tick()
  sockets[0].receive({ type: 'translation', error: { message: 'Translation unavailable' }, data: null })
  expect(first.events.at(-1)).toMatchObject({ type: 'error', error: { message: 'Translation unavailable' } })
  expect(first.capture.stops).toBe(1)
  const second = await start({ translation: { targetLanguage: 'zh' } })
  sockets[1].open()
  await tick()
  await second.engine.stop()
  jest.advanceTimersByTime(8000)
  expect(second.events.at(-1)).toMatchObject({ type: 'error', error: { message: '等待 Gladia 最终结果超时' } })
  expect(second.events.some(e => e.type === 'finished')).toBe(false)
})

test('stop during pending init aborts and cannot start capture later', async () => {
  let release: (value: Response) => void = () => {}
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    request = init
    return new Promise<Response>(resolve => {
      release = resolve
    })
  }) as typeof fetch
  const { engine, events } = await start()
  await engine.stop()
  expect(request?.signal?.aborted).toBe(true)
  release(Response.json({ url: 'wss://test.invalid/session' }))
  await tick()
  expect(sockets).toHaveLength(0)
  expect(events.filter(e => e.type === 'finished')).toHaveLength(1)
})

test('stop releases a microphone acquired after the stop request', async () => {
  const { engine, capture, events } = await start()
  let release = () => {}
  capture.gate = new Promise<void>(resolve => {
    release = resolve
  })
  sockets[0].open()
  await engine.stop()
  release()
  await tick()
  expect(capture.stops).toBe(1)
  sockets[0].drop()
  expect(events.at(-1)).toEqual({ type: 'finished' })
})

test('an abnormal close while draining reports missing final output', async () => {
  const { engine, events } = await start({ translation: { targetLanguage: 'zh' } })
  sockets[0].open()
  await engine.stop()
  sockets[0].drop(1006)
  expect(events.at(-1)).toMatchObject({ type: 'error', error: { message: 'Gladia 连接意外关闭' } })
  expect(events.some(e => e.type === 'finished')).toBe(false)
})

test('startup timeout aborts a stalled session request and ignores its late response', async () => {
  jest.useFakeTimers()
  let release: (value: Response) => void = () => {}
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    request = init
    return new Promise<Response>(resolve => {
      release = resolve
    })
  }) as typeof fetch
  const { events, capture } = await start()
  jest.advanceTimersByTime(14999)
  expect(events).toEqual([])
  jest.advanceTimersByTime(1)
  expect(events).toEqual([{ type: 'error', error: new Error('Gladia 连接超时') }])
  expect(request?.signal?.aborted).toBe(true)
  release(Response.json({ url: 'wss://test.invalid/late' }))
  await tick()
  expect(sockets).toHaveLength(0)
  expect(capture.starts).toBe(0)
  expect(events).toHaveLength(1)
})

test('session creation and WebSocket opening share one startup deadline', async () => {
  jest.useFakeTimers()
  let release: (value: Response) => void = () => {}
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    request = init
    return new Promise<Response>(resolve => {
      release = resolve
    })
  }) as typeof fetch
  const { events, capture } = await start()
  jest.advanceTimersByTime(10000)
  release(Response.json({ url: 'wss://test.invalid/session' }))
  await tick()
  const socket = sockets[0]
  jest.advanceTimersByTime(4999)
  expect(socket.closed).toBe(0)
  jest.advanceTimersByTime(1)
  expect(events).toEqual([{ type: 'error', error: new Error('Gladia 连接超时') }])
  expect(socket.closed).toBe(1)
  expect(request?.signal?.aborted).toBe(true)
  socket.open()
  socket.receive(transcript('late'))
  await tick()
  expect(capture.starts).toBe(0)
  expect(events).toHaveLength(1)
})

test('a successful WebSocket opening clears the startup deadline', async () => {
  jest.useFakeTimers()
  const { engine, events, capture } = await start()
  jest.advanceTimersByTime(14999)
  sockets[0].open()
  await tick()
  jest.advanceTimersByTime(15000)
  expect(capture.starts).toBe(1)
  expect(events).toEqual([{ type: 'state', state: 'running' }, { type: 'connected' }])
  expect(sockets[0].closed).toBe(0)
  engine.cancel()
})

test('cancel while the WebSocket opens prevents late capture or timeout errors', async () => {
  jest.useFakeTimers()
  const { engine, events, capture } = await start()
  engine.cancel()
  expect(request?.signal?.aborted).toBe(true)
  sockets[0].open()
  jest.advanceTimersByTime(30000)
  await tick()
  expect(capture.starts).toBe(0)
  expect(events).toEqual([])
})
