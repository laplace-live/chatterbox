/**
 * 智能辅助驾驶 LLM 客户端。
 *
 * 三个 provider：
 *   - `anthropic`：调用 `https://api.anthropic.com/v1/messages`
 *   - `openai`：调用 `https://api.openai.com/v1/chat/completions`
 *   - `openai-compat`：调用 `<baseURL>/v1/chat/completions`，OpenAI 兼容（DeepSeek/Moonshot/OpenRouter/Ollama）
 *
 * 都走 GM_xmlhttpRequest（gm-fetch.ts），因为浏览器直连这些 LLM 端点会被 CORS 拦截。
 *
 * 这个模块由 `hzm-auto-drive.ts` 通过 `await import('./llm-driver')` 懒加载（智驾路径），
 * 同时也被 `llm-polish.ts` 静态 import（AI 润色路径，原代号 YOLO）。vite-plugin-monkey
 * 把所有 chunk 合进单个 user.js，所以两种 import 风格在 userscript 上效果相同；AI 润色
 * 走静态导入是因为实测懒加载会让 vite 多发一份 chunk，反而把 user.js 体积撑大 ~80KB
 * （超出 1024KB release 预算），不值得。
 */

import type { LlmProvider } from './store-llm'

import { BASE_URL } from './const'
import { gmFetch } from './gm-fetch'
import { appendLog } from './log'

export interface LlmCandidate {
  id: string
  content: string
  tags: string[]
}

/**
 * Hard cap on `candidates` sent to the LLM. The system prompt advertises ≤30
 * but a buggy caller could pass thousands, blowing up token cost (and
 * latency) without bounded warning. Truncate + log if exceeded.
 */
export const LLM_CANDIDATES_HARD_CAP = 256

export interface ChooseMemeOptions {
  provider: LlmProvider
  apiKey: string
  model: string
  /** 仅 provider='openai-compat' 时使用。例如 `https://api.deepseek.com`。可带或不带尾斜线。 */
  baseURL?: string
  /** 用于 prompt 上下文，例如 "灰泽满烂梗库"。 */
  roomName: string
  /** 最近 30 条公屏弹幕文本。 */
  recentChat: string[]
  /** 候选梗（≤30 条）。 */
  candidates: LlmCandidate[]
  /** Optional abort signal so callers can cancel in-flight LLM requests. */
  signal?: AbortSignal
}

const SYSTEM_PROMPT_TEMPLATE = (roomName: string) =>
  `你在 ${roomName} 直播间帮观众发弹幕（独轮车）。从下面给出的 candidates 里选 1 条最贴合最近公屏氛围的发出去。
仅返回该梗的 id（candidates 里的 id 字符串）。如果都不合适，返回 -1。
不要解释，不要带前后空格，不要 Markdown，只输出一个 id 字符串或者 -1。`

function buildUserMessage(opts: ChooseMemeOptions): string {
  return JSON.stringify({
    recentDanmu: opts.recentChat,
    candidates: opts.candidates,
  })
}

/**
 * Build the chat-completions URL from a user-configured OpenAI-compatible
 * base URL.
 *
 * Real users paste the base in three different shapes:
 *   - `https://api.deepseek.com`                       (just the host)
 *   - `https://token-plan-sgp.xiaomimimo.com/v1`       (host + /v1)
 *   - `https://x.example.com/v1/chat/completions`      (the full endpoint)
 *
 * Naively appending `/v1/chat/completions` would produce `/v1/v1/...` for the
 * second case, which is exactly the failure reported by the Mimo user. So we
 * detect the existing suffix and only add what's missing.
 */
export function buildOpenAICompatChatURL(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/v1\/chat\/completions$/i.test(trimmed)) return trimmed
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

interface LlmResponseChoice {
  /** 原始返回 id 字符串（包含 "-1" 用作弃权信号）。 */
  rawId: string
}

function parseAnthropicResponse(json: unknown): LlmResponseChoice | null {
  if (!json || typeof json !== 'object') return null
  const arr = (json as { content?: Array<{ text?: string }> }).content
  if (!Array.isArray(arr) || arr.length === 0) return null
  const text = arr
    .map(c => c.text ?? '')
    .join('')
    .trim()
  return text ? { rawId: text } : null
}

interface OpenAIChoice {
  message?: { content?: string; reasoning_content?: string }
  finish_reason?: string
}

