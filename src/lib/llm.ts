/**
 * OpenAI-compatible LLM client helpers.
 *
 * Only the model-listing endpoint is implemented right now; the rest of the
 * integration (chat completions, etc.) lands later. Kept in its own module
 * so the future call sites have a single place to reach for shared
 * URL-normalisation and error handling.
 */

import { PROJECT_NAME, PROJECT_URL } from './const'

/**
 * Per-token pricing as returned by the OpenAI-compatible /models endpoint.
 *
 * Values are kept as raw strings (the way OpenRouter and friends emit them
 * — e.g. `"0.0000025"` for prompt tokens) rather than coerced to numbers
 * here, so the consumer can decide whether to display, format, or compare.
 *
 * Most providers don't expose pricing at all; the field is undefined in
 * that case. Vendors using OpenRouter-shaped responses (`pricing.prompt`,
 * `pricing.completion`) populate them.
 */
export interface LlmModelPricing {
  /** USD per prompt (input) token. */
  prompt?: string
  /** USD per completion (output) token. */
  completion?: string
}

export interface LlmModel {
  /** Model id used in chat-completions requests. */
  id: string
  /**
   * Friendly display name when the API provides one (OpenRouter does;
   * OpenAI doesn't). Settings UI should fall back to `id` when missing.
   */
  name?: string
  /** Per-token pricing when the API exposes it. */
  pricing?: LlmModelPricing
}

/**
 * Format an LLM provider's per-token pricing as a compact USD-per-million
 * string. OpenRouter returns raw decimals like `"0.0000025"` for $2.50 /
 * 1M tokens, so we multiply through to land on the more familiar M scale
 * the industry quotes pricing in.
 *
 * Trailing zeros are stripped via `parseFloat(toFixed(4))` so both
 * `2.50000` → `2.5` and `0.0001000` → `0.0001` render cleanly. Returns
 * `null` when there's nothing usable to show — caller decides whether to
 * render anything.
 */
export function formatLlmPricing(p: LlmModelPricing | undefined): string | null {
  if (!p) return null
  const prompt = p.prompt !== undefined ? Number(p.prompt) : null
  const completion = p.completion !== undefined ? Number(p.completion) : null
  // Coerce-failures (NaN) and entirely-absent are equivalent for display.
  const validPrompt = prompt !== null && Number.isFinite(prompt)
  const validCompletion = completion !== null && Number.isFinite(completion)
  if (!validPrompt && !validCompletion) return null
  // Most providers signal "free" with all zeros; flatten the noise.
  if ((prompt ?? 0) === 0 && (completion ?? 0) === 0) return '免费'
  const fmt = (n: number) => `$${parseFloat((n * 1_000_000).toFixed(4))}`
  const parts: string[] = []
  if (validPrompt) parts.push(`输入 ${fmt(prompt as number)}`)
  if (validCompletion) parts.push(`输出 ${fmt(completion as number)}`)
  return `${parts.join(' · ')} / 1M tokens`
}

/**
 * Trim trailing slashes off the user-typed base so we can append `/models`
 * etc. without ending up with `//models`. We do *not* auto-strip or auto-add
 * `/v1`: the typed value is the source of truth (some self-hosted backends
 * mount the API at the bare root, others at `/v1`, and we shouldn't
 * second-guess either).
 */
function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, '')
}

/**
 * Pull a string field off an arbitrary record without throwing on missing
 * / wrong-typed values. Used for the defensive parser below — providers
 * vary in shape and we only want fields we can trust.
 */
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

/**
 * GET `${base}/models` against an OpenAI-compatible endpoint and return the
 * sorted list of models.
 *
 * Errors surface as thrown `Error` instances with user-readable messages so
 * the caller can pipe them straight into a status line. We deliberately
 * avoid swallowing any error class — the caller decides how loud to be.
 *
 * Parsing is intentionally permissive: any entry with a `string` `id` is
 * accepted, with `name` / `pricing` extracted only when the provider
 * supplies them in the canonical OpenRouter shape. Self-hosted backends
 * that return just `{ id }` work the same as before.
 */
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
        'HTTP-Referer': PROJECT_URL,
        'X-Title': PROJECT_NAME,
        'X-OpenRouter-Title': PROJECT_NAME,
        'X-OpenRouter-Categories': 'roleplay',
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

  // OpenAI shape: { object: "list", data: [{ id, ... }] }. We accept any
  // object whose `data` is an array of `{ id: string }` so the helper
  // works with OpenRouter / Together / vLLM / Ollama / LM Studio etc.
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

  // Stable lexicographic order by id so the dropdown doesn't reshuffle
  // between refreshes (some providers return creation-ordered lists,
  // which surfaces freshly added models at unpredictable positions).
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}

