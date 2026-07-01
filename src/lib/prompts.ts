/**
 * Per-feature LLM prompt accessors. Separate from `llm.ts` so the API
 * client needn't pull in `store.ts`/the GM-storage runtime.
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

/** Features that own their own prompt list; casing mirrors the signals. */
export type LlmPromptFeature = 'normalSend' | 'autoBlend' | 'autoSend' | 'aiChat'

/** Default preview cap in graphemes; inline pickers pass a smaller value. */
const DEFAULT_PROMPT_PREVIEW_GRAPHEMES = 24

/**
 * Preview of a prompt draft: first non-empty line, grapheme-trimmed with
 * an ellipsis past `maxGraphemes`. Empty drafts return `(空)` so they stay
 * pickable rather than rendering as a blank row.
 */
export function getPromptPreview(prompt: string, maxGraphemes = DEFAULT_PROMPT_PREVIEW_GRAPHEMES): string {
  const firstLine = (prompt.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > maxGraphemes ? `${trimText(firstLine, maxGraphemes)[0]}…` : firstLine
}

// Each scope persists a separate array (not a Record) so a corrupted
// entry for one scope can't invalidate the others. Global is prepended to
// every feature prompt at call time; the feature prompt is the trigger,
// global alone never fires a call.

/** Shipped default global prompt; seed-once migration won't restore it if deleted. */
export const DEFAULT_GLOBAL_PROMPT = [
  '你是哔哩哔哩直播间的弹幕优化助手，根据用户的输入内容，完全遵循用户的修改提示，输出相应的内容，并遵循以下基本约定：',
  '',
  '- 使用自然口语化的中文，单条弹幕必须在 40 字以内，但不要凑字数',
  '- 不要使用 Markdown、列表、不要包裹引号或代码块',
  '- 直接输出最终弹幕文本，不要包含解释、前缀或多余空白，结尾不带句号',
].join('\n')

/**
 * Shipped default AI Chat viewer personas; index 0 is the active one.
 * Seed-once semantics like `DEFAULT_GLOBAL_PROMPT`. Each entry's first line
 * is the picker's title label. The JSON output schema is deliberately
 * absent — `callAiChatLlm` appends the structured-output contract itself,
 * so these stay format-agnostic.
 */
export const DEFAULT_AI_CHAT_PROMPTS: string[] = [
  // Tonal guardrails matter: the line between fun banter and toxic troll
  // is thin, hence the explicit bans and the ground-in-what-was-said rule.
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

/** Joiner between global and feature prompts; blank lines read as a paragraph break. */
const PROMPT_SEPARATOR = '\n\n以下是用户的修改提示：\n\n'

/** Read the active feature-specific prompt with no global prefix. */
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
 * Full LLM prompt for `feature`: active global prefixed to active feature.
 * Empty (whitespace-only counts) feature prompt returns '' since the
 * feature prompt is the trigger. Whitespace inside non-empty drafts is
 * preserved verbatim.
 */
export function getActiveLlmPrompt(feature: LlmPromptFeature): string {
  const featurePrompt = getActiveFeaturePrompt(feature)
  if (!featurePrompt.trim()) return ''
  const globalPrompt = getActiveGlobalPrompt()
  if (!globalPrompt.trim()) return featurePrompt
  return `${globalPrompt}${PROMPT_SEPARATOR}${featurePrompt}`
}
