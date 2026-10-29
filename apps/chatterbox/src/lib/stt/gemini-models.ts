/** List Gemini Live transcription models via `gmFetch`, since a gateway or proxy root may not send CORS headers. */

import type { SttModelOption } from './types'

import { gmFetch } from '../gm-fetch'
import { buildGeminiModelsUrl } from './gemini-url'
import { parseGeminiModels } from './normalize'

const REQUEST_TIMEOUT_MS = 15_000

/** @param baseUrl Same API root the session connects through; '' = Google directly. */
export async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<SttModelOption[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('请填写 Google AI Studio API Key')
  const url = buildGeminiModelsUrl(baseUrl)

  let response: Response
  try {
    response = await gmFetch(url, {
      headers: { 'x-goog-api-key': key, Accept: 'application/json' },
      timeout: REQUEST_TIMEOUT_MS,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`)
    }
    throw new Error('网络请求失败')
  }
  const text = await response.text()
  if (!response.ok) {
    const detail = text ? `：${text.slice(0, 200)}` : ''
    throw new Error(`HTTP ${response.status} ${response.statusText}${detail}`)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (err) {
    throw new Error(`返回内容不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const models = parseGeminiModels(body)
  if (models.length === 0) throw new Error('返回列表中没有实时转写模型')
  return models
}
