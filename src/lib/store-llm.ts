/**
 * LLM 相关持久状态——既给「智能辅助驾驶」选梗用，也给 AI 润色（原代号 YOLO）
 * 文本改写用。
 *
 * 设计要点：
 * - **API 凭证（provider / key / model / baseURL）放在这里**，而不是绑死在
 *   `store-hzm.ts` 里的「智能辅助驾驶」面板。原因：HZM 面板只对注册了梗源的房间
 *   渲染（目前仅灰泽满 1713546334），意味着别的房间用户根本看不到 API 配置入口
 *   ——而 AI 润色三档（自动跟车 / 独轮车 / 手动发送）在所有房间都可见、可启用。
 *   把凭证抽到通用 LLM 域，让 Settings → LLM 永远可见，HZM 面板只是其中一个
 *   消费方。
 * - **GM 存储 key 仍用 `hzmLlm*` 老前缀**——老用户已经粘贴过 API key 的，升级后
 *   要直接读到原值，不能让他们重新配。`gmSignal('hzmLlmApiKey', ...)` 跑出来
 *   的对外名字是 `llmApiKey`，但落盘的 key 名不变。
 * - **三档 AI 润色开关 + 提示词** 依旧在这里维护：每个使用 LLM 的功能各有独立的
 *   提示词列表 + 当前选中索引，配合一个共享的"全局基线"。signal 名仍带 `Yolo`
 *   后缀（GM 持久化键），用户面板上呈现为「AI 润色」——keep internal names to
 *   avoid migration risk.
 *
 * 设计参考自 upstream chatterbox 0c8706f / 090bd1e / 3914ec6（提示词模型 + 三档
 * AI 润色开关）。
 */

import { effect, signal } from '@preact/signals'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'
import { gmSignal } from './gm-signal'

// ---------------------------------------------------------------------------
// LLM API 凭证（provider / key / model / baseURL）
// ---------------------------------------------------------------------------
//
// 历史包袱说明：这些 signal 之前住在 `store-hzm.ts`，名字带 `hzm` 前缀，是
// 因为最早只有"智能辅助驾驶"用 LLM。AI 润色（原 YOLO）上线后这套配置被两方
// 复用，再叫 hzm 已经名不副实，且把唯一可见的"配置入口"绑在 HZM 面板上让
// 非灰泽满房间的 AI 润色用户陷入死局（看得到开关、配不了 key）。这次把它们
// 搬到 LLM 域。
//
// GM 存储 key 保留 `hzmLlm*` 前缀以兼容老用户的持久数据——只改变量名/导出名。

export type LlmProvider = 'anthropic' | 'openai' | 'openai-compat'
const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'openai', 'openai-compat']
const isValidProvider = (v: unknown): v is LlmProvider =>
  typeof v === 'string' && (VALID_PROVIDERS as string[]).includes(v)

/** LLM provider。默认 anthropic（推荐 Haiku 4.5 做选梗 / 润色）。 */
export const llmProvider = gmSignal<LlmProvider>('hzmLlmProvider', 'anthropic', { validate: isValidProvider })

/**
 * 是否把 API key 持久化到 GM 存储。
 *
 * 默认开（保持老用户既有行为）。关掉后切换为"仅本会话"——key 留在内存，刷新页
 * 面后清空，且 GM 存储里的旧值立即抹掉。这是缓解 GM 存储明文风险的用户级开关：
 * 共用电脑、备份导出、其它扩展都不再能从盘上读到。
 */
export const llmApiKeyPersist = gmSignal<boolean>('hzmLlmApiKeyPersist', true)

/**
 * API key（运行时 signal）。
 *
 * 不直接用 gmSignal，因为持久化由 llmApiKeyPersist 决定。冷启动时若上次
 * 选了"持久"就从 GM 读回；否则从空字符串起步（用户需手动重新粘贴）。
 */
export const llmApiKey = signal<string>(
  GM_getValue<boolean>('hzmLlmApiKeyPersist', true) ? GM_getValue<string>('hzmLlmApiKey', '') : ''
)

// 唯一会写盘的地方——持久模式下落盘；切到非持久模式立刻删除 GM 里的旧值，
// 这样用户从持久切到非持久时不会留下一个孤儿副本。
let _isFirstPersistEffectRun = true
effect(() => {
  const persist = llmApiKeyPersist.value
  const key = llmApiKey.value
  if (_isFirstPersistEffectRun) {
    _isFirstPersistEffectRun = false
    return
  }
  if (persist) {
    GM_setValue('hzmLlmApiKey', key)
  } else {
    GM_deleteValue('hzmLlmApiKey')
  }
})

/**
 * 显式清空 API key（运行时 + GM 存储）。
 * UI 的"清除"按钮调用这个，避免 UI 自己直接 setValue('')。
 */
export function clearLlmApiKey(): void {
  llmApiKey.value = ''
  GM_deleteValue('hzmLlmApiKey')
}

