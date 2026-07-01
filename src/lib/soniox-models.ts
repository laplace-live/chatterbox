/**
 * Soniox STT model-listing helper.
 *
 * - Base is fixed (`SONIOX_API_BASE`); response is `{ models: [...] }`.
 * - Filters to `transcription_mode === 'real_time'`: async models fail at streaming session start.
 */

import { SONIOX_API_BASE } from './const'

export interface SonioxModel {
  /** Model id used in the realtime session config (e.g. `stt-rt-v5`). */
  id: string
  /** Friendly display name; kept to widen the dropdown's search filter (renders id-only). */
  name?: string
}

/** Pull a string field off an arbitrary record, returning undefined on missing/wrong-typed values. */
function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * GET the Soniox models endpoint, returning real-time models sorted by id.
 *
 * @throws {Error} with a user-readable message the caller can show in a status line.
 */
export async function fetchSonioxModels(apiKey: string): Promise<SonioxModel[]> {
  if (!apiKey.trim()) throw new Error('请填写 API Key')

  let res: Response
  try {
    res = await fetch(`${SONIOX_API_BASE}/models`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: 'application/json',
      },
    })
  } catch (err) {
    // CORS rejections and DNS/network failures both surface here as a generic TypeError.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`网络请求失败：${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      detail = text ? `: ${text.slice(0, 200)}` : ''
    } catch {
      // ignore body read errors — status code alone is enough
    }
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail}`)
  }

  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`返回内容不是合法 JSON：${msg}`)
  }

  // Soniox shape: { models: [{ id, name, transcription_mode, ... }] }.
  if (!json || typeof json !== 'object' || !Array.isArray((json as { models?: unknown }).models)) {
    throw new Error('返回数据缺少 models 数组')
  }
  const data = (json as { models: Array<unknown> }).models
  const models: SonioxModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    // Async models are unusable in the streaming STT session.
    if (readString(entry, 'transcription_mode') !== 'real_time') continue
    const id = readString(entry, 'id')?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: SonioxModel = { id }
    const name = readString(entry, 'name')?.trim()
    if (name && name !== id) model.name = name
    models.push(model)
  }
  if (models.length === 0) throw new Error('返回实时模型列表为空')

  // Stable order so the dropdown doesn't reshuffle between refreshes.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