/**
 * Pull an id-like token (digits or "-1") from the tail of a reasoning trace.
 *
 * Reasoning models (Xiaomi MiMo, DeepSeek-R1, etc.) often route the answer
 * into `reasoning_content` and leave `content` empty when `max_tokens` is
 * tight. The model usually converges to the answer at the very end of its
 * thinking, so we grab the last numeric run from the tail.
 */
function extractIdFromReasoning(reasoning: string): string | null {
  const tail = reasoning.slice(-300)
  const matches = tail.match(/-?\d+/g)
  if (!matches || matches.length === 0) return null
  return matches[matches.length - 1] ?? null
}

function parseOpenAIResponse(json: unknown): LlmResponseChoice | null {
  if (!json || typeof json !== 'object') return null
  const choices = (json as { choices?: OpenAIChoice[] }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = choices[0]
  if (!choice) return null
  const content = choice.message?.content?.trim() ?? ''
  if (content) return { rawId: content }
  const reasoning = choice.message?.reasoning_content?.trim() ?? ''
  if (reasoning) {
    const fromReasoning = extractIdFromReasoning(reasoning)
    if (fromReasoning) return { rawId: fromReasoning }
  }
  return null
}

async function callAnthropic(opts: ChooseMemeOptions): Promise<LlmResponseChoice | null> {
  const resp = await gmFetch(BASE_URL.ANTHROPIC_MESSAGES, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      // Allow CORS-safe direct browser usage.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 64,
      system: [{ type: 'text', text: SYSTEM_PROMPT_TEMPLATE(opts.roomName), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserMessage(opts) }],
    }),
    timeoutMs: 15000,
    signal: opts.signal,
  })
  if (!resp.ok) {
    // 上游 body 可能含有重复回显的 prompt 片段或在某些误配下回显 key 残留;
    // 仅保留状态码 + 文本,详细 body 进 console.error 不进 appendLog/notifyUser。
    if (typeof console !== 'undefined') {
      console.error(`[llm-driver] Anthropic ${resp.status}`, resp.text().slice(0, 500))
    }
    throw new Error(`Anthropic HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  }
  return parseAnthropicResponse(resp.json())
}

async function callOpenAI(opts: ChooseMemeOptions, urlOverride?: string): Promise<LlmResponseChoice | null> {
  const url = urlOverride ?? BASE_URL.OPENAI_CHAT
  const resp = await gmFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      // 1024 instead of 64 so reasoning models (Xiaomi MiMo, DeepSeek-R1, o1,
      // etc.) have room to think AND emit the id. With 64 tokens the entire
      // budget gets consumed by reasoning_content and `content` is left empty
      // (finish_reason=length), surfacing as a confusing "empty response"
      // error in the UI. Non-reasoning models stop early after the tiny id so
      // there's no real cost.
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT_TEMPLATE(opts.roomName) },
        { role: 'user', content: buildUserMessage(opts) },
      ],
    }),
    timeoutMs: 30000,
    signal: opts.signal,
  })
  if (!resp.ok) {
    if (typeof console !== 'undefined') {
      console.error(`[llm-driver] OpenAI ${resp.status}`, resp.text().slice(0, 500))
    }
    throw new Error(`OpenAI HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  }
  return parseOpenAIResponse(resp.json())
}

/**
 * 测试 LLM 配置是否可用——发一个最小请求验证 auth 和路由对了。
 *
 * - 不需要真实候选；用一个伪造的最小 candidates，看返回能不能解析出来
 * - 抛错（HTTP 4xx/5xx、网络问题、超时）→ `{ ok: false, error }`
 * - 任何 200 + 可解析响应 → `{ ok: true }`，即便模型返回 `-1`（视为弃权也算 API 通）
 *
 * 给 UI 用：API key 配好后用户点「测试连接」会调用这个。
 */
