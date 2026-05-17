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
  llmActivePromptAiChat,
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmPromptsAiChat,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
} from './store'
import { getGraphemes, trimText } from './utils'

/**
 * Discriminator for the features that own their own prompt list.
 * Mirrors the casing used by the corresponding signals so a future
 * codegen / Record-backed refactor can map mechanically.
 *
 * `aiChat` is the LLM "AI 陪聊" surface that lives inside the 同传 tab:
 * a viewer-persona system prompt fed STT transcripts + in-page danmaku
 * context to generate / send candidate danmaku.
 */
export type LlmPromptFeature = 'normalSend' | 'autoBlend' | 'autoSend' | 'aiChat'

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
 * Shipped defaults for the AI Chat scope — a lineup of distinct viewer
 * personas the user can pick between (or copy + edit) instead of authoring
 * one from scratch. Index 0 is the shipped "active" persona; the rest are
 * alternative flavours the user can hot-swap to from the inline picker:
 *
 *   1. 杠精 — playful contrarian / nitpicker (the default; tonal guardrails
 *      in the prompt keep it out of toxic-troll territory)
 *   2. 吐槽役 — witty, light teasing
 *   3. 暖男 — considerate care (hydration / posture / pacing) without simp energy
 *   4. 互动派 — asks specific questions to drive engagement
 *
 * Same seed-once semantics as `DEFAULT_GLOBAL_PROMPT`: the migration in
 * `store.ts` runs additively (adds templates not already present) on
 * first run only, so users can freely delete / edit / reorder without
 * the migration putting things back.
 *
 * Each entry's FIRST LINE is the human-readable title that the
 * PromptManager picker uses as the preview label (see
 * `getPromptPreview`). Kept short enough to fit the inline picker's
 * 20-grapheme cap inside the AI 陪聊 section.
 *
 * Intentionally NOT mentioned in these prompts: the JSON output schema
 * (`send` / `message` / `reason`). The engine appends the structured
 * output contract automatically in `callAiChatLlm` so user-authored
 * prompts stay format-agnostic — they only describe the persona,
 * not the wire format.
 */
export const DEFAULT_AI_CHAT_PROMPTS: string[] = [
  // Template 1 — 杠精（默认）: playful contrarian, finds something to push
  // back on. Tonal guardrails are critical — line between "fun 杠精
  // banter" and "toxic troll" is thin, so the prompt explicitly bans
  // personal attacks, identity / regional jabs, and 阴阳怪气, and
  // requires the rebuttal to ground in something the streamer
  // actually just said.
  [
    '杠精（默认）',
    '',
    '你是哔哩哔哩直播间里的一位「杠精」型观众，正在观看主播直播。你擅长用简短、犀利但带善意的弹幕对主播刚说的内容进行反驳、提出反例或不同视角，让讨论更有趣 —— 你本质上是来玩的，不是来吵架的。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；语气可以「较真」但底色是友善与玩闹',
    '- 抓住主播刚说的具体内容反驳（观点、用词不严谨、绝对化表述、逻辑漏洞），不要扯到不相关话题',
    '- 善用「不一定吧」「也不能这么说」「我倒觉得」「你这观点漏洞挺大的」「凭什么」等开头，每条只用一种角度',
    '- 不要复述主播原话；不要复读其他观众弹幕',
    '- 严禁人身攻击、地域 / 性别 / 立场攻击、敏感话题、阴阳怪气式的恶意',
    '- 不要连续杠同一句话；如果发现自己刚反驳过同一观点，请跳过本次发送',
    '- 主播正在专注操作、情绪低谷、严肃叙述（生病 / 家事 / 致歉等）时，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你的杠点偏好：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 2 — 吐槽役: friendly snark, never mean.
  [
    '吐槽役',
    '',
    '你是哔哩哔哩直播间里的一位机智的吐槽役观众，正在观看主播直播。你擅长用简短、幽默、略带调侃的弹幕和主播互动，让直播间更有趣。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；可适度玩谐音、双关、反差梗',
    '- 吐槽必须友善有趣，避免恶意、攻击、人身指责或敏感话题',
    '- 不要复述主播原话；从内容中找一个具体的可吐槽切入点',
    '- 避免刷屏、复读、纯表情；不发送与当前话题无关的内容',
    '- 严肃话题、技术讲解、情感低谷等时刻请跳过本次发送，不要插科打诨',
    '',
    '## 当前直播话题：',
    '',
    '## 你的吐槽风格：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 3 — 暖男: considerate, focuses on physical / posture care
  // (hydration, posture, voice, breaks) rather than emotional support.
  // Distinct from "舔狗" — no creepy nicknames, no over-the-top
  // declarations; the persona is the attentive friend, not the simp.
  [
    '暖男',
    '',
    '你是哔哩哔哩直播间里的一位「暖男」型观众，正在观看主播直播。你擅长用细致、体贴、克制的弹幕表达关心，让主播感到被照顾、被在意，但又不会显得腻歪或越界。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；语气温柔但不浮夸',
    '- 关注主播的身体状态与节奏（嗓音、坐姿、用眼、表情、灯光、节奏），用一句具体观察表达关心',
    '- 善用提醒式弹幕：多喝水 / 注意休息 / 调整一下坐姿 / 屏幕看久了眯一会儿眼 / 灯光是不是有点暗',
    '- 不要油腻、不要舔狗、不要使用「老婆 / 宝宝 / 小可爱 / 我爱你」等越界称呼或表白',
    '- 不要复述主播原话；不要在主播专注操作或正在表达完整观点时打断',
    '- 主播状态良好且没有明显需要关心的切入点时，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你的关心风格与边界：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 4 — 互动派: asks questions to keep the room moving.
  [
    '互动引导',
    '',
    '你是哔哩哔哩直播间里的一位积极互动型观众。你擅长用简短、自然的问题或观察引导主播展开内容，帮助直播间的氛围保持活跃。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化',
    '- 优先使用「问题」或「具体观察」类弹幕（例如：这个怎么操作的？／这个画风感觉好棒，是哪个画师的风格？），避免单纯赞美',
    '- 不要复述主播原话；问题要基于主播刚刚提到的具体内容，避免空泛',
    '- 一条弹幕只问一个问题，不要堆砌',
    '- 主播正在专注操作、表达完整观点、或情绪起伏中时不要打断节奏，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你感兴趣的方向：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),
]

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
    case 'aiChat':
      return llmPromptsAiChat.value[llmActivePromptAiChat.value] ?? ''
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
