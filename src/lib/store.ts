import { effect, signal } from '@preact/signals'

import type { BilibiliEmoticonPackage } from '../types'
import type { LlmModel } from './llm'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'
import { gmSignal } from './gm-signal'
import { appendLog } from './log'

// GM-persisted settings
export const msgSendInterval = gmSignal('msgSendInterval', 1)
export const maxLength = gmSignal('maxLength', 38)
export const randomColor = gmSignal('randomColor', false)
export const randomInterval = gmSignal('randomInterval', false)
export const randomChar = gmSignal('randomChar', false)
export const aiEvasion = gmSignal('aiEvasion', false)
export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const danmakuDirectAlwaysShow = gmSignal('danmakuDirectAlwaysShow', false)
export const unlockLiveBlock = gmSignal('unlockLiveBlock', true)
export const unlockSpaceBlock = gmSignal('unlockSpaceBlock', true)
export const activeTab = gmSignal('activeTab', 'fasong')
export const msgTemplates = gmSignal<string[]>('MsgTemplates', [])
export const activeTemplateIndex = gmSignal('activeTemplateIndex', 0)
export const logPanelOpen = gmSignal('logPanelOpen', false)
export const autoSendPanelOpen = gmSignal('autoSendPanelOpen', true)
export const autoBlendPanelOpen = gmSignal('autoBlendPanelOpen', true)
export const normalSendPanelOpen = gmSignal('normalSendPanelOpen', true)
export const memesPanelOpen = gmSignal('memesPanelOpen', true)
export const dialogOpen = gmSignal('dialogOpen', false)
// Persisted width (in CSS px) of the floating panel. Default 300 matches the
// pre-resize hard-coded `lc-w-[300px]`. The resize handle clamps writes to
// [DIALOG_MIN_WIDTH, viewport-aware max] so a corrupted GM value can't render
// an unusably narrow / off-screen dialog.
export const dialogWidth = gmSignal('dialogWidth', 300)

// Auto-blend (自动融入): when x distinct users send the same danmaku z+ times
// within y seconds, auto-send it a times, then freeze the entire detector
// for b seconds (every incoming danmaku is discarded during the freeze).
export const autoBlendUniqueUsers = gmSignal('autoBlendUniqueUsers', 3) // x
export const autoBlendWindowSec = gmSignal('autoBlendWindowSec', 15) // y
export const autoBlendMinOccurrences = gmSignal('autoBlendMinOccurrences', 3) // z
export const autoBlendSendCount = gmSignal('autoBlendSendCount', 1) // a
export const autoBlendCooldownSec = gmSignal('autoBlendCooldownSec', 10) // b
// When true, b is computed live from the room's chat velocity (CPM): the
// faster the chat, the shorter the cooldown (floored at 2 s for the busiest
// rooms, ceilinged at 60 s for nearly-silent ones). The fixed
// `autoBlendCooldownSec` value is ignored while this is on.
export const autoBlendCooldownAuto = gmSignal('autoBlendCooldownAuto', false)
export const autoBlendIncludeReply = gmSignal('autoBlendIncludeReply', false)
export const autoBlendUseReplacements = gmSignal('autoBlendUseReplacements', true)
// When true, drop incoming danmaku that exactly match the last text we
// auto-sent so a chat that keeps repeating the same line after our
// cooldown can't trigger another duplicate auto-send. Tracked only across
// the lifetime of one startAutoBlend session (cleared on stop).
export const autoBlendAvoidRepeat = gmSignal('autoBlendAvoidRepeat', false)
// Per-room opt-in to remember 自动融入 on/off state across reloads.
export const persistAutoBlendState = gmSignal<Record<string, boolean>>('persistAutoBlendState', {})
// Cross-room blacklist: danmaku from these uids are never counted toward
// auto-blend triggers. Stored as uid → uname so the username can be shown
// in logs / future management UI even after the user leaves the room.
export const autoBlendUserBlacklist = gmSignal<Record<string, string>>('autoBlendUserBlacklist', {})
// Cross-room message blacklist: any danmaku whose trimmed text matches an
// entry here is dropped before it can contribute to a candidate. Keyed by
// the same trimmed text that `auto-blend` uses as its counter key, so a
// row in the live "候选" leaderboard maps 1:1 to a blacklist entry. The
// value is unused (always `1`) — the key is the entire payload; we use a
// Record (not a Set) for cheap GM-storage round-tripping via JSON.
export const autoBlendMessageBlacklist = gmSignal<Record<string, 1>>('autoBlendMessageBlacklist', {})

