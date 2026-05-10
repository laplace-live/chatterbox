/**
 * High-level LLM tasks the rest of the app composes against.
 *
 * Bridges three otherwise-decoupled layers:
 *   - API client         (`lib/llm.ts`)
 *   - prompt accessors   (`lib/prompts.ts`)
 *   - persisted config   (`lib/store.ts` — base/key/model)
 *
 * Lives in its own module so feature code (UI handlers, loop hooks,
 * etc.) doesn't have to wire those three together every time it wants
 * to invoke the LLM, AND so the low-level `lib/llm.ts` stays pure
 * (no app-state imports = trivially reusable from a worker / test).
 */

import { chatCompletion } from './llm'
import { getActiveLlmPrompt, type LlmPromptFeature } from './prompts'
import { llmApiBase, llmApiKey, llmModel } from './store'

/**
 * Strip a single layer of matched surrounding quotes from the LLM's
 * response. Many models — even with explicit "no quotes" instructions —
 * habitually wrap their output. We dequote conservatively (only when
 * the SAME pair bookends the text) so a sentence containing an
 * unmatched quote isn't damaged.
 *
 * Pairs ordered most-to-least common so we exit early on the typical
 * case. Each pair is `[open, close]`; for symmetric quotes open === close.
 */
function dequote(text: string): string {
  const PAIRS: Array<[string, string]> = [
    ['"', '"'],
    ['\u201C', '\u201D'], // smart double quote
    ["'", "'"],
    ['\u2018', '\u2019'], // smart single quote
    ['「', '」'],
    ['『', '』'],
    ['`', '`'],
  ]
  for (const [open, close] of PAIRS) {
    if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim()
    }
  }
  return text
}

/**
 * Human-readable label for each feature, used inside `describeLlmGap`'s
 * "configure prompt" hint so the user lands on the right Settings
 * subsection. Must mirror the headings actually rendered in
 * `settings-tab.tsx` — drift here is invisible until a user clicks
 * the link in their head and finds nothing matching the heading.
 */
const FEATURE_LABELS: Record<LlmPromptFeature, string> = {
  normalSend: '常规发送',
  autoBlend: '自动融入',
  autoSend: '独轮车',
}

/**
 * Whether the bare API config (base + key + model) is filled in. Does
 * NOT check whether any prompt is set — useful when a UI wants to show
 * an inline prompt picker even before the user has selected a non-empty
 * draft (so they can recover by switching to one).
 */
export function isLlmApiConfigured(): boolean {
  return !!llmApiBase.value.trim() && !!llmApiKey.value.trim() && !!llmModel.value.trim()
}

/**
 * Inspect the LLM config and produce a *specific* hint for what the
 * user needs to fix before AI features become usable for `feature`.
 * Returns a string when something's missing (so the call site can drop
 * it straight into a tooltip / log line / status message) or `null`
 * when everything's in place.
 *
 * Order matches the visual order of the settings sections so the user
 * fixes things top-down: API base → API key → model → feature prompt.
 *
 * Reads signals during the call so any component using this in its
 * render body subscribes to all of them — the returned string updates
 * automatically as the user fixes config in another tab.
 */
export function describeLlmGap(feature: LlmPromptFeature): string | null {
  if (!llmApiBase.value.trim()) return '请先在「设置 → LLM 设置」中填写 API 地址'
  if (!llmApiKey.value.trim()) return '请先在「设置 → LLM 设置」中填写 API Key'
  if (!llmModel.value.trim()) return '请先在「设置 → LLM 设置」中选择模型'
  if (!getActiveLlmPrompt(feature).trim()) {
    return `请先在「设置 → LLM 提示词 → ${FEATURE_LABELS[feature]}」中配置提示词`
  }
  return null
}

/**
 * Whether the LLM is fully configured to actually be called RIGHT NOW
 * for `feature`. Derived from `describeLlmGap` so the boolean version
 * and the string-hint version can never disagree about what counts as
 * "ready".
 */
export function isLlmReady(feature: LlmPromptFeature): boolean {
  return describeLlmGap(feature) === null
}

/**
 * Polish (rewrite) the user's text via the configured LLM, using the
 * active combined prompt for `feature` (which already includes the
 * global prefix injected by `getActiveLlmPrompt`). Returns the cleaned
 * polished text — trimmed and dequoted — ready to drop straight into
 * a danmaku payload.
 *
 * Throws specific errors when the LLM isn't usable (no prompt, no API
 * base/key, no model, empty input) so callers can pipe the message
 * straight into `appendLog` / a status line. AbortError is propagated
 * untouched.
 */
export async function polishWithLlm(
  feature: LlmPromptFeature,
  userText: string,
  opts: { signal?: AbortSignal } = {}
): Promise<string> {
  const systemPrompt = getActiveLlmPrompt(feature)
  if (!systemPrompt.trim()) {
    // Distinguish "feature prompt missing" from "API config missing"
    // — both are user-fixable but live in different settings sections.
    throw new Error('当前功能未配置 LLM 提示词')
  }

  const trimmedUser = userText.trim()
  if (!trimmedUser) throw new Error('输入内容为空')

  const response = await chatCompletion({
    base: llmApiBase.value,
    apiKey: llmApiKey.value,
    model: llmModel.value,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: trimmedUser },
    ],
    signal: opts.signal,
  })
  return dequote(response.trim())
}
