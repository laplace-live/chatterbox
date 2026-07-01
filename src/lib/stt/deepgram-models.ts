/** List Deepgram realtime STT models. `/v1/models` sends no CORS headers, so use `GM_xmlhttpRequest`, not `fetch`. */

import type { SttModelOption } from './types'

import { GM_xmlhttpRequest } from '$'
import { DEEPGRAM_API_BASE } from '../const'
import { parseDeepgramModels } from './normalize'

export function fetchDeepgramModels(apiKey: string): Promise<SttModelOption[]> {
  const key = apiKey.trim()
  if (!key) return Promise.reject(new Error('请填写 Deepgram API Key'))

  return new Promise<SttModelOption[]>((resolve, reject) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${DEEPGRAM_API_BASE}/models`,
      headers: { Authorization: `Token ${key}`, Accept: 'application/json' },
      onload: response => {
        if (response.status < 200 || response.status >= 300) {
          const detail = response.responseText ? `：${response.responseText.slice(0, 200)}` : ''
          reject(new Error(`HTTP ${response.status} ${response.statusText}${detail}`))
          return
        }
        let body: unknown
        try {
          body = JSON.parse(response.responseText)
        } catch (err) {
          reject(new Error(`返回内容不是合法 JSON：${err instanceof Error ? err.message : String(err)}`))
          return
        }
        const models = parseDeepgramModels(body)
        if (models.length === 0) {
          reject(new Error('返回实时模型列表为空'))
          return
        }
        resolve(models)
      },
      onerror: () => reject(new Error('网络请求失败')),
      ontimeout: () => reject(new Error('请求超时')),
    })
  })
}
