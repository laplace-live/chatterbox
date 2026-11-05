/** Resolves Gemini API URLs for Google directly or a reverse proxy. */

import { GEMINI_API_BASE } from '../const'

const LIVE_PATH = '/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
const MODELS_PATH = '/v1beta/models'
const GOOGLE_HOST = new URL(GEMINI_API_BASE).hostname
// Browsers block insecure WebSockets from an HTTPS page except to loopback, so a remote plain-HTTP root could only leak the key.
const LOOPBACK_HOST = /^(?:(?:.+\.)?localhost|127(?:\.\d{1,3}){3}|\[::1\])$/

/** Parse the API root onto the `scheme` family, keeping its TLS, and append `path` (dropping any pasted path on Google's own host). */
function resolveEndpoint(baseUrl: string, scheme: 'http' | 'ws', path: string): URL {
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
  url.pathname = url.hostname === GOOGLE_HOST ? path : `${url.pathname.replace(/\/+$/, '')}${path}`
  url.hash = ''
  return url
}

/**
 * Build the Live API WebSocket URL with the key attached.
 * @param baseUrl API root; '' = Google directly.
 * @throws {Error} when `baseUrl` isn't an http(s)/ws(s) URL.
 */
export function buildGeminiLiveUrl(baseUrl: string, apiKey: string): string {
  const url = resolveEndpoint(baseUrl, 'ws', LIVE_PATH)
  url.searchParams.set('key', apiKey)
  return url.toString()
}

/**
 * Build the `models.list` URL for the same root; send the key as the `x-goog-api-key` header.
 * @throws {Error} when `baseUrl` isn't an http(s)/ws(s) URL.
 */
export function buildGeminiModelsUrl(baseUrl: string): string {
  const url = resolveEndpoint(baseUrl, 'http', MODELS_PATH)
  // Google caps a page at 1000, far above the whole catalog, so one request lists everything.
  url.searchParams.set('pageSize', '1000')
  return url.toString()
}
