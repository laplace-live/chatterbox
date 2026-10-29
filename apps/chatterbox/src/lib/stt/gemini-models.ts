/** List Gemini Live transcription and translation models through gateway-compatible `gmFetch`. */

import type { SttModelOption } from './types'

import { buildGeminiModelsUrl } from './gemini-url'
import { fetchModelList } from './model-list'
import { parseGeminiModels } from './normalize'

/** @param baseUrl Same API root the session connects through; '' = Google directly. */
export async function fetchGeminiModels(apiKey: string, baseUrl: string): Promise<SttModelOption[]> {
  const key = apiKey.trim()
  if (!key) throw new Error('请填写 Google AI Studio API Key')
  return fetchModelList(
    buildGeminiModelsUrl(baseUrl),
    { 'x-goog-api-key': key },
    parseGeminiModels,
    '返回列表中没有实时转录或翻译模型'
  )
}
