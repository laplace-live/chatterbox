import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { join } from 'node:path'

import type { FakeGmRequest } from '../../testing/fake-gm-transport'
import type { PcmCaptureOptions } from './pcm-capture'
import type { SttEngineEvent, SttSessionParams } from './types'

import { int16ToBase64 } from './audio'

type Engines = typeof import('./elevenlabs-translation-engine') & typeof import('./openai-translation-engine')
interface Harness extends Engines {
  requests: FakeGmRequest[]
  captureState: { options: PcmCaptureOptions | null; stops: number; gate: Promise<void> | null }
}

const entry = join(import.meta.dir, '__translation-test-entry__.ts')
const capturePath = join(import.meta.dir, '__translation-test-capture__.ts')
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `export * from './elevenlabs-translation-engine'; export * from './openai-translation-engine'; export { requests } from '$'; export { captureState } from './pcm-capture'`,
    [capturePath]: `
      export const PCM_SAMPLE_RATE = 16000;
      export const captureState = { options: null, stops: 0, gate: null };
      export async function startPcmCapture(options) {
        captureState.options = options;
        if (captureState.gate) await captureState.gate;
        return { stop() { captureState.stops++; } };
      }
    `,
  },
  plugins: [
    {
      name: 'translation-test-transports',
      setup(build) {
        build.onResolve({ filter: /^\$$/ }, () => ({
          path: join(import.meta.dir, '../../testing/fake-gm-transport.ts'),
        }))
        build.onResolve({ filter: /\/pcm-capture$/ }, () => ({ path: capturePath }))
      },
    },
  ],
  target: 'bun',
})
const bundle = await build.outputs[0].text()
let loads = 0
const load = (): Promise<Harness> =>
  import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n// ${++loads}`).toString('base64')}`)

const sockets: FakeSocket[] = []
class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  bufferedAmount = 0
  binaryType = 'blob'
  closed = 0
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    readonly url: string,
    readonly protocols?: string[]
  ) {
    sockets.push(this)
  }

  send(raw: string) {
    if (this.readyState !== 1) throw new Error('socket closed')
    this.sent.push(JSON.parse(raw))
  }

  open() {
    this.readyState = 1
    this.onopen?.()
  }

  receive(message: unknown, binary = false) {
    const json = JSON.stringify(message)
    this.onmessage?.({ data: binary ? new TextEncoder().encode(json).buffer : json })
  }

  close() {
    this.closed++
    this.readyState = 3
  }

  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}

const realWebSocket = globalThis.WebSocket
const setWebSocket = (value: unknown) =>
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value })
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
const params: SttSessionParams = {
  apiKey: 'secret-key',
  model: 'gpt-realtime-translate',
  languageHints: [],
  audioDeviceId: 'microphone',
  translation: { targetLanguage: 'zh', voiceId: 'voice-1', authorizationToken: 'Bearer enterprise-token' },
}
const chunks = (events: SttEngineEvent[]) => events.flatMap(e => (e.type === 'transcript' ? e.chunks : []))
const errors = (events: SttEngineEvent[]) => events.flatMap(e => (e.type === 'error' ? [e.error.message] : []))

async function start(provider: 'openai' | 'elevenlabs', overrides: Partial<SttSessionParams> = {}) {
  const harness = await load()
  const events: SttEngineEvent[] = []
  const factory =
    provider === 'openai' ? harness.createOpenAiTranslationEngine : harness.createElevenLabsTranslationEngine
  const engine = factory({ ...params, ...overrides }, e => events.push(e))
  engine.start()
  await tick()
  return { harness, engine, events }
}

async function ready(provider: 'openai' | 'elevenlabs') {
  const session = await start(provider)
  if (provider === 'openai') {
    session.harness.requests[0].respond(200, JSON.stringify({ value: 'ephemeral-token' }))
    await tick()
  }
  const socket = sockets[0]
  socket.open()
  socket.receive(provider === 'openai' ? { type: 'session.created' } : { message_type: 'session_started' })
  await tick()
  return { ...session, socket }
}

beforeEach(() => {
  sockets.length = 0
  setWebSocket(FakeSocket)
})
afterEach(() => jest.useRealTimers())
afterAll(() => setWebSocket(realWebSocket))

