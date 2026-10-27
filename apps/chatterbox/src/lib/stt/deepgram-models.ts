/** List Deepgram realtime STT models. `/v1/models` sends no CORS headers, so use `gmFetch`, not `fetch`. */

import type { SttModelOption } from './types'

import { DEEPGRAM_API_BASE } from '../const'
import { gmFetch } from '../gm-fetch'
import { parseDeepgramModels } from './normalize'

const REQUEST_TIMEOUT_MS = 15_000

export async function fetchDeepgramModels(apiKey: string): Promise<SttModelOption[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('请填写 Deepgram API Key')

  let response: Response
  try {
    response = await gmFetch(`${DEEPGRAM_API_BASE}/models`, {
      headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
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
  const models = parseDeepgramModels(body)
  if (models.length === 0) throw new Error('返回实时模型列表为空')
  return models
}