// LLM settings (used for future AI integrations — UI only for now). The
// API base is treated as the OpenAI-compatible root, so the script hits
// `${llmApiBase}/models` for the model list and would hit
// `${llmApiBase}/chat/completions` etc. once an integration ships.
// `llmModels` caches the most recently fetched model objects so the
// dropdown stays populated across reloads without re-hitting the user's
// endpoint. We persist the full {id, name?, pricing?} shape rather than
// just ids so the UI can show metadata (e.g. price) without a re-fetch.
export const llmApiBase = gmSignal('llmApiBase', 'https://api.openai.com/v1')
export const llmApiKey = gmSignal('llmApiKey', '')
export const llmModel = gmSignal('llmModel', '')
export const llmModels = gmSignal<LlmModel[]>('llmModels', [])

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
  '你是 Bilibili 直播间的弹幕生成助手，输出会被直接当作弹幕发送。请遵循以下基本约定：',
  '',
  '- 单条弹幕请控制在 40 字以内，使用自然口语化的中文',
  '- 不要使用 Markdown、列表、表情符号 / emoji，不要包裹引号或代码块',
  '- 直接输出最终弹幕文本，不要包含解释、前缀或多余空白',
  '- 避免敏感词与平台违禁词，避免引战或冒犯性表述',
  '- 与直播间氛围保持一致，保持友好自然',
].join('\n')