describe('OpenAI live translation', () => {
  test('mints a scoped credential, keeps the API key out of WebSocket auth, and sends 24 kHz audio', async () => {
    const { harness, engine, events } = await start('openai', { baseUrl: 'https://proxy.example/v1/' })
    const request = harness.requests[0]
    expect(request.options.url).toBe('https://proxy.example/v1/realtime/translations/client_secrets')
    expect(request.options.headers).toMatchObject({ authorization: 'Bearer secret-key' })
    expect(request.options.anonymous).toBe(true)
    expect(JSON.parse(String(request.options.data))).toEqual({
      session: {
        model: 'gpt-realtime-translate',
        audio: { input: { transcription: { model: 'gpt-realtime-whisper' } }, output: { language: 'zh' } },
      },
    })
    request.respond(200, JSON.stringify({ value: 'ephemeral-token' }))
    await tick()
    const socket = sockets[0]
    expect(socket.url).toBe('wss://proxy.example/v1/realtime/translations?model=gpt-realtime-translate')
    expect(socket.protocols).toEqual(['realtime', 'openai-insecure-api-key.ephemeral-token'])
    socket.open()
    expect(harness.captureState.options).toBeNull()
    socket.receive({ type: 'session.created' })
    await tick()
    expect(harness.captureState.options).toMatchObject({
      sampleRate: 24000,
      frameSamples: 2400,
      deviceId: 'microphone',
    })
    const frame = new Int16Array(2400).fill(50)
    harness.captureState.options?.onFrame(frame)
    expect(socket.sent).toEqual([{ type: 'session.input_audio_buffer.append', audio: int16ToBase64(frame) }])
    expect(events.some(e => e.type === 'connected')).toBe(true)
    engine.cancel()
  })

  test('keeps translated deltas separate from source and drains trailing words before finishing', async () => {
    const { socket, engine, events, harness } = await ready('openai')
    socket.receive({ type: 'session.input_transcript.delta', delta: 'Hello ' })
    socket.receive({ type: 'session.output_transcript.delta', delta: '你' }, true)
    const done = engine.stop()
    expect(socket.sent.at(-1)).toEqual({ type: 'session.close' })
    expect(harness.captureState.stops).toBe(1)
    expect(socket.closed).toBe(0)
    socket.receive({ type: 'session.output_transcript.delta', delta: '好。' })
    socket.receive({ type: 'session.closed' })
    await done
    expect(chunks(events)).toEqual([
      { text: 'Hello ', isFinal: true, kind: 'original' },
      { text: '你', isFinal: true, kind: 'translation' },
      { text: '好。', isFinal: true, kind: 'translation' },
    ])
    expect(events.filter(e => e.type === 'endpoint')).toHaveLength(1)
    expect(events.filter(e => e.type === 'finished')).toHaveLength(1)
    expect(errors(events)).toEqual([])
    expect(socket.closed).toBe(1)
  })

  test('cancels credential requests without creating a socket', async () => {
    const { harness, engine, events } = await start('openai')
    engine.cancel()
    expect(harness.requests[0].aborted).toBe(1)
    harness.requests[0].respond(200, JSON.stringify({ value: 'late' }))
    await tick()
    expect(sockets).toHaveLength(0)
    expect(errors(events)).toEqual([])
  })

  test.each([
    ['unauthorized', 401, '{}'],
    ['malformed credential', 200, '{}'],
  ] as const)('reports %s before capture starts', async (_name, status, body) => {
    const { harness, events } = await start('openai')
    harness.requests[0].respond(status, body)
    await tick()
    expect(errors(events)).toHaveLength(1)
    expect(sockets).toHaveLength(0)
    expect(harness.captureState.options).toBeNull()
  })

  test('reports provider errors without emitting success', async () => {
    const { socket, events, harness } = await ready('openai')
    socket.receive({ type: 'error', error: { message: 'language unavailable' } })
    expect(errors(events)).toEqual(['OpenAI 同传失败：language unavailable'])
    expect(events.some(e => e.type === 'finished')).toBe(false)
    expect(harness.captureState.stops).toBe(1)
  })
})

