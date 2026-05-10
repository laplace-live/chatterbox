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

/**
 * Discriminator for the three features that own their own prompt list.
 * Mirrors the casing used by the corresponding signals so a future
 * codegen / Record-backed refactor can map mechanically.
 */
export type LlmPromptFeature = 'normalSend' | 'autoBlend' | 'autoSend'

/**
 * Joiner between the global prompt and the feature prompt. Double newline
 * reads as a paragraph break to most chat models, which is what we want:
 * the global prompt and the feature prompt are conceptually separate
 * blocks (system-style baseline + task-specific instructions) but should
 * arrive in the same message, not split into multiple turns.
 */
const PROMPT_SEPARATOR = '\n\n'

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
