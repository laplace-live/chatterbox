/**
 * Mints a single-use ElevenLabs realtime-Scribe token (~15 min TTL).
 *
 * Browsers can't set `xi-api-key` on a WebSocket, so mint over HTTP and pass the
 * token as the `?token=` query param instead. Plain `fetch` works cross-origin:
 * the endpoint sends permissive CORS, so no `GM_xmlhttpRequest`/`@connect` grant.
 */

import { ELEVENLABS_API_BASE } from '../const'
import { isSingleUseTokenResponse } from './normalize'

export async function mintElevenLabsToken(apiKey: string): Promise<string> {
  const key = apiKey.trim()
  if (!key) throw new Error('请填写 ElevenLabs API Key')

  let res: Response
  try {
    res = await fetch(`${ELEVENLABS_API_BASE}/single-use-token/realtime_scribe`, {
      method: 'POST',
      headers: { 'xi-api-key': key },
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
    throw new Error(`令牌响应不是合法 JSON：${msg}`)
  }
  if (!isSingleUseTokenResponse(body)) {
    throw new Error('ElevenLabs 令牌响应格式不正确（缺少 token 字段）')
  }
  return body.token
}
