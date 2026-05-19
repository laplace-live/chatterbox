/**
 * YOLO 文本润色高层入口。
 *
 * 把三层胶起来：
 *   - 持久化的 LLM 配置 (`store-llm.ts` 的 llmProvider/key/model/baseURL；同一套
 *     凭证既给智能辅助驾驶选梗用，也给 YOLO 润色用，配置一次两用)
 *   - 提示词访问 (`prompts.ts`)
 *   - 调用层 (`llm-driver.ts` 的 `chatCompletionViaLlm`)
 *
 * 单独成模块，让发送链路（auto-blend / loop / danmaku-actions）只用一两行就能
 * 接 YOLO，而无需各自重复"读 signal + 拼提示词 + 调 LLM + 清洗结果"的胶水。
 *
 * 设计参考自 upstream chatterbox 3914ec6（llm-tasks.ts 的 polishWithLlm + isLlmReady
 * + describeLlmGap 三件套）。
 */

import { chatCompletionViaLlm } from './llm-driver'
import { getActiveLlmPrompt, type LlmPromptFeature } from './prompts'
import { llmApiKey, llmBaseURL, llmModel, llmProvider } from './store-llm'

// 注：llm-driver 同时也被 hzm-auto-drive 通过 `await import(...)` 懒加载用作智驾
// 选梗。这里改用静态导入,与 send 路径一并打进主 chunk——vite-plugin-monkey 把
// 一切打成单个 user.js,所以"懒加载"在 userscript 上没有真正意义；反而会因为
// 重复发射 chunk 让总体积变大（实测：lazy 1068KB > eager 989KB）。这里以"主
// chunk 多一份 ~10KB 的 driver 代码"换"总下载量 -80KB"的 trade-off。

/**
 * 模型经常用引号包裹结果（即便 system prompt 明确说"不要用引号"）。剥一层
 * 配对的引号——只在前后是同一对引号时剥，不破坏内含未配对引号的句子。
 *
 * 引号对按"最常见 → 较罕见"排序，一旦命中立即返回，避免对包了多层的字符串
 * 多次循环（如果发生，那也是模型调皮，剥一层就够了不用层层剥光）。
 */
function dequote(text: string): string {
  const PAIRS: Array<[string, string]> = [
    ['"', '"'],
    ['“', '”'], // “ ”
    ["'", "'"],
    ['‘', '’'], // ‘ ’
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
 * 给三个 AI 润色（原代号 YOLO）功能各自的人类可读标签。出现在 describeLlmGap
 * 的提示文案里（"请先在「设置 → LLM 提示词 → 自动跟车」中配置提示词"），与
 * settings-tab 渲染的小标题对齐。drift 的代价就是一个 settings-tab 的拼写错误
 * 而已，所以没有抽出共用 const。
 */
const FEATURE_LABELS: Record<LlmPromptFeature, string> = {
  normalSend: '手动发送',
  autoBlend: '自动跟车',
  autoSend: '独轮车',
  aiCandidate: 'AI 陪聊（候选）',
}

/**
 * 仅检查 LLM 的 base API 是否填好了（key + model + 必要时的 baseURL）。
 *
 * 与 isLlmReady 的差异：这里不要求功能提示词存在——UI 里"提示词选择器"
 * 想在功能提示词为空时也允许用户切到非空草稿，这种场景下我们要把"功能提示词
 * 缺失"作为可恢复的状态展示，而不是把整个面板灰掉。
 */
export function isLlmApiConfigured(): boolean {
  return (
    llmApiKey.value.trim() !== '' &&
    llmModel.value.trim() !== '' &&
    (llmProvider.value !== 'openai-compat' || llmBaseURL.value.trim() !== '')
  )
}

/**
 * 看 LLM 配置 + 提示词，给一段 *具体* 的中文提示告诉用户应该去哪里补设置。
 * 全部齐全则返回 null，调用方据此决定是否把 AI 润色（原代号 YOLO）真的执行起来。
 *
 * 顺序贴合 settings 视觉顺序：API key → 模型 → openai-compat baseURL → 功能
 * 提示词。读的全是 signal，所以在 UI 渲染体里调用会自动订阅；用户在另一个
 * 面板修好配置后，这里返回的字符串会自动更新。
 */
export function describeLlmGap(feature: LlmPromptFeature): string | null {
  if (!llmApiKey.value.trim()) return '请先在「设置 → LLM → API key」中配置 LLM 凭证'
  if (!llmModel.value.trim()) return '请先在「设置 → LLM → 模型」中选择模型'
  if (llmProvider.value === 'openai-compat' && !llmBaseURL.value.trim()) {
    return '请先在「设置 → LLM → base URL」中填入 openai-compat 的接口地址'
  }
  if (!getActiveLlmPrompt(feature).trim()) {
    return `请先在「设置 → LLM → 提示词 · ${FEATURE_LABELS[feature]}」中配置提示词`
  }
  return null
}

/** describeLlmGap 的布尔版本——配置齐全才返回 true。 */
export function isLlmReady(feature: LlmPromptFeature): boolean {
  return describeLlmGap(feature) === null
}

/**
 * 用配置好的 LLM 把 `userText` 润色一遍，返回清洗（trim + 去引号）后的结果。
 *
 * 走具体错误而不是 boolean —— 三种典型失败（"还没配 API"、"还没配提示词"、
 * "网络/HTTP 错"）调用方都需要分别处理（提示用户、跳过本次、纳入失败计数）。
 *
 * 注意输入会被 trim 过滤，纯空白调用直接抛错——这是 AI 润色（YOLO）路径而不是
 * 裸发送路径，我们把"空文本调用"视为调用方传错而非默认放过。
 */
export async function polishWithLlm(
  feature: LlmPromptFeature,
  userText: string,
  opts: { signal?: AbortSignal } = {}
): Promise<string> {
  const systemPrompt = getActiveLlmPrompt(feature)
  if (!systemPrompt.trim()) {
    // 区分"功能提示词缺失"与"API 配置缺失"——两者都是用户能修的，但分别
    // 引导到不同的设置入口。describeLlmGap 已把顺序对好了，这里只需要把
    // 等价的错误抛出来作为 polishWithLlm 的最后一道闸门。
    throw new Error('当前功能未配置 LLM 提示词')
  }
  const trimmedUser = userText.trim()
  if (!trimmedUser) throw new Error('输入内容为空')

  const response = await chatCompletionViaLlm({
    provider: llmProvider.value,
    apiKey: llmApiKey.value,
    model: llmModel.value,
    baseURL: llmBaseURL.value,
    systemPrompt,
    userText: trimmedUser,
    signal: opts.signal,
  })
  return dequote(response.trim())
}