/** 模型名。默认 Haiku 4.5（最便宜的 Anthropic 选梗模型）。 */
export const llmModel = gmSignal<string>('hzmLlmModel', 'claude-haiku-4-5-20251001')

/**
 * OpenAI 兼容 base URL（仅 provider='openai-compat' 时使用）。
 * 例如 DeepSeek `https://api.deepseek.com`、Moonshot `https://api.moonshot.cn`。
 * 第三方域可能不在 @connect 列表，Tampermonkey 会弹窗确认；UI 上提示。
 */
export const llmBaseURL = gmSignal<string>('hzmLlmBaseURL', '')

// ---------------------------------------------------------------------------
// AI 润色（原代号 YOLO）模式开关（每个功能一个）
//
// signal 名 + GM 持久化键保留 `*Yolo` 历史命名，避免用户配置迁移；
// 用户可见的 UI 文案统一改成「AI 润色」。
// ---------------------------------------------------------------------------

/** 自动跟车 AI 润色：触发后用 LLM 改写再发。默认关。 */
export const autoBlendYolo = gmSignal<boolean>('autoBlendYolo', false)
/** 独轮车 AI 润色：循环里每条非表情消息用 LLM 改写再发。默认关。 */
export const autoSendYolo = gmSignal<boolean>('autoSendYolo', false)
/** 手动发送 AI 润色：手动 / +1 / 偷 路径上把文本先送给 LLM 改写。默认关。 */
export const normalSendYolo = gmSignal<boolean>('normalSendYolo', false)

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

/**
 * 全局基线提示词（出厂默认值）。
 *
 * 作为 PromptManager 的初始内容种子写入一次（见下面的 seeding 迁移）。用户可
 * 自由编辑、新增、删除——seeding 是一次性的，删了就不会再回来。多行 markdown
 * 列表是为了让模型清楚地看到弹幕场景下的几条互不相关的硬约束（长度、格式、
 * 敏感词）。
 *
 * Exported in case 未来 UI 想加个"恢复默认"按钮。
 */
export const DEFAULT_GLOBAL_PROMPT = [
  '你是哔哩哔哩直播间的弹幕优化助手，根据用户的输入内容，完全遵循用户的修改提示，输出相应的内容，并遵循以下基本约定：',
  '',
  '- 单条弹幕请控制在 40 字以内，使用自然口语化的中文',
  '- 不要使用 Markdown、列表、不要包裹引号或代码块',
  '- 直接输出最终弹幕文本，不要包含解释、前缀或多余空白，结尾不带句号',
].join('\n')

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const isNonNegativeInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

// 一次性 seeding：在用户首次安装 / 升级到带 LLM 的版本时把默认全局提示词
// 写进 GM 存储。用一个独立的 sentinel key 标记已 seed，这样用户主动清空
// 提示词列表后不会被这里"还原"。设计参考 upstream 0c8706f 的同位策略。
const SEED_KEY = 'llmPromptsGlobalSeeded'
if (!GM_getValue<boolean>(SEED_KEY, false)) {
  const existing = GM_getValue<unknown>('llmPromptsGlobal')
  if (existing === undefined || (Array.isArray(existing) && existing.length === 0)) {
    GM_setValue('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT])
  }
  GM_setValue(SEED_KEY, true)
}

/**
 * 全局提示词列表 + 当前激活索引。getActiveLlmPrompt 会把"激活的全局提示词"
 * 拼接到激活的功能提示词前面（详见 prompts.ts）。
 *
 * 各功能各自维护独立的列表 + 索引（不是 Record<feature, ...>），这样某个功能
 * 的存储损坏不会拖累其它功能；也方便 UI 单独 diff 每个 signal。
 */
export const llmPromptsGlobal = gmSignal<string[]>('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT], {
  validate: isStringArray,
})
export const llmActivePromptGlobal = gmSignal<number>('llmActivePromptGlobal', 0, { validate: isNonNegativeInt })

/** 手动发送（含 +1 / 偷）的提示词列表 + 索引。默认空数组——用户没配 = AI 润色不可用。 */
export const llmPromptsNormalSend = gmSignal<string[]>('llmPromptsNormalSend', [], { validate: isStringArray })
export const llmActivePromptNormalSend = gmSignal<number>('llmActivePromptNormalSend', 0, {
  validate: isNonNegativeInt,
})

/** 自动跟车的提示词列表 + 索引。 */
export const llmPromptsAutoBlend = gmSignal<string[]>('llmPromptsAutoBlend', [], { validate: isStringArray })
export const llmActivePromptAutoBlend = gmSignal<number>('llmActivePromptAutoBlend', 0, { validate: isNonNegativeInt })

/** 独轮车的提示词列表 + 索引。 */
export const llmPromptsAutoSend = gmSignal<string[]>('llmPromptsAutoSend', [], { validate: isStringArray })
export const llmActivePromptAutoSend = gmSignal<number>('llmActivePromptAutoSend', 0, { validate: isNonNegativeInt })
