/** Resolves the Gemini Live WebSocket URL for Google directly, a Cloudflare AI Gateway, or a reverse proxy. */

import { GEMINI_API_BASE } from '../const'

const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const GOOGLE_HOST = new URL(GEMINI_API_BASE).hostname
const CF_GATEWAY_HOST = 'gateway.ai.cloudflare.com'
// `/v1/{account_id}/{gateway}`, then whatever provider route was copied along (e.g. `/google-ai-studio/v1beta/openai`).
const CF_GATEWAY_PATH = /^\/v1\/([^/]+)\/([^/]+)/

/**
 * Build the Live API WebSocket URL with the key attached.
 * @param baseUrl API root; '' = Google directly. Paths on Google's own host are ignored.
 * @throws {Error} when `baseUrl` isn't an http(s)/ws(s) URL.
 */
export function buildGeminiLiveUrl(baseUrl: string, apiKey: string): string {
  let url: URL
  try {
    url = new URL(baseUrl.trim() || GEMINI_API_BASE)
  } catch {
    throw new Error('接口地址无效')
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) throw new Error('接口地址须以 https:// 或 http:// 开头')
  url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:'
  url.hash = ''

  const gateway = url.hostname === CF_GATEWAY_HOST ? CF_GATEWAY_PATH.exec(url.pathname) : null
  if (gateway) {
    // AI Gateway's realtime route for Google AI Studio takes the key as `api_key`, not `key`.
    url.pathname = `/v1/${gateway[1]}/${gateway[2]}/google`
    url.searchParams.set('api_key', apiKey)
  } else {
    url.pathname = url.hostname === GOOGLE_HOST ? LIVE_PATH : `${url.pathname.replace(/\/+$/, '')}${LIVE_PATH}`
    url.searchParams.set('key', apiKey)
  }
  return url.toString()
}
