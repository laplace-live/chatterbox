/** High-level LLM tasks bridging the API client, prompt accessors, and persisted config so `lib/llm.ts` stays app-state-free. */

import { chatCompletion } from './llm'
import { getActiveLlmPrompt, type LlmPromptFeature } from './prompts'
import { activeLlmProvider } from './store'

/** Strip one layer of matched surrounding quotes; models wrap output despite instructions. Only when the same pair bookends the text, so unmatched quotes survive. */
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

/** Human-readable label per feature for `describeLlmGap`'s hint; must mirror the headings in `settings-tab.tsx` (drift is silent). */
const FEATURE_LABELS: Record<LlmPromptFeature, string> = {
  normalSend: '常规发送',
  autoBlend: '自动融入',
  autoSend: '独轮车',
  aiChat: 'AI 融入',
}

/** Whether the active provider's API config (base + key + model) is filled in; does NOT check any prompt. */
export function isLlmApiConfigured(): boolean {
  const p = activeLlmProvider.value
  return !!p && !!p.apiBase.trim() && !!p.apiKey.trim() && !!p.model.trim()
}

/**
 * Specific hint for what to fix before `feature` is usable, or `null` when ready.
 * Checks in settings-section order; reads signals so render-body callers auto-subscribe.
 */
export function describeLlmGap(feature: LlmPromptFeature): string | null {
  const p = activeLlmProvider.value
  if (!p) return '请先在「设置 → LLM 设置」中添加服务商'
  if (!p.apiBase.trim()) return '请先在「设置 → LLM 设置」中填写 API 地址'
  if (!p.apiKey.trim()) return '请先在「设置 → LLM 设置」中填写 API Key'
  if (!p.model.trim()) return '请先在「设置 → LLM 设置」中选择模型'
  if (!getActiveLlmPrompt(feature).trim()) {
    return `请先在「设置 → LLM 提示词 → ${FEATURE_LABELS[feature]}」中配置提示词`
  }
  return null
}

/** Whether the LLM is callable now for `feature`; derived from `describeLlmGap` so the two can't disagree. */
export function isLlmReady(feature: LlmPromptFeature): boolean {
  return describeLlmGap(feature) === null
}

/**
 * Rewrite the user's text via the configured LLM; returns trimmed, dequoted output.
 * Throws specific user-facing errors when unusable; AbortError propagates untouched.
 */
export async function polishWithLlm(
  feature: LlmPromptFeature,
  userText: string,
  opts: { signal?: AbortSignal } = {}
): Promise<string> {
  const systemPrompt = getActiveLlmPrompt(feature)
  if (!systemPrompt.trim()) {
    // Distinct from "API config missing": they live in different settings sections.
    throw new Error('当前功能未配置 LLM 提示词')
  }

  const trimmedUser = userText.trim()
  if (!trimmedUser) throw new Error('输入内容为空')

  const provider = activeLlmProvider.value
  if (!provider) throw new Error('未配置 LLM 服务商')

  const response = await chatCompletion({
    base: provider.apiBase,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: trimmedUser },
    ],
    signal: opts.signal,
  })
  return dequote(response.trim())
}