export async function testLLMConnection(opts: {
  provider: LlmProvider
  apiKey: string
  model: string
  baseURL?: string
}): Promise<{ ok: boolean; error?: string }> {
  if (!opts.apiKey.trim()) return { ok: false, error: 'API key 为空' }
  const probe: ChooseMemeOptions = {
    ...opts,
    roomName: '连接测试',
    recentChat: ['ping'],
    candidates: [{ id: '1', content: 'pong', tags: [] }],
  }
  try {
    let parsed: LlmResponseChoice | null = null
    if (opts.provider === 'anthropic') {
      parsed = await callAnthropic(probe)
    } else if (opts.provider === 'openai') {
      parsed = await callOpenAI(probe)
    } else {
      const base = (opts.baseURL ?? '').trim()
      if (!base) return { ok: false, error: '需要填 base URL（例如 https://api.deepseek.com）' }
      parsed = await callOpenAI(probe, buildOpenAICompatChatURL(base))
    }
    if (parsed === null) return { ok: false, error: '响应里未解析出文本（模型可能返回了空）' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 选一条最贴合最近公屏的梗。
 *
 * 返回值：
 *  - 命中：返回该候选梗的 `content` 字符串（调用方据此从池里查回 meme 对象）
 *  - LLM 主动弃权（返回 -1）或解析失败：返回 `null`，调用方应回退启发式
 *
 * 抛错时让调用方接住——hzm-auto-drive 会 catch 并回退启发式。
 */
export async function chooseMemeWithLLM(opts: ChooseMemeOptions): Promise<string | null> {
  if (!opts.apiKey || opts.candidates.length === 0) return null

  let effectiveOpts = opts
  if (opts.candidates.length > LLM_CANDIDATES_HARD_CAP) {
    appendLog(
      `⚠️ 智驾：candidates 超过上限 ${LLM_CANDIDATES_HARD_CAP}（实际 ${opts.candidates.length}），已截断以避免请求超额`
    )
    effectiveOpts = { ...opts, candidates: opts.candidates.slice(0, LLM_CANDIDATES_HARD_CAP) }
  }

  let parsed: LlmResponseChoice | null = null
  if (effectiveOpts.provider === 'anthropic') {
    parsed = await callAnthropic(effectiveOpts)
  } else if (effectiveOpts.provider === 'openai') {
    parsed = await callOpenAI(effectiveOpts)
  } else {
    // openai-compat
    const base = (effectiveOpts.baseURL ?? '').trim()
    if (!base) throw new Error('openai-compat 需要填 base URL（例如 https://api.deepseek.com）')
    parsed = await callOpenAI(effectiveOpts, buildOpenAICompatChatURL(base))
  }

  if (!parsed) return null
  const raw = parsed.rawId.trim()
  if (!raw) return null

  const id = normalizeIdFromLlmOutput(raw)
  if (id === '-1') return null

  if (id) {
    const found = effectiveOpts.candidates.find(c => c.id === id)
    if (found) return found.content
  }

  // 一些模型可能直接吐 content 而非 id，再容错一次：尝试根据 raw 字符串匹配 content 子串
  const byContent = effectiveOpts.candidates.find(
    c => c.content === raw || raw.includes(c.content) || c.content.includes(raw)
  )
  return byContent?.content ?? null
}

// ---------------------------------------------------------------------------
// Generic chat completion (used by YOLO text-polish, NOT meme picking).
//
// Different shape than the meme-picking code above:
//   - meme-picking returns a structured id token + has its own SYSTEM_PROMPT_TEMPLATE,
//     reasoning_content fallback, abstain semantics ("-1"), etc.
//   - text-polish wants a plain assistant content string back, with a user-supplied
//     system prompt + user message. No structured parsing.
//
// We deliberately keep these as parallel sibling helpers rather than refactoring
// the meme code. The meme path is heavily tuned (reasoning_content extraction,
// id normalisation, content-substring fallback) and refactoring under it carries
// a regression risk that's not worth a small bit of DRY here.
// ---------------------------------------------------------------------------

export interface ChatCompletionOptions {
  provider: LlmProvider
  apiKey: string
  model: string
  /** Only used when provider='openai-compat'. */
  baseURL?: string
  /** System prompt — task instructions + global baseline (joined upstream). */
  systemPrompt: string
  /** User message — the text to polish. */
  userText: string
  /** Cap on response length. Default 256 — text polish for danmaku is short. */
  maxTokens?: number
  /** Optional abort signal so callers can cancel in-flight requests. */
  signal?: AbortSignal
}

function readContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const choices = (json as { choices?: OpenAIChoice[] }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const choice = choices[0]
  const content = choice?.message?.content?.trim() ?? ''
  return content || null
}

function readAnthropicContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const arr = (json as { content?: Array<{ text?: string; type?: string }> }).content
  if (!Array.isArray(arr) || arr.length === 0) return null
  // Anthropic returns content blocks; concatenate all `text` blocks (skip
  // tool_use, etc.). For polish, this is always 1 block but be defensive.
  const text = arr
    .filter(c => !c.type || c.type === 'text')
    .map(c => c.text ?? '')
    .join('')
    .trim()
  return text || null
}

async function postOpenAIChatPolish(opts: ChatCompletionOptions, urlOverride?: string): Promise<string> {
  const url = urlOverride ?? BASE_URL.OPENAI_CHAT
  const resp = await gmFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${opts.apiKey.trim()}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model.trim(),
      max_tokens: opts.maxTokens ?? 256,
      temperature: 0.7,
      stream: false,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userText },
      ],
    }),
    timeoutMs: 30000,
    signal: opts.signal,
  })
  if (!resp.ok) {
    // 错误消息只保留状态码 + 状态文本——upstream body 可能含有用户提示词
    // 片段甚至 API key 残留(见 audit M9),不该流到 appendLog/notifyUser。
    throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  }
  const content = readContent(resp.json())
  if (!content) throw new Error('返回内容为空')
  return content
}

