import { beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { FakeGmRequest } from '../../testing/fake-gm-transport'
import type { SttEngineEvent, SttSessionParams } from './types'

const entry = join(import.meta.dir, '__batch-test-entry__.ts')
const captureModule = join(import.meta.dir, '__batch-test-capture__.ts')
const segmentModule = join(import.meta.dir, '__batch-test-segments__.ts')
let bundle: string
let loads = 0

beforeAll(async () => {
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    files: {
      [entry]: `export { createOpenAiCompatEngine } from './openai-compat-engine';
        export { requests } from '$';
        export { emitSegment } from './__batch-test-segments__';
        export { captureState } from './__batch-test-capture__'`,
      [captureModule]: `
        export const PCM_SAMPLE_RATE = 16000
        export const captureState = { starts: 0, stops: 0, aborted: false, gate: null }
        export async function startPcmCapture(opts) {
          captureState.starts++
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
      [segmentModule]: `
        let emit
        export const emitSegment = () => emit(new Int16Array(160))
        export function createVadSegmenter(opts) {
          emit = opts.onSegment
          return { push() {}, flush() {} }
        }
      `,
    },
    plugins: [
      {
        name: 'batch-test',
        setup(build) {
          build.onResolve({ filter: /^\$$/ }, () => ({
            path: join(import.meta.dir, '../../testing/fake-gm-transport.ts'),
          }))
          build.onResolve({ filter: /\/(?:pcm-capture|__batch-test-capture__)$/ }, () => ({ path: captureModule }))
          build.onResolve({ filter: /\/(?:vad-segmenter|__batch-test-segments__)$/ }, () => ({ path: segmentModule }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(result.logs.join('\n'))
  bundle = await result.outputs[0].text()
})

async function load() {
  return import(`data:text/javascript;base64,${Buffer.from(`${bundle}\n//${++loads}`).toString('base64')}`) as Promise<
    typeof import('./openai-compat-engine') & {
      requests: FakeGmRequest[]
      emitSegment: () => void
      captureState: { starts: number; stops: number; aborted: boolean; gate: Promise<void> | null }
    }
  >
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function start(overrides: Partial<SttSessionParams> = {}) {
  const mod = await load()
  const events: SttEngineEvent[] = []
  const engine = mod.createOpenAiCompatEngine(
    {
      apiKey: '',
      baseUrl: 'http://localhost:8080/v1',
      model: 'whisper-1',
      audioDeviceId: '',
      languageHints: [],
      ...overrides,
    },
    event => events.push(event)
  )
  engine.start()
  await tick()
  return { ...mod, engine, events }
}

test('translation results retain request order and are marked as translated text', async () => {
  const { engine, events, requests, emitSegment } = await start({
    translation: { targetLanguage: 'en' },
    translationApi: 'openai',
  })
  emitSegment()
  emitSegment()
  expect(requests).toHaveLength(1)
  requests[0].respond(200, JSON.stringify({ text: ' First sentence.' }))
  await tick()
  expect(requests).toHaveLength(2)
  requests[1].respond(200, JSON.stringify({ text: ' Second sentence.' }))
  await tick()
  expect(events.filter(e => e.type === 'transcript')).toEqual([
    { type: 'transcript', chunks: [{ text: ' First sentence. ', isFinal: true, kind: 'translation' }] },
    { type: 'transcript', chunks: [{ text: ' Second sentence. ', isFinal: true, kind: 'translation' }] },
  ])
  expect(events.filter(e => e.type === 'endpoint')).toHaveLength(2)
  await engine.stop()
  expect(events.at(-1)).toEqual({ type: 'finished' })
})

test('transcription stays original and cancellation ignores late translated responses', async () => {
  const stt = await start()
  stt.emitSegment()
  stt.requests[0].respond(200, JSON.stringify({ text: '你好' }))
  await tick()
  expect(stt.events.at(-2)).toEqual({ type: 'transcript', chunks: [{ text: '你好', isFinal: true, kind: 'original' }] })
  stt.engine.cancel()

  const translated = await start({ translation: { targetLanguage: 'en' } })
  translated.emitSegment()
  translated.engine.cancel()
  expect(translated.requests[0].aborted).toBe(1)
  translated.requests[0].respond(200, JSON.stringify({ text: 'Hello' }))
  await tick()
  expect(translated.events.filter(e => e.type === 'transcript')).toHaveLength(0)
})

test('invalid translation target fails before microphone access', async () => {
  const { events, requests, captureState } = await start({ translation: { targetLanguage: 'zh' } })
  expect(events).toEqual([{ type: 'error', error: new Error('Whisper 仅支持翻译为英语') }])
  expect(requests).toHaveLength(0)
  expect(captureState.starts).toBe(0)
})

test('stop while startPcmCapture is pending aborts signal and finishes without emitting AbortError', async () => {
  const mod = await load()
  mod.captureState.gate = new Promise<void>(() => {})
  const events: SttEngineEvent[] = []
  const engine = mod.createOpenAiCompatEngine(
    {
      apiKey: '',
      baseUrl: 'http://localhost:8080/v1',
      model: 'whisper-1',
      audioDeviceId: '',
      languageHints: [],
    },
    event => events.push(event)
  )
  engine.start()
  await engine.stop()
  await tick()
  expect(mod.captureState.aborted).toBe(true)
  expect(events.some(e => e.type === 'error')).toBe(false)
  expect(events.at(-1)).toEqual({ type: 'finished' })
})
