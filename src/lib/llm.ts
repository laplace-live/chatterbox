/** OpenAI-compatible LLM client helpers. */

import { GITHUB_URL, PROJECT_NAME } from './const'

/** Per-token pricing from the /models endpoint; raw strings, not coerced. */
export interface LlmModelPricing {
  /** USD per prompt (input) token. */
  prompt?: string
  /** USD per completion (output) token. */
  completion?: string
}

export interface LlmModel {
  /** Model id used in chat-completions requests. */
  id: string
  /** Friendly display name when provided; UI falls back to `id` when missing. */
  name?: string
  /** Per-token pricing when the API exposes it. */
  pricing?: LlmModelPricing
}

/** Format per-token pricing as a compact USD-per-1M string; null when nothing usable. */
export function formatLlmPricing(p: LlmModelPricing | undefined): string | null {
  if (!p) return null
  const prompt = p.prompt !== undefined ? Number(p.prompt) : null
  const completion = p.completion !== undefined ? Number(p.completion) : null
  const validPrompt = prompt !== null && Number.isFinite(prompt)
  const validCompletion = completion !== null && Number.isFinite(completion)
  if (!validPrompt && !validCompletion) return null
  // All-zero pricing means free.
  if ((prompt ?? 0) === 0 && (completion ?? 0) === 0) return '免费'
  const fmt = (n: number) => `$${parseFloat((n * 1_000_000).toFixed(4))}`
  const parts: string[] = []
  if (validPrompt) parts.push(`输入 ${fmt(prompt as number)}`)
  if (validCompletion) parts.push(`输出 ${fmt(completion as number)}`)
  return `${parts.join(' · ')} / 1M tokens`
}

/** Trim trailing slashes off the typed base; `/v1` is deliberately not auto-added or stripped. */
function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/** Read a string field off an arbitrary record; undefined when missing or wrong-typed. */
function readString(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function parsePricing(raw: unknown): LlmModelPricing | undefined {
  const prompt = readString(raw, 'prompt')
  const completion = readString(raw, 'completion')
  if (prompt === undefined && completion === undefined) return undefined
  const out: LlmModelPricing = {}
  if (prompt !== undefined) out.prompt = prompt
  if (completion !== undefined) out.completion = completion
  return out
}

/** GET `${base}/models` and return the sorted model list; throws Error with user-readable message. */
export async function fetchLlmModels(base: string, apiKey: string): Promise<LlmModel[]> {
  const trimmedBase = normalizeBase(base)
  if (!trimmedBase) throw new Error('请填写 API 地址')
  if (!apiKey.trim()) throw new Error('请填写 API Key')

  let url: string
  try {
    url = new URL(`${trimmedBase}/models`).toString()
  } catch {
    throw new Error('API 地址格式无效')
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        Accept: 'application/json',
        'HTTP-Referer': GITHUB_URL,
        'X-Title': PROJECT_NAME,
        'X-OpenRouter-Title': PROJECT_NAME,
        'X-OpenRouter-Categories': 'roleplay',
      },
    })
  } catch (err) {
    // CORS / DNS / network failures all surface as a generic TypeError from `fetch`.
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

  // OpenAI shape: { object: "list", data: [{ id, ... }] }.
  if (!json || typeof json !== 'object' || !Array.isArray((json as { data?: unknown }).data)) {
    throw new Error('返回数据缺少 data 数组')
  }
  const data = (json as { data: Array<unknown> }).data
  const models: LlmModel[] = []
  const seen = new Set<string>()
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const id = readString(entry, 'id')?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: LlmModel = { id }
    const name = readString(entry, 'name')?.trim()
    if (name && name !== id) model.name = name
    const pricing = parsePricing((entry as Record<string, unknown>).pricing)
    if (pricing) model.pricing = pricing
    models.push(model)
  }
  if (models.length === 0) throw new Error('返回模型列表为空')

  // Stable order by id so the dropdown doesn't reshuffle between refreshes.
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

/** One OpenAI-style chat message; only `role` + `content` are used. */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** OpenAI-style structured-output directive; unrecognizing vendors silently ignore it, so still instruct JSON via the system prompt. */
export interface ChatCompletionResponseFormat {
  type: 'json_schema'
  json_schema: {
    /** Schema identifier; required by OpenAI, ignored by tolerant implementations. */
    name: string
    /** Reject unknown properties; call sites default to true to fail loudly. */
    strict?: boolean
    /** JSON Schema body (the subset OpenAI accepts). */
    schema: unknown
  }
}

export interface ChatCompletionOptions {
  base: string
  apiKey: string
  model: string
  messages: LlmChatMessage[]
  /** Sampling temperature; defaults to 0.7. */
  temperature?: number
  /** Cap on response length; unset means the model's default. */
  maxTokens?: number
  /** Structured-output directive forwarded as `response_format`; parse defensively regardless. */
  responseFormat?: ChatCompletionResponseFormat
  /** Abort signal to cancel in-flight requests. */
  signal?: AbortSignal
}

/**
 * POST `${base}/chat/completions` and return the first choice's `content`.
 *
 * Streaming is intentionally not enabled (full text in one shot). Throws Error
 * with user-readable messages; AbortError is propagated untouched.
 */
export async function chatCompletion(opts: ChatCompletionOptions): Promise<string> {
  const trimmedBase = normalizeBase(opts.base)
  if (!trimmedBase) throw new Error('请填写 API 地址')
  if (!opts.apiKey.trim()) throw new Error('请填写 API Key')
  if (!opts.model.trim()) throw new Error('请选择模型')
  if (opts.messages.length === 0) throw new Error('消息内容不能为空')

  let url: string
  try {
    url = new URL(`${trimmedBase}/chat/completions`).toString()
  } catch {
    throw new Error('API 地址格式无效')
  }

  // `stream: false` is explicit to defeat proxies/vendors that default to streaming.
  const body: Record<string, unknown> = {
    model: opts.model.trim(),
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
    stream: false,
  }
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens
  if (opts.responseFormat) body.response_format = opts.responseFormat

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey.trim()}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'HTTP-Referer': GITHUB_URL,
        'X-Title': PROJECT_NAME,
        'X-OpenRouter-Title': PROJECT_NAME,
        'X-OpenRouter-Categories': 'roleplay',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (err) {
    // AbortError is a DOMException; let it propagate so callers see "cancelled" not "network died".
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`网络请求失败：${msg}`)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const text = await res.text()
      detail = text ? `: ${text.slice(0, 200)}` : ''
    } catch {
      // body read errors don't matter — status code alone is enough
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

  // OpenAI shape: { choices: [{ message: { role, content } }] }; empty choices (e.g. filtered) is an error.
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('返回数据缺少 choices 数组')
  }
  const message = (choices[0] as { message?: unknown }).message
  const content = readString(message, 'content')
  if (!content) throw new Error('返回数据缺少 content 字段')
  return content
}
