/**
 * Per-feature LLM prompt accessors.
 *
 * The settings UI lets users author multiple prompt drafts per scope
 * (一份 shared "global" baseline + 常规发送 / 自动融入 / 独轮车) and pick
 * one per scope as "active". Future LLM call sites — chat-completions,
 * summarisation, danmaku rewriting, etc. — read the active prompt via
 * `getActiveLlmPrompt` so they stay decoupled from the underlying signal
 * pairs in `store.ts` and from the global-vs-feature concat policy
 * implemented here.
 *
 * Lives in its own module (rather than inside `llm.ts`) so the LLM API
 * client can avoid pulling in `store.ts` and the GM-storage runtime —
 * useful when we later want to reuse `llm.ts` from a worker or test
 * harness that doesn't have a GM context.
 */

import {
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
} from './store'
import { getGraphemes, trimText } from './utils'

/**
 * Discriminator for the three features that own their own prompt list.
 * Mirrors the casing used by the corresponding signals so a future
 * codegen / Record-backed refactor can map mechanically.
 */
export type LlmPromptFeature = 'normalSend' | 'autoBlend' | 'autoSend'

/** Default cap on how many graphemes of the first line we surface as a
 *  preview. 24 fits comfortably in the full-width Settings PromptManager
 *  picker; inline pickers (e.g. the normal-send tab's quick switcher)
 *  pass a smaller value so the dropdown doesn't dominate the row. */
const DEFAULT_PROMPT_PREVIEW_GRAPHEMES = 24

/**
 * Build a short, human-readable preview of a prompt draft: the first
 * non-empty line, grapheme-trimmed with an ellipsis when longer than
 * `maxGraphemes`. Empty drafts surface as `(空)` so they remain
 * pickable in selectors rather than rendering as a blank row.
 *
 * Shared between the settings PromptManager and the inline prompt
 * switchers in feature tabs so the same draft reads identically
 * everywhere it's surfaced. Separate from `auto-send-controls`'
 * `getPreview` (which uses a 10-grapheme cap for the danmaku template
 * picker) — that helper predates this one and stays local to that
 * module to avoid bundling a refactor of an unrelated feature here.
 */
export function getPromptPreview(prompt: string, maxGraphemes = DEFAULT_PROMPT_PREVIEW_GRAPHEMES): string {
  const firstLine = (prompt.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > maxGraphemes ? `${trimText(firstLine, maxGraphemes)[0]}…` : firstLine
}

// LLM prompts. Each scope (the shared "global" baseline + each feature)
// owns an independent list of prompt drafts and an index into that list,
// mirroring how `msgTemplates` + `activeTemplateIndex` work for the 独轮车
// template editor — the user authored the same UX request for prompts.
// Persisted as separate arrays (not a Record) so a corrupted entry for
// one scope can't invalidate the others, and so individual signals can be
// diffed cheaply inside the UI without recomputing untouched siblings.
//
// The "global" scope is prepended to every feature's prompt at call time
// (see `getActiveLlmPrompt` in lib/prompts.ts), so call sites don't have
// to know about the chain. The feature-specific prompt is what actually
// triggers an LLM call — global alone never does, since the LLM wouldn't
// know what task to perform.

// Shipped default for the global scope so the LLM section is useful out
// of the box rather than presenting an empty editor with only a
// placeholder for guidance. Goes through the standard PromptManager UI
// — the user can edit it freely, add more, or delete it outright; the
// seed-once migration below WON'T put it back if they delete it.
//
// Exported in case future UI (e.g. a "restore default" button) wants to
// reference it. Authored as a multi-line string with bullet points
// because the Bilibili 弹幕 use case has several independent constraints
// (length, formatting, sensitive words) that are easier to scan as a
// list than as run-on prose.
export const DEFAULT_GLOBAL_PROMPT = [
  '你是哔哩哔哩直播间的弹幕优化助手，根据用户的输入内容，完全遵循用户的修改提示，输出相应的内容，并遵循以下基本约定：',
  '',
  '- 单条弹幕请控制在 40 字以内，使用自然口语化的中文',
  '- 不要使用 Markdown、列表、不要包裹引号或代码块',
  '- 直接输出最终弹幕文本，不要包含解释、前缀或多余空白，结尾不带句号',
].join('\n')

/**
 * Joiner between the global prompt and the feature prompt. Double newline
 * reads as a paragraph break to most chat models, which is what we want:
 * the global prompt and the feature prompt are conceptually separate
 * blocks (system-style baseline + task-specific instructions) but should
 * arrive in the same message, not split into multiple turns.
 */
const PROMPT_SEPARATOR = '\n\n以下是用户的修改提示：\n\n'

/**
 * Read the active feature-specific prompt with NO global prefix. Useful
 * for UIs that want to show just the feature's own draft (e.g. the
 * settings editor itself), or for call sites that need to introspect
 * the raw text without the shared baseline noise.
 */
export function getActiveFeaturePrompt(feature: LlmPromptFeature): string {
  switch (feature) {
    case 'normalSend':
      return llmPromptsNormalSend.value[llmActivePromptNormalSend.value] ?? ''
    case 'autoBlend':
      return llmPromptsAutoBlend.value[llmActivePromptAutoBlend.value] ?? ''
    case 'autoSend':
      return llmPromptsAutoSend.value[llmActivePromptAutoSend.value] ?? ''
  }
}

/** Read the active global prompt, or empty string if none is set. */
export function getActiveGlobalPrompt(): string {
  return llmPromptsGlobal.value[llmActivePromptGlobal.value] ?? ''
}

/**
 * Read the full prompt to send to the LLM for `feature`: the active
 * global prompt prepended to the active feature prompt, separated by a
 * paragraph break.
 *
 * Returns empty when the feature has no active prompt — the feature
 * prompt is the trigger, since global alone never engages the LLM
 * (the model wouldn't know what task to perform). Whitespace-only
 * feature drafts also count as "no prompt", so a user accidentally
 * leaving a blank line in the active slot doesn't fire a useless API
 * call. Whitespace inside non-empty drafts is preserved verbatim — the
 * user may have intentional formatting.
 */
export function getActiveLlmPrompt(feature: LlmPromptFeature): string {
  const featurePrompt = getActiveFeaturePrompt(feature)
  if (!featurePrompt.trim()) return ''
  const globalPrompt = getActiveGlobalPrompt()
  if (!globalPrompt.trim()) return featurePrompt
  return `${globalPrompt}${PROMPT_SEPARATOR}${featurePrompt}`
}
