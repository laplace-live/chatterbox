/** Resolves Gemini API URLs for Google directly, a Cloudflare AI Gateway, or a reverse proxy. */

import { GEMINI_API_BASE } from '../const'

const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const MODELS_PATH = '/v1beta/models'
const GOOGLE_HOST = new URL(GEMINI_API_BASE).hostname
const CF_GATEWAY_HOST = 'gateway.ai.cloudflare.com'
// `/v1/{account_id}/{gateway}`, then whatever provider route was copied along (e.g. `/google-ai-studio/v1beta/openai`).
const CF_GATEWAY_PATH = /^\/v1\/[^/]+\/[^/]+/
// Browsers block `ws://` from an HTTPS page except to loopback, so a remote plain-HTTP root could only leak the key.
const LOOPBACK_HOST = /^(?:(?:.+\.)?localhost|127(?:\.\d{1,3}){3}|\[::1\])$/

/** Parse the API root onto the `scheme` family, keeping its TLS; `gateway` is set for a Cloudflare AI Gateway root. */
function resolveRoot(baseUrl: string, scheme: 'http' | 'ws'): { url: URL; gateway: string | undefined } {
  let url: URL
  try {
    url = new URL(baseUrl.trim() || GEMINI_API_BASE)
  } catch {
    throw new Error('接口地址无效')
  }
  if (!/^(https?|wss?):$/.test(url.protocol)) throw new Error('接口地址须以 https:// 或 http:// 开头')
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  if (!secure && !LOOPBACK_HOST.test(url.hostname)) throw new Error('非本机接口地址须使用 https://')
  url.protocol = secure ? `${scheme}s:` : `${scheme}:`
  url.hash = ''
  const gateway = url.hostname === CF_GATEWAY_HOST ? CF_GATEWAY_PATH.exec(url.pathname)?.[0] : undefined
  return { url, gateway }
}

/** `path` under a proxy root; on Google's own host any pasted path is dropped. */
const apiPath = (url: URL, path: string): string =>
  url.hostname === GOOGLE_HOST ? path : `${url.pathname.replace(/\/+$/, '')}${path}`

/**
 * Build the Live API WebSocket URL with the key attached.
 * @param baseUrl API root; '' = Google directly.
 * @throws {Error} when `baseUrl` isn't an http(s)/ws(s) URL.
 */
export function buildGeminiLiveUrl(baseUrl: string, apiKey: string): string {
  const { url, gateway } = resolveRoot(baseUrl, 'ws')
  if (gateway) {
    // AI Gateway's realtime route for Google AI Studio takes the key as `api_key`, not `key`.
    url.pathname = `${gateway}/google`
    url.searchParams.set('api_key', apiKey)
  } else {
    url.pathname = apiPath(url, LIVE_PATH)
    url.searchParams.set('key', apiKey)
  }
  return url.toString()
}

/**
 * Build the `models.list` URL for the same root; send the key as the `x-goog-api-key` header.
 * @throws {Error} when `baseUrl` isn't an http(s)/ws(s) URL.
 */
export function buildGeminiModelsUrl(baseUrl: string): string {
  const { url, gateway } = resolveRoot(baseUrl, 'http')
  url.pathname = gateway ? `${gateway}/google-ai-studio${MODELS_PATH}` : apiPath(url, MODELS_PATH)
  // Google caps a page at 1000, far above the whole catalog, so one request lists everything.
  url.searchParams.set('pageSize', '1000')
  return url.toString()
}
