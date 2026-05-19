/**
 * AI 润色（原代号 YOLO）提示词访问层。
 *
 * 把"全局基线 + 功能特定"的拼接策略集中在这里，调用方（llm-polish.ts、UI 的
 * PromptManager / PromptPicker）只看 `getActiveLlmPrompt(feature)` 一个入口，
 * 不需要知道底下的 8 个 signal 各自的角色。
 *
 * 单独成模块（而不是塞进 store-llm.ts）是为了让低层的 `llm-driver.ts` /
 * `chatCompletionViaLlm` 不强依赖 GM 存储的 signal — 那一层将来可能从 worker /
 * 测试 harness 里被调用，没有 GM 上下文。
 *
 * 设计参考自 upstream chatterbox 090bd1e（PromptManager + 单独 prompts 模块）。
 */

import { llmActivePromptAiCandidate, llmPromptsAiCandidate } from './store-ai-candidate'
import {
  DEFAULT_FEATURE_PROMPT_AUTO_BLEND,
  DEFAULT_FEATURE_PROMPT_AUTO_SEND,
  DEFAULT_FEATURE_PROMPT_NORMAL_SEND,
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
} from './store-llm'
import { getGraphemes, trimText } from './utils'

/**
 * 用 LLM 的四个场景。Discriminator，跟 store-llm.ts / store-ai-candidate.ts
 * 的 signal 命名对齐。
 *
 * - `normalSend / autoBlend / autoSend` 都是「用户先有意图，AI 润色」类
 * - `aiCandidate` 是「AI 提议候选，用户审核确认才发」 —— Review-only，**没有**
 *   也不会有 auto-send 路径（设计约束，见 store-ai-candidate.ts）
 */
export type LlmPromptFeature = 'normalSend' | 'autoBlend' | 'autoSend' | 'aiCandidate'

/**
 * 系统默认提示词的 runtime fallback。
 *
 * normalSend / autoBlend / autoSend 三档：从 v2.14.2 起，这些默认值会在首次
 * 安装时**seed 进 GM 存储的 prompt 列表**（见 store-llm.ts 的 seedPromptIfMissing），
 * 所以用户打开「设置 → LLM 提示词」编辑器就能看到、编辑、删除。这套 fallback
 * 留下来只为兜住一个边缘情况：用户**主动清空**了某档的整个 array，又开启了
 * AI 润色——此时 runtime 不再因"无 prompt"报错回退原文，而是悄悄用这套
 * 默认跑（不写回 GM 存储；sentinel 已 set，不会被还原）。
 *
 * aiCandidate：跟其它三档不同，它的真正默认 prompt 是 4-persona 列表
 * （`DEFAULT_AI_CANDIDATE_PROMPTS` in `store-ai-candidate.ts`），从 v2.14.1
 * 起就 seed 进 array。这里给的 fallback 只是用户把 4 个 persona 全删空 +
 * 没选任何索引时的最后兜底。
 *
 * 三档功能 prompt 文本本体在 `store-llm.ts` 集中维护——既是 seed 源，也是
 * 这里的 fallback 源，避免文案两处同步。
 */
export const DEFAULT_FEATURE_PROMPTS: Record<LlmPromptFeature, string> = {
  normalSend: DEFAULT_FEATURE_PROMPT_NORMAL_SEND,
  autoBlend: DEFAULT_FEATURE_PROMPT_AUTO_BLEND,
  autoSend: DEFAULT_FEATURE_PROMPT_AUTO_SEND,
  aiCandidate:
    '你是哔哩哔哩直播间里的一位观众，正在观看主播直播。请根据上下文生成一条自然、真诚、像真实观众的弹幕。不要复读、不要敏感话题、不要恶意攻击。当前内容不适合发弹幕时，请明示放弃。',
}

/**
 * 提示词预览的默认显示长度（字素，graphemes）。24 在设置面板的全宽
 * PromptManager 里读起来舒服；功能内嵌的 PromptPicker 可传更小的值，避免
 * 下拉菜单挤占整行。
 */
