/** List Deepgram realtime STT models. `/v1/models` sends no CORS headers, so use `gmFetch`, not `fetch`. */

import type { SttModelOption } from './types'

import { DEEPGRAM_API_BASE } from '../const'
import { fetchModelList } from './model-list'
import { parseDeepgramModels } from './normalize'

export async function fetchDeepgramModels(apiKey: string): Promise<SttModelOption[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('请填写 Deepgram API Key')
  return fetchModelList(
    `${DEEPGRAM_API_BASE}/models`,
    { Authorization: `Token ${key}` },
    parseDeepgramModels,
    '返回实时模型列表为空'
  )
}
