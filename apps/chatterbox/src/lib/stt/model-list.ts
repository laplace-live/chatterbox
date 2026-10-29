import type { SttModelOption } from './types'

import { gmFetch } from '../gm-fetch'

const REQUEST_TIMEOUT_MS = 15_000

/**
 * GET a model list via `gmFetch`, turning timeout, transport, HTTP and JSON failures into user-readable errors.
 * @throws {Error} with `emptyMessage` when `parse` finds no model.
 */
export async function fetchModelList(
  url: string,
  headers: Record<string, string>,
  parse: (body: unknown) => SttModelOption[],
  emptyMessage: string
): Promise<SttModelOption[]> {
  let response: Response
  try {
    response = await gmFetch(url, { headers: { ...headers, Accept: 'application/json' }, timeout: REQUEST_TIMEOUT_MS })
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
  const models = parse(body)
  if (models.length === 0) throw new Error(emptyMessage)
  return models
}