// Seed the default global prompt for users who don't already have one
// configured. Tracked via a dedicated `llmPromptsGlobalSeeded` flag
// rather than by relying on the gmSignal default, because the gmSignal
// default only kicks in when the key has never been written — and any
// pre-release tester running an earlier build of this branch already
// has `llmPromptsGlobal: []` persisted, which would otherwise silently
// suppress the seed forever.
//
// The flag also means a user who deliberately deletes the default
// won't have it re-added on every reload — `seeded=true` short-circuits
// the migration even when the array is back to empty. Same one-time
// semantics as the `replacementRules` migration below.
;(() => {
  const seeded = GM_getValue<boolean>('llmPromptsGlobalSeeded', false)
  if (seeded) return
  const existing = GM_getValue<string[]>('llmPromptsGlobal', [])
  if (existing.length === 0) {
    GM_setValue('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT])
  }
  GM_setValue('llmPromptsGlobalSeeded', true)
})()

// gmSignal default also points at DEFAULT_GLOBAL_PROMPT so the line
// reads truthfully ("default: the default prompt") even though the
// migration above has already written it for any real user. The signal
// default is the safety net for the theoretical case where the
// migration's GM_setValue silently fails.
export const llmPromptsGlobal = gmSignal<string[]>('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT])
export const llmActivePromptGlobal = gmSignal('llmActivePromptGlobal', 0)
export const llmPromptsNormalSend = gmSignal<string[]>('llmPromptsNormalSend', [])
export const llmActivePromptNormalSend = gmSignal('llmActivePromptNormalSend', 0)
export const llmPromptsAutoBlend = gmSignal<string[]>('llmPromptsAutoBlend', [])
export const llmActivePromptAutoBlend = gmSignal('llmActivePromptAutoBlend', 0)
export const llmPromptsAutoSend = gmSignal<string[]>('llmPromptsAutoSend', [])
export const llmActivePromptAutoSend = gmSignal('llmActivePromptAutoSend', 0)

// Soniox settings
export const sonioxApiKey = gmSignal('sonioxApiKey', '')
export const sonioxLanguageHints = gmSignal<string[]>('sonioxLanguageHints', ['zh'])
export const sonioxAutoSend = gmSignal('sonioxAutoSend', true)
export const sonioxMaxLength = gmSignal('sonioxMaxLength', 40)
export const sonioxWrapBrackets = gmSignal('sonioxWrapBrackets', false)
export const sonioxTranslationEnabled = gmSignal('sonioxTranslationEnabled', false)
export const sonioxTranslationTarget = gmSignal('sonioxTranslationTarget', 'en')
// Empty string = use system default microphone. Validated against the live
// device list before each start so a stale id (mic unplugged across
// sessions) silently falls back to default instead of erroring out.
export const sonioxAudioDeviceId = gmSignal('sonioxAudioDeviceId', '')

// Migrate legacy flat replacementRules → localGlobalRules (one-time, then delete old key)
;(() => {
  const old = GM_getValue<Array<{ from?: string; to?: string }>>('replacementRules', [])
  if (old.length > 0) {
    const existing = GM_getValue<Array<{ from?: string; to?: string }>>('localGlobalRules', [])
    if (existing.length === 0) {
      GM_setValue('localGlobalRules', old)
    }
    GM_deleteValue('replacementRules')
  }
})()

// Replacement rules
export const localGlobalRules = gmSignal<Array<{ from?: string; to?: string }>>('localGlobalRules', [])
export const localRoomRules = gmSignal<Record<string, Array<{ from?: string; to?: string }>>>('localRoomRules', {})
export const remoteKeywords = gmSignal<{
  global?: { keywords?: Record<string, string> }
  rooms?: Array<{ room: string; keywords?: Record<string, string> }>
} | null>('remoteKeywords', null)
export const remoteKeywordsLastSync = gmSignal<number | null>('remoteKeywordsLastSync', null)

export const persistSendState = gmSignal<Record<string, boolean>>('persistSendState', {})

// Runtime state (not GM-persisted)
export const sendMsg = signal(false)
export const sttRunning = signal(false)
export const cachedRoomId = signal<number | null>(null)
export const autoBlendEnabled = signal(false)

let sendStateRestored = false
let autoBlendStateRestored = false

effect(() => {
  const persist = persistSendState.value
  const roomId = cachedRoomId.value
  const sending = sendMsg.value
  if (roomId === null) return
  const key = String(roomId)
  if (persist[key]) {
    if (!sendStateRestored) {
      sendStateRestored = true
      const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
      if (stored[key]) {
        sendMsg.value = true
        appendLog('🔄 已恢复独轮车运行状态')
      }
      return
    }
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    GM_setValue('persistedSendMsg', { ...stored, [key]: sending })
  } else {
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    if (key in stored) {
      const { [key]: _, ...rest } = stored
      GM_setValue('persistedSendMsg', rest)
    }
  }
})

effect(() => {
  const persist = persistAutoBlendState.value
  const roomId = cachedRoomId.value
  const enabled = autoBlendEnabled.value
  if (roomId === null) return
  const key = String(roomId)
  if (persist[key]) {
    if (!autoBlendStateRestored) {
      autoBlendStateRestored = true
      const stored = GM_getValue<Record<string, boolean>>('persistedAutoBlendEnabled', {})
      if (stored[key]) {
        autoBlendEnabled.value = true
        appendLog('🔄 已恢复自动融入运行状态')
      }
      return
    }
    const stored = GM_getValue<Record<string, boolean>>('persistedAutoBlendEnabled', {})
    GM_setValue('persistedAutoBlendEnabled', { ...stored, [key]: enabled })
  } else {
    const stored = GM_getValue<Record<string, boolean>>('persistedAutoBlendEnabled', {})
    if (key in stored) {
      const { [key]: _, ...rest } = stored
      GM_setValue('persistedAutoBlendEnabled', rest)
    }
  }
})

export const cachedStreamerUid = signal<number | null>(null)
export const availableDanmakuColors = signal<string[] | null>(null)
export const replacementMap = signal<Map<string, string> | null>(null)

export const cachedEmoticonPackages = signal<BilibiliEmoticonPackage[]>([])

// Fasong tab shared text
export const fasongText = signal('')