const DEFAULT_PROMPT_PREVIEW_GRAPHEMES = 24

/**
 * 给提示词草稿生成一个简短的预览文本：取第一非空行，按字素数截断。
 *
 * 空草稿统一渲染为 `(空)`，让选择器里仍然可点而不是空白行。所有 PromptManager
 * 与 PromptPicker 都走这一个函数，保证同一份草稿在所有地方读起来都一致。
 */
export function getPromptPreview(prompt: string, maxGraphemes = DEFAULT_PROMPT_PREVIEW_GRAPHEMES): string {
  const firstLine = (prompt.split('\n')[0] ?? '').trim()
  if (!firstLine) return '(空)'
  return getGraphemes(firstLine).length > maxGraphemes ? `${trimText(firstLine, maxGraphemes)[0]}…` : firstLine
}

/**
 * 当前激活的功能特定提示词的**原始**用户值(不含 fallback,不含全局前缀)。
 *
 * 给设置 UI 的提示词编辑器显示用——编辑器需要看到"用户实际写的内容"
 * (可以是空字符串),而不是默认值。索引越界时回退到空字符串。
 *
 * **运行时调用 `getActiveLlmPrompt` 而不是这个**——那个会自动用 #21 的
 * 默认 prompt 兜底。
 */
export function getActiveFeaturePromptRaw(feature: LlmPromptFeature): string {
  switch (feature) {
    case 'normalSend':
      return llmPromptsNormalSend.value[llmActivePromptNormalSend.value] ?? ''
    case 'autoBlend':
      return llmPromptsAutoBlend.value[llmActivePromptAutoBlend.value] ?? ''
    case 'autoSend':
      return llmPromptsAutoSend.value[llmActivePromptAutoSend.value] ?? ''
    case 'aiCandidate':
      return llmPromptsAiCandidate.value[llmActivePromptAiCandidate.value] ?? ''
    default:
      return ''
  }
}

/**
 * 当前激活的功能特定提示词,**用户空 → 用默认 prompt 兜底**(Jobs 式 #21)。
 *
 * 这是运行时 polishWithLlm / describeLlmGap 该调的版本:用户没配置时,
 * 不再"提示词缺失"报错,而是用一句保守的默认 prompt 让 AI 润色仍可用。
 */
export function getActiveFeaturePrompt(feature: LlmPromptFeature): string {
  const userPrompt = getActiveFeaturePromptRaw(feature)
  if (userPrompt.trim()) return userPrompt
  return DEFAULT_FEATURE_PROMPTS[feature]
}

/** 当前激活的全局提示词，没设则为空字符串。 */
export function getActiveGlobalPrompt(): string {
  return llmPromptsGlobal.value[llmActivePromptGlobal.value] ?? ''
}

/**
 * 全局基线 + 功能特定的拼接 separator。双换行让模型把它读成段落分隔；标注
 * "以下是用户的修改提示" 让大多数模型清楚后面这一段才是要执行的具体任务，
 * 而不是把全局基线当成示例去模仿。
 */
const PROMPT_SEPARATOR = '\n\n以下是用户的修改提示：\n\n'

/**
 * 生成实际要发给 LLM 的 system prompt：激活的全局基线 + separator + 激活的
 * 功能特定提示词。功能提示词为空则返回 ""，调用方据此决定是否跳过 LLM 调用
 * （单纯的 global 不足以让模型知道要执行什么任务，没意义浪费 token）。
 */
export function getActiveLlmPrompt(feature: LlmPromptFeature): string {
  const featurePrompt = getActiveFeaturePrompt(feature)
  if (!featurePrompt.trim()) return ''
  const globalPrompt = getActiveGlobalPrompt()
  if (!globalPrompt.trim()) return featurePrompt
  return `${globalPrompt}${PROMPT_SEPARATOR}${featurePrompt}`
}
