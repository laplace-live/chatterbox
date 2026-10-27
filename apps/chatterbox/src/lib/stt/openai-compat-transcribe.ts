/**
 * One-shot upload to an OpenAI-compatible `/audio/transcriptions` endpoint.
 * Goes through `gmFetch` because a plain `fetch` at a local server is
 * blocked three ways over: mixed content, CORS, and Private Network Access.
 */

import { gmFetch, ManagerAbortError } from '../gm-fetch'
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
  /** ISO code; omitted when empty — OpenAI/Groq then auto-detect, whisper.cpp falls back to its server-side default. */
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

  const controller = new AbortController()
  const send = async (): Promise<TranscribeResult> => {
    let response: Response
    try {
      response = await gmFetch(`${req.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        // Self-hosted endpoints may sit behind cookie-based auth (e.g. an SSO proxy).
        credentials: 'include',
        signal: controller.signal,
        timeout: REQUEST_TIMEOUT_MS,
      })
    } catch (err) {
      if (controller.signal.aborted || err instanceof ManagerAbortError) {
        return { ok: false, unreachable: false, message: '请求已中止' }
      }
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        return { ok: false, unreachable: false, message: `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）` }
      }
      // HTTP statuses resolve; a rejection is transport-level — nothing listening, wrong port.
      return { ok: false, unreachable: true, message: '无法连接到语音识别服务，请检查服务地址与服务是否已启动' }
    }
    const raw = await response.text()
    if (!response.ok) {
      const detail = raw ? `：${raw.slice(0, 200)}` : ''
      return { ok: false, unreachable: false, message: `HTTP ${response.status}${detail}` }
    }
    const text = readTranscript(raw)
    if (text === undefined) return { ok: false, unreachable: false, message: '返回内容不是合法的 { text } JSON' }
    return { ok: true, text }
  }
  return { promise: send(), abort: () => controller.abort() }
}