describe('ElevenLabs live translation', () => {
  test('uses the dedicated bearer token and waits for session acceptance before capture', async () => {
    const { harness, engine } = await start('elevenlabs', { languageHints: ['ja'] })
    const socket = sockets[0]
    const url = new URL(socket.url)
    expect(url.origin + url.pathname).toBe('wss://api.elevenlabs.io/v1/translation/realtime')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      authorization: 'Bearer enterprise-token',
      target_language: 'zh',
      voice_id: 'voice-1',
      input_format: 'pcm_16000',
      source_language: 'ja',
    })
    expect(socket.url).not.toContain(params.apiKey)
    socket.open()
    expect(harness.captureState.options).toBeNull()
    socket.receive({ message_type: 'session_started' })
    await tick()
    expect(harness.captureState.options).toMatchObject({ sampleRate: 16000, frameSamples: 1600 })
    const frame = new Int16Array(1600).fill(100)
    harness.captureState.options?.onFrame(frame)
    expect(socket.sent).toEqual([{ message_type: 'input_audio_chunk', audio_base_64: int16ToBase64(frame) }])
    engine.cancel()
  })

  test('emits source and translated text separately, and drains until stopped status', async () => {
    const { engine, socket, events } = await ready('elevenlabs')
    socket.receive({ message_type: 'partial_transcript', text: 'hello' })
    socket.receive({ message_type: 'final_transcript', text: 'hello world' })
    expect(events.filter(e => e.type === 'endpoint')).toHaveLength(0)
    const done = engine.stop()
    expect(socket.sent.at(-1)).toEqual({ message_type: 'end_of_stream' })
    socket.receive({ message_type: 'translation', text: '你好，世界' })
    socket.receive({ message_type: 'audio', data: 'AA==' })
    socket.receive({ message_type: 'status', status: 'stopped' })
    await done
    expect(chunks(events)).toEqual([
      { text: 'hello', isFinal: false, kind: 'original' },
      { text: 'hello world ', isFinal: true, kind: 'original' },
      { text: '你好，世界 ', isFinal: true, kind: 'translation' },
    ])
    expect(events.filter(e => e.type === 'endpoint')).toHaveLength(1)
    expect(events.filter(e => e.type === 'finished')).toHaveLength(1)
    expect(errors(events)).toEqual([])
  })

  test('requires enterprise token instead of silently treating the API key as a bearer credential', async () => {
    const { events } = await start('elevenlabs', { translation: { targetLanguage: 'en', voiceId: 'voice-1' } })
    expect(errors(events)[0]).toContain('Authorization Token')
    expect(sockets).toHaveLength(0)
  })

  test('preserves word boundaries between complete source and translated utterances', async () => {
    const { socket, engine, events } = await ready('elevenlabs')
    socket.receive({ message_type: 'final_transcript', text: 'Hello' })
    socket.receive({ message_type: 'translation', text: 'Hola' })
    socket.receive({ message_type: 'final_transcript', text: 'world ' })
    socket.receive({ message_type: 'translation', text: 'mundo ' })
    const text = (kind: 'original' | 'translation') =>
      chunks(events)
        .filter(chunk => chunk.kind === kind)
        .map(chunk => chunk.text)
        .join('')
    expect(text('original')).toBe('Hello world ')
    expect(text('translation')).toBe('Hola mundo ')
    engine.cancel()
  })

  test('stops on translation errors rather than dropping an utterance silently', async () => {
    const { socket, events, harness } = await ready('elevenlabs')
    socket.receive({ message_type: 'translation_error', error: 'translation unavailable' })
    expect(errors(events)).toEqual(['ElevenLabs translation_error: translation unavailable'])
    expect(harness.captureState.stops).toBe(1)
    expect(events.some(e => e.type === 'finished')).toBe(false)
  })
})

describe('translation lifecycle', () => {
  test.each(['openai', 'elevenlabs'] as const)('%s detects a missing final acknowledgment', async provider => {
    const { socket, engine, events } = await ready(provider)
    jest.useFakeTimers()
    const done = engine.stop()
    jest.advanceTimersByTime(9000)
    await done
    expect(errors(events)).toEqual(['同传最终结果等待超时'])
    expect(socket.closed).toBe(1)
    expect(events.some(e => e.type === 'finished')).toBe(false)
  })

  test.each(['openai', 'elevenlabs'] as const)('%s detects disconnection during drain', async provider => {
    const { socket, engine, events } = await ready(provider)
    const done = engine.stop()
    socket.drop()
    await done
    expect(errors(events)).toEqual(['同传连接在最终结果返回前关闭'])
    expect(events.some(e => e.type === 'finished')).toBe(false)
  })

  test('cancels cleanly while microphone permission is pending', async () => {
    const { engine, harness, events } = await start('elevenlabs')
    let release: () => void = () => {}
    harness.captureState.gate = new Promise(resolve => {
      release = resolve
    })
    const socket = sockets[0]
    socket.open()
    socket.receive({ message_type: 'session_started' })
    engine.cancel()
    release()
    await tick()
    expect(harness.captureState.stops).toBe(1)
    expect(events.some(e => e.type === 'connected')).toBe(false)
    expect(errors(events)).toEqual([])
  })

  test('sends silence while paused and resumes without reopening', async () => {
    const { engine, socket, harness } = await ready('elevenlabs')
    const frame = new Int16Array(1600).fill(200)
    engine.pause()
    harness.captureState.options?.onFrame(frame)
    expect(socket.sent.at(-1)?.audio_base_64).toBe(int16ToBase64(new Int16Array(1600)))
    engine.resume()
    harness.captureState.options?.onFrame(frame)
    expect(socket.sent.at(-1)?.audio_base_64).toBe(int16ToBase64(frame))
    expect(sockets).toHaveLength(1)
    engine.cancel()
  })

  test('times out a server that never accepts the session', async () => {
    const harness = await load()
    const events: SttEngineEvent[] = []
    jest.useFakeTimers()
    const engine = harness.createElevenLabsTranslationEngine(params, event => events.push(event))
    engine.start()
    await tick()
    sockets[0].open()
    jest.advanceTimersByTime(15000)
    expect(errors(events)).toEqual(['同传服务连接超时'])
    expect(harness.captureState.options).toBeNull()
  })
})
