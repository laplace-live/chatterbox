/**
 * One-shot upload to an OpenAI-compatible `/audio/transcriptions` endpoint.
 * Goes through `GM_xmlhttpRequest` because a plain `fetch` at a local server is
 * blocked three ways over: mixed content, CORS, and Private Network Access.
 */

import { GM_xmlhttpRequest } from '$'
import { readStringField } from './normalize'
import { encodeWav } from './wav'

/** Generous — CPU-only Whisper on a 15 s segment is slow — but bounded so a hung request can't wedge the queue. */
const REQUEST_TIMEOUT_MS = 60_000

export interface TranscribeRequest {
  /** API root, e.g. `http://127.0.0.1:8080/v1`; trailing slashes are tolerated. */
  baseUrl: string
  /** Empty for local servers that need no auth. */
  apiKey: string
  model: string
  /** ISO code; omitted from the request when empty (server auto-detects). */
  language: string
  samples: Int16Array
  sampleRate: number
}

export type TranscribeResult = { ok: true; text: string } | { ok: false; unreachable: boolean; message: string }

export interface TranscribeHandle {
  /** Never rejects — transport, HTTP, and abort outcomes all come back as `ok: false`. */
  promise: Promise<TranscribeResult>
  /** Abort the in-flight request (session cancel / drain timeout); the server may still finish, the result is dropped. */
  abort: () => void
}

function readTranscript(raw: string): string | undefined {
  try {
    return readStringField(JSON.parse(raw), 'text')
  } catch {
    return undefined
  }
}

export function transcribeSegment(req: TranscribeRequest): TranscribeHandle {
  const form = new FormData()
  form.append('file', new Blob([encodeWav(req.samples, req.sampleRate)], { type: 'audio/wav' }), 'segment.wav')
  form.append('model', req.model)
  form.append('response_format', 'json')
  form.append('temperature', '0')
  if (req.language) form.append('language', req.language)

  // No Content-Type header: the boundary is generated with the body, so setting it by hand corrupts the request.
  const headers: Record<string, string> = {}
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`

  let request: { abort: () => void } | null = null
  const promise = new Promise<TranscribeResult>(resolve => {
    request = GM_xmlhttpRequest({
      method: 'POST',
      url: `${req.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
      headers,
      data: form,
      timeout: REQUEST_TIMEOUT_MS,
      onload: response => {
        if (response.status < 200 || response.status >= 300) {
          const detail = response.responseText ? `：${response.responseText.slice(0, 200)}` : ''
          resolve({ ok: false, unreachable: false, message: `HTTP ${response.status}${detail}` })
          return
        }
        const text = readTranscript(response.responseText)
        if (text === undefined) {
          resolve({ ok: false, unreachable: false, message: '返回内容不是合法的 { text } JSON' })
          return
        }
        resolve({ ok: true, text })
      },
      // HTTP statuses arrive via onload; onerror is transport-level — nothing listening, wrong port.
      onerror: () =>
        resolve({ ok: false, unreachable: true, message: '无法连接到语音识别服务，请检查服务地址与服务是否已启动' }),
      onabort: () => resolve({ ok: false, unreachable: false, message: '请求已中止' }),
      ontimeout: () =>
        resolve({ ok: false, unreachable: false, message: `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` }),
    })
  })
  return { promise, abort: () => request?.abort() }
}
