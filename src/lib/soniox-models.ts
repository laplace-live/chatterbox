/**
 * Soniox STT model-listing helper.
 *
 * Mirrors `lib/llm.ts`'s `fetchLlmModels` in shape — same defensive
 * parsing and Chinese error messages piped straight into a status line —
 * but targets Soniox's own REST API instead of an OpenAI-compatible one:
 *
 *   - Endpoint base is FIXED (`SONIOX_API_BASE`), not user-configurable.
 *     Soniox hosts the only models API; there's no self-hosted variant to
 *     point at the way the LLM picker allows.
 *   - Response is `{ models: [...] }` (not OpenAI's `{ data: [...] }`).
 *   - We filter to `transcription_mode === 'real_time'`. The STT tab drives
 *     a live streaming `Recording`; an async model would fail at session
 *     start, so surfacing one in the dropdown would only invite breakage.
 *
 * Networking is plain `fetch` (same as the LLM helper), relying on Soniox
 * sending permissive CORS headers — its in-browser SDK already talks to
 * the same origin, so the models endpoint is expected to as well.
 */

import { SONIOX_API_BASE } from './const'

export interface SonioxModel {
  /** Model id used in the realtime session config (e.g. `stt-rt-v5`). */
  id: string
  /**
   * Friendly display name when the API provides one. The dropdown renders
   * id-only, but we keep `name` to widen the search filter so typing the
   * human-readable name still finds the row.
   */
  name?: string
}

/**
 * Pull a string field off an arbitrary record without throwing on missing
 * / wrong-typed values. Same defensive accessor `lib/llm.ts` uses — Soniox
 * shouldn't drift from its documented shape, but a single bad entry
 * shouldn't tank the whole list either.
 */
function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/**
 * GET the Soniox models endpoint and return the real-time models sorted by
 * id.
 *
 * Errors surface as thrown `Error` instances with user-readable messages so
 * the caller can pipe them straight into a status line. We deliberately
 * avoid swallowing any error class — the caller decides how loud to be.
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
    // Most commonly hit for CORS rejections and DNS / network failures —
    // both surface here as a generic TypeError from `fetch`.
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
    // Skip anything that isn't a real-time model — the STT tab can only
    // drive a streaming session, so async models are unusable here.
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

  // Stable lexicographic order by id so the dropdown doesn't reshuffle
  // between refreshes.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