async function postAnthropicPolish(opts: ChatCompletionOptions): Promise<string> {
  const resp = await gmFetch(BASE_URL.ANTHROPIC_MESSAGES, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey.trim(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: opts.model.trim(),
      max_tokens: opts.maxTokens ?? 256,
      system: [{ type: 'text', text: opts.systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: opts.userText }],
    }),
    timeoutMs: 30000,
    signal: opts.signal,
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim())
  }
  const content = readAnthropicContent(resp.json())
  if (!content) throw new Error('返回内容为空')
  return content
}

/**
 * Generic chat-completion entry used by the YOLO text-polish feature.
 *
 * Returns the assistant's content string verbatim — caller is expected to
 * trim / dequote / size-cap as appropriate for the surface (danmaku 40-char
 * cap, etc.). Throws user-readable Chinese errors so the call site can pipe
 * them straight into appendLog / status text.
 *
 * Routes through `gm-fetch` (GM_xmlhttpRequest) so cross-origin calls to
 * Anthropic / OpenAI / DeepSeek / Moonshot / OpenRouter work without CORS
 * pre-flight failures — same constraint as the meme-picking code above.
 */
export function chatCompletionViaLlm(opts: ChatCompletionOptions): Promise<string> {
  if (!opts.apiKey.trim()) return Promise.reject(new Error('请先配置 API key'))
  if (!opts.model.trim()) return Promise.reject(new Error('请先选择模型'))
  if (!opts.systemPrompt.trim()) return Promise.reject(new Error('系统提示词为空'))
  if (!opts.userText.trim()) return Promise.reject(new Error('输入内容为空'))

  if (opts.provider === 'anthropic') return postAnthropicPolish(opts)
  if (opts.provider === 'openai') return postOpenAIChatPolish(opts)

  // openai-compat
  const base = (opts.baseURL ?? '').trim()
  if (!base) return Promise.reject(new Error('openai-compat 需要填 base URL（在「智能辅助驾驶」里设置）'))
  return postOpenAIChatPolish(opts, buildOpenAICompatChatURL(base))
}

/**
 * Pull a clean id (digits or "-1") out of the model's raw text response.
 *
 * Despite the system prompt saying "no markdown, just the id", real models do
 * all of these:
 *   - `1`                                    → "1"
 *   - `"1"`                                  → "1"
 *   - `\`\`\`json\n{"id":"1"}\n\`\`\``       → "1"  (Xiaomi MiMo loves this)
 *   - `{"id": "1"}`                          → "1"
 *   - `Selected id: 1`                       → "1"
 *   - `-1`                                   → "-1"
 *
 * Strategy: try JSON first (handles structured wrappings), then fall back to a
 * regex on the raw string to pluck the first id-like token.
 */
export function normalizeIdFromLlmOutput(raw: string): string | null {
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
  if (!stripped) return null

  try {
    const parsed = JSON.parse(stripped) as unknown
    if (typeof parsed === 'string') return parsed.trim() || null
    if (typeof parsed === 'number') return String(parsed)
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>).id
      if (typeof v === 'string') return v.trim() || null
      if (typeof v === 'number') return String(v)
    }
  } catch {
    // not JSON, fall through to regex
  }

  const m = stripped.match(/-1|\d+/)
  return m ? m[0] : null
}
