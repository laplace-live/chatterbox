import { afterEach, expect, mock, spyOn, test } from 'bun:test'

import type { TranscribeRequest } from './openai-compat-transcribe'

import { loadWithFakeGm } from '../../testing/fake-gm'

const segment: TranscribeRequest = {
  baseUrl: 'http://127.0.0.1:8080/v1/',
  apiKey: '',
  model: 'whisper-1',
  language: 'zh',
  samples: new Int16Array(160),
  sampleRate: 16_000,
}

afterEach(() => mock.restore())

const load = () =>
  loadWithFakeGm<typeof import('./openai-compat-transcribe')>(new URL('./openai-compat-transcribe.ts', import.meta.url))

test('uploads the segment as form data and reads the transcript', async () => {
  const stt = await load()
  const handle = stt.transcribeSegment(segment)
  const { options } = stt.requests[0]
  expect(options.url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
  expect(options.headers?.authorization).toBeUndefined()
  if (!(options.data instanceof FormData)) throw new Error('expected a FormData body')
  expect(options.data.get('model')).toBe('whisper-1')
  expect(options.data.get('language')).toBe('zh')
  expect(options.data.get('file')).toBeInstanceOf(Blob)
  stt.requests[0].respond(200, JSON.stringify({ text: '你好' }))
  expect(await handle.promise).toEqual({ ok: true, text: '你好' })
})

test('HTTP errors are retryable; transport failures mark the server unreachable', async () => {
  const stt = await load()
  const httpError = stt.transcribeSegment(segment)
  stt.requests[0].respond(500, 'model not loaded')
  expect(await httpError.promise).toEqual({ ok: false, unreachable: false, message: 'HTTP 500：model not loaded' })
  const refused = stt.transcribeSegment(segment)
  stt.requests[1].fail()
  expect(await refused.promise).toMatchObject({ ok: false, unreachable: true })
})

test('abort and timeout settle without marking the server unreachable', async () => {
  const timer = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(timer.signal)
  const stt = await load()
  const aborted = stt.transcribeSegment(segment)
  aborted.abort()
  expect(await aborted.promise).toEqual({ ok: false, unreachable: false, message: '请求已中止' })
  expect(stt.requests[0].aborted).toBe(1)
  const timedOut = stt.transcribeSegment(segment)
  timer.abort(new DOMException('timed out', 'TimeoutError'))
  expect(await timedOut.promise).toEqual({ ok: false, unreachable: false, message: '请求超时（60 秒）' })
  expect(timeout).toHaveBeenCalledWith(60_000)
})
