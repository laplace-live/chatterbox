/**
 * Opens a Gladia realtime live session and returns its one-shot WebSocket URL.
 *
 * Key rides the `x-gladia-key` header (browsers can't set it on a WebSocket);
 * the response `url` carries a per-session token so the key never hits the
 * socket. Plain cross-origin `fetch` works — Gladia sends permissive CORS, no
 * `GM_xmlhttpRequest` / `@connect` needed.
 */

import { GLADIA_API_BASE } from '../const'
import { isGladiaLiveResponse } from './normalize'
import { PCM_SAMPLE_RATE } from './pcm-capture'

// 0.3 s trailing silence ends an utterance ≈ one danmaku; Gladia's 0.05 s default fragments too much.
const ENDPOINTING_SECONDS = 0.3

export interface GladiaSessionConfig {
  apiKey: string
  model: string
  /** BCP-47 language hints; `[]` = auto-detect. A single entry locks the language. */
  languages: string[]
}

export async function initGladiaSession(config: GladiaSessionConfig): Promise<string> {
  const key = config.apiKey.trim()
  if (!key) throw new Error('请填写 Gladia API Key')

  let res: Response
  try {
    res = await fetch(`${GLADIA_API_BASE}/live`, {
      method: 'POST',
      headers: { 'x-gladia-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        encoding: 'wav/pcm',
        sample_rate: PCM_SAMPLE_RATE,
        bit_depth: 16,
        channels: 1,
        model: config.model,
        endpointing: ENDPOINTING_SECONDS,
        // `[]` auto-detects; >1 hint (or none) allows mid-stream language switches.
        language_config: { languages: config.languages, code_switching: config.languages.length !== 1 },
      }),
    })
  } catch (err) {
    // CORS rejection / DNS / network failures surface here as a TypeError.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`网络请求失败：${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      detail = text ? `：${text.slice(0, 200)}` : ''
    } catch {
      // status code alone is enough
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail}`)
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`会话响应不是合法 JSON：${msg}`)
  }
  if (!isGladiaLiveResponse(body)) {
    throw new Error('Gladia 会话响应格式不正确（缺少 url 字段）')
  }
  return body.url
}