/**
 * One message in an OpenAI-style chat-completion conversation. We only
 * use `role` + `content` — `name`, `tool_calls`, etc. are unused by the
 * polish use case and would just be noise in the wire payload.
 */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * OpenAI-style structured-output directive.
 *
 * Only the `json_schema` form is modelled here — the older `json_object`
 * form is uninteresting because providers that accept it also accept
 * `json_schema`, which gives us guaranteed shape on top of "must be JSON".
 *
 * Passed through verbatim to the wire body. Vendors that don't recognise
 * `response_format` (older self-hosted servers, some routers) silently
 * ignore the field; callers should still instruct the model to emit JSON
 * via the system prompt so the parse path doesn't depend on the directive
 * being honoured.
 */
export interface ChatCompletionResponseFormat {
  type: 'json_schema'
  json_schema: {
    /** Human-readable identifier for the schema. Required by OpenAI's
     *  structured-outputs spec; ignored by tolerant implementations. */
    name: string
    /** Whether unknown properties are rejected. OpenAI defaults to
     *  false; we default to true at call sites to fail loudly. */
    strict?: boolean
    /** JSON Schema body (subset OpenAI accepts: object/array/string/
     *  number/boolean/null, with `properties`, `required`, etc.). */
    schema: unknown
  }
}

export interface ChatCompletionOptions {
  base: string
  apiKey: string
  model: string
  messages: LlmChatMessage[]
  /** Sampling temperature. Defaults to 0.7 — same as OpenAI's web UI. */
  temperature?: number
  /** Cap on response length. Most providers honour this; unset means
   *  whatever the model's default is. */
  maxTokens?: number
  /** Optional structured-output directive. Forwarded to the wire body
   *  as `response_format`. Vendors that ignore it still receive JSON
   *  via the system prompt; callers should still parse defensively. */
  responseFormat?: ChatCompletionResponseFormat
  /** Optional abort signal so callers can cancel in-flight requests
   *  (e.g. when the user navigates away mid-polish). */
  signal?: AbortSignal
}

/**
 * POST `${base}/chat/completions` with an OpenAI-shaped body and return
 * the assistant's `content` string from the first choice.
 *
 * Streaming is intentionally NOT enabled — the polish UI wants the full
 * text in one shot so it can apply post-processing (trim, dequote) and
 * decide what to do with it. If we add a streaming chat panel later,
 * this helper grows a sibling rather than changing in place.
 *
 * Errors surface as thrown `Error` instances with user-readable Chinese
 * messages so the caller can pipe them straight into a status line /
 * `appendLog`. AbortError is propagated untouched so cancellation paths
 * don't get re-classified as network failures.
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

  // Build the wire body. `stream: false` is explicit to defeat any
  // proxy / vendor that defaults to streaming when the client doesn't
  // say otherwise — we don't parse SSE in this code path.
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
        'HTTP-Referer': PROJECT_URL,
        'X-Title': PROJECT_NAME,
        'X-OpenRouter-Title': PROJECT_NAME,
        'X-OpenRouter-Categories': 'roleplay',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (err) {
    // AbortError is a DOMException in browsers; let it propagate so
    // callers can distinguish "user cancelled" from "network died".
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

  // OpenAI shape: { choices: [{ message: { role, content }, finish_reason }] }.
  // Vendors sometimes return an empty choices array (e.g. when content
  // is filtered) — treat that as an error rather than silently returning
  // empty so the user sees something specific.
  const choices = (json as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('返回数据缺少 choices 数组')
  }
  const message = (choices[0] as { message?: unknown }).message
  const content = readString(message, 'content')
  if (!content) throw new Error('返回数据缺少 content 字段')
  return content
}
