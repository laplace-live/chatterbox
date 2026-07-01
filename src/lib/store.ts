import { effect, signal } from '@preact/signals'

import type { BilibiliEmoticonPackage, FavoriteEmote } from '../types'
import type { LlmModel } from './llm'
import type { SonioxModel } from './soniox-models'
import type { SttModelOption, SttProvider } from './stt/types'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'
import { DEEPGRAM_DEFAULT_MODEL, SONIOX_DEFAULT_MODEL } from './const'
import { gmSignal } from './gm-signal'
import { appendLog } from './log'
import { DEFAULT_AI_CHAT_PROMPTS, DEFAULT_GLOBAL_PROMPT } from './prompts'

// GM-persisted settings
export const msgSendInterval = gmSignal('msgSendInterval', 1)
export const maxLength = gmSignal('maxLength', 38)
export const randomColor = gmSignal('randomColor', false)
export const randomInterval = gmSignal('randomInterval', false)
export const randomChar = gmSignal('randomChar', false)
export const aiEvasion = gmSignal('aiEvasion', false)
// Wrap each 常规发送 segment in full-width 【】. Split length reserves the two wrapper graphemes (see `wrapSplitLen`) so a wrapped segment still fits `maxLength`.
export const normalSendWrapBrackets = gmSignal('normalSendWrapBrackets', false)
// YOLO mode for 常规发送: Enter auto-polishes text via the LLM before sending.
export const normalSendYolo = gmSignal('normalSendYolo', false)
// YOLO mode for 独轮车 (auto-send): polish upfront per round (one LLM call per non-emote template line) before the send loop, keeping the per-send `msgSendInterval` cadence untouched.
export const autoSendYolo = gmSignal('autoSendYolo', false)
export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const danmakuDirectAlwaysShow = gmSignal('danmakuDirectAlwaysShow', false)
export const unlockLiveBlock = gmSignal('unlockLiveBlock', true)
export const unlockSpaceBlock = gmSignal('unlockSpaceBlock', true)
// Audio-only mode: `livePlayer.stopPlayback()` halts the native HLS pull, then a true audio-only FLV stream (`only_audio=1` from the app endpoint — web endpoint ignores it) plays via hidden `<audio>` + mpegts.js. ~180 vs ~1700 kbps. See `lib/audio-only.ts`.
export const audioOnlyEnabled = gmSignal('audioOnlyEnabled', false)
// Audio-only playback controls. Runtime signals, NOT persisted: re-seeded from the native player's volume/mute each engage, so persisting would fight that seed. `audioOnlyVolume` is 0–1.
export const audioOnlyVolume = signal(1)
export const audioOnlyMuted = signal(false)
// Auto-seek (自动追帧): nudges `video.playbackRate` to minimize latency. Event-driven (no polling); inert while `audioOnlyEnabled`. Threshold in seconds = target buffered-ahead. See `lib/auto-seek.ts`.
export const autoSeekEnabled = gmSignal('autoSeekEnabled', false)
export const autoSeekBufferThreshold = gmSignal('autoSeekBufferThreshold', 1.7)
// Auto-quality (自动原画): one-shot switch to 原画 (qn=10000) on page load, so later manual picks stay respected. Inert when `audioOnlyEnabled` (avoids ping-pong with its stopPlayback watchdog). See `lib/auto-quality.ts`.
export const autoQualityEnabled = gmSignal('autoQualityEnabled', false)

// Info button popover sections (魔法期 / 公会 / MCN from Laplace workers), each independently gated. Toggles gate only the SECTIONS; the button stays visible for the local 用户备注 editor. See `InfoButton`.
export const infoFertilityEnabled = gmSignal('infoFertilityEnabled', false)
export const infoGuildEnabled = gmSignal('infoGuildEnabled', false)
export const infoMcnEnabled = gmSignal('infoMcnEnabled', false)

export const activeTab = gmSignal('activeTab', 'fasong')
export const msgTemplates = gmSignal<string[]>('MsgTemplates', [])
export const activeTemplateIndex = gmSignal('activeTemplateIndex', 0)
export const logPanelOpen = gmSignal('logPanelOpen', false)
export const autoSendPanelOpen = gmSignal('autoSendPanelOpen', true)
export const autoBlendPanelOpen = gmSignal('autoBlendPanelOpen', true)
export const normalSendPanelOpen = gmSignal('normalSendPanelOpen', true)
export const memesPanelOpen = gmSignal('memesPanelOpen', true)
// Master switch for the 烂梗库's networking: when off, no requests at all (no list fetch, no 30s polling, no copy-count reports).
export const memesEnabled = gmSignal('memesEnabled', false)
export const dialogOpen = gmSignal('dialogOpen', false)

// Per-section open state for the Settings tab accordions; default closed.
export const settingsRulesOpen = gmSignal('settingsRulesOpen', false)
export const settingsBlacklistOpen = gmSignal('settingsBlacklistOpen', false)
export const settingsLlmOpen = gmSignal('settingsLlmOpen', false)
export const settingsAutoSeekOpen = gmSignal('settingsAutoSeekOpen', false)
export const settingsFeaturesOpen = gmSignal('settingsFeaturesOpen', false)
export const settingsUserNotesOpen = gmSignal('settingsUserNotesOpen', false)
export const settingsLogOpen = gmSignal('settingsLogOpen', false)
export const settingsImportExportOpen = gmSignal('settingsImportExportOpen', false)
// Floating panel width in CSS px. Resize handle clamps writes to [DIALOG_MIN_WIDTH, viewport-aware max] so a corrupted GM value can't render an off-screen dialog.
export const dialogWidth = gmSignal('dialogWidth', 300)

// Auto-blend (自动融入): when x distinct users send the same danmaku z+ times within y seconds, auto-send it once, then freeze the detector for b seconds.
export const autoBlendUniqueUsers = gmSignal('autoBlendUniqueUsers', 3) // x
export const autoBlendWindowSec = gmSignal('autoBlendWindowSec', 15) // y
export const autoBlendMinOccurrences = gmSignal('autoBlendMinOccurrences', 3) // z
export const autoBlendCooldownSec = gmSignal('autoBlendCooldownSec', 10) // b
// When true, b is derived from chat velocity (CPM), clamped 2–60 s, and the fixed `autoBlendCooldownSec` is ignored.
export const autoBlendCooldownAuto = gmSignal('autoBlendCooldownAuto', false)
export const autoBlendUseReplacements = gmSignal('autoBlendUseReplacements', true)
// When true, drop incoming danmaku matching the last auto-sent text so a repeating chat can't re-trigger after cooldown. Tracked per startAutoBlend session (cleared on stop).
export const autoBlendAvoidRepeat = gmSignal('autoBlendAvoidRepeat', false)
// YOLO mode for 自动融入: LLM-polish each triggered trend before sending. Once per trigger (not per repeat) to preserve N-repeat semantics and bound LLM cost.
export const autoBlendYolo = gmSignal('autoBlendYolo', false)
// Per-room opt-in to remember 自动融入 on/off state across reloads.
export const persistAutoBlendState = gmSignal<Record<string, boolean>>('persistAutoBlendState', {})
// Cross-room blacklist: danmaku from these uids never count toward auto-blend triggers. uid → uname so the username shows in logs even after leaving the room.
export const autoBlendUserBlacklist = gmSignal<Record<string, string>>('autoBlendUserBlacklist', {})
// Cross-room message blacklist: drop danmaku whose trimmed text matches. Keyed by the same trimmed text `auto-blend` counts by; value always `1` (Record not Set for cheap JSON GM round-tripping).
export const autoBlendMessageBlacklist = gmSignal<Record<string, 1>>('autoBlendMessageBlacklist', {})

// LLM settings. `llmApiBase` is the OpenAI-compatible root (`${llmApiBase}/models`, `/chat/completions`). `llmModels` caches full {id, name?, pricing?} objects so the dropdown shows metadata across reloads without re-fetching.
export const llmApiBase = gmSignal('llmApiBase', 'https://api.openai.com/v1')
export const llmApiKey = gmSignal('llmApiKey', '')
export const llmModel = gmSignal('llmModel', '')
export const llmModels = gmSignal<LlmModel[]>('llmModels', [])

// Seed the default global prompt. Uses a dedicated `llmPromptsGlobalSeeded` flag, not the gmSignal default, because testers with `llmPromptsGlobal: []` already persisted would suppress that default; the flag also stops a deliberately-deleted default from being re-added.
;(() => {
  const seeded = GM_getValue<boolean>('llmPromptsGlobalSeeded', false)
  if (seeded) return
  const existing = GM_getValue<string[]>('llmPromptsGlobal', [])
  if (existing.length === 0) {
    GM_setValue('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT])
  }
  GM_setValue('llmPromptsGlobalSeeded', true)
})()

// Default mirrors DEFAULT_GLOBAL_PROMPT as a safety net if the migration's GM_setValue above silently fails.
export const llmPromptsGlobal = gmSignal<string[]>('llmPromptsGlobal', [DEFAULT_GLOBAL_PROMPT])
export const llmActivePromptGlobal = gmSignal('llmActivePromptGlobal', 0)
export const llmPromptsNormalSend = gmSignal<string[]>('llmPromptsNormalSend', [])
export const llmActivePromptNormalSend = gmSignal('llmActivePromptNormalSend', 0)
export const llmPromptsAutoBlend = gmSignal<string[]>('llmPromptsAutoBlend', [])
export const llmActivePromptAutoBlend = gmSignal('llmActivePromptAutoBlend', 0)
export const llmPromptsAutoSend = gmSignal<string[]>('llmPromptsAutoSend', [])
export const llmActivePromptAutoSend = gmSignal('llmActivePromptAutoSend', 0)

// AI Chat prompt seed. v2 migration is additive: merge (by exact content match) any missing v2 persona templates onto the user's list, preserving customisations; empty lists get the full lineup. Sets both v1 + v2 flags so neither re-seeds.
;(() => {
  const seededV2 = GM_getValue<boolean>('llmPromptsAiChatSeededV2', false)
  if (seededV2) return
  const existing = GM_getValue<string[]>('llmPromptsAiChat', [])
  if (existing.length === 0) {
    GM_setValue('llmPromptsAiChat', [...DEFAULT_AI_CHAT_PROMPTS])
  } else {
    const additions = DEFAULT_AI_CHAT_PROMPTS.filter(p => !existing.includes(p))
    if (additions.length > 0) {
      GM_setValue('llmPromptsAiChat', [...existing, ...additions])
    }
  }
  GM_setValue('llmPromptsAiChatSeeded', true)
  GM_setValue('llmPromptsAiChatSeededV2', true)
})()
export const llmPromptsAiChat = gmSignal<string[]>('llmPromptsAiChat', [...DEFAULT_AI_CHAT_PROMPTS])
export const llmActivePromptAiChat = gmSignal('llmActivePromptAiChat', 0)

// AI Chat ("AI 陪聊") settings; defaults mirror laplace-cap's `useAiChatter`.
// - `aiChatAutoSend`: Review mode by default; on = bypass candidate list, enqueue straight away.
// - `aiChatMaxMessageLength`: also fed into the JSON schema as `message.maxLength`.
// - `aiChatViewerInterval`: viewer-only generation every N viewer messages.
export const aiChatEnabled = gmSignal('aiChatEnabled', false)
export const aiChatAutoSend = gmSignal('aiChatAutoSend', false)
export const aiChatContextMaxChars = gmSignal('aiChatContextMaxChars', 2048)
export const aiChatMaxMessageLength = gmSignal('aiChatMaxMessageLength', 40)
export const aiChatViewerWindow = gmSignal('aiChatViewerWindow', 50)
export const aiChatViewerInterval = gmSignal('aiChatViewerInterval', 10)
export const aiChatTemperature = gmSignal('aiChatTemperature', 0.7)

// STT (同传) settings. `sttProvider` picks the active realtime provider; each keeps its own api key + model, while output/capture settings are shared under provider-neutral `stt*` keys.
export const sttProvider = gmSignal<SttProvider>('sttProvider', 'soniox')

// --- Soniox (provider-specific) ---
export const sonioxApiKey = gmSignal('sonioxApiKey', '')
// `sonioxModels` caches the fetched /v1/models list (id + optional name) so the dropdown stays populated across reloads without re-hitting Soniox on every mount.
export const sonioxModel = gmSignal('sonioxModel', SONIOX_DEFAULT_MODEL)
export const sonioxModels = gmSignal<SonioxModel[]>('sonioxModels', [])
export const sonioxLanguageHints = gmSignal<string[]>('sonioxLanguageHints', ['zh'])
// Realtime translation is Soniox-only (Scribe is transcription-only); the tab hides this section for other providers.
export const sonioxTranslationEnabled = gmSignal('sonioxTranslationEnabled', false)
export const sonioxTranslationTarget = gmSignal('sonioxTranslationTarget', 'en')

// --- ElevenLabs (provider-specific) ---
export const elevenLabsApiKey = gmSignal('elevenLabsApiKey', '')
// No model setting: only one realtime Scribe model, no list API, so the id is hardcoded (`ELEVENLABS_DEFAULT_MODEL`). Single ISO-639-1/3 code or '' for auto-detect (not a multi-hint list like Soniox).
export const elevenLabsLanguageCode = gmSignal('elevenLabsLanguageCode', '')

// --- Deepgram (provider-specific) ---
export const deepgramApiKey = gmSignal('deepgramApiKey', '')
// `deepgramModels` caches the streaming-filtered /v1/models list so the dropdown stays populated across reloads.
export const deepgramModel = gmSignal('deepgramModel', DEEPGRAM_DEFAULT_MODEL)
export const deepgramModels = gmSignal<SttModelOption[]>('deepgramModels', [])
// `multi` = nova-3 multilingual code-switching, else a BCP-47/ISO code. Deepgram has no "auto"; `multi` is the closest for mixed-language streams.
export const deepgramLanguage = gmSignal('deepgramLanguage', 'multi')

// --- Gladia (provider-specific) ---
export const gladiaApiKey = gmSignal('gladiaApiKey', '')
// One model family (`solaria-1`), no list endpoint, so no model signal (like ElevenLabs). Single language code ('' = auto-detect with code-switching).
export const gladiaLanguage = gmSignal('gladiaLanguage', '')

// --- Shared output / capture (every provider) ---
// Migrate the formerly Soniox-prefixed keys to neutral `stt*` keys. Idempotent, sentinel-guarded per key (copy only if new key unset, then delete old) so a re-imported pre-upgrade backup gets migrated again.
;(() => {
  const renames: Array<[string, string]> = [
    ['sonioxAutoSend', 'sttAutoSend'],
    ['sonioxMaxLength', 'sttMaxLength'],
    ['sonioxWrapBrackets', 'sttWrapBrackets'],
    ['sonioxAudioDeviceId', 'sttAudioDeviceId'],
  ]
  for (const [oldKey, newKey] of renames) {
    const missing = Symbol()
    const oldVal = GM_getValue<unknown>(oldKey, missing)
    if (oldVal === missing) continue
    const newVal = GM_getValue<unknown>(newKey, missing)
    if (newVal === missing) GM_setValue(newKey, oldVal)
    GM_deleteValue(oldKey)
  }
})()

export const sttAutoSend = gmSignal('sttAutoSend', true)
export const sttMaxLength = gmSignal('sttMaxLength', 40)
export const sttWrapBrackets = gmSignal('sttWrapBrackets', false)
// '' = system default mic. Validated against the live device list before each start so a stale id (mic unplugged) falls back to default instead of erroring.
export const sttAudioDeviceId = gmSignal('sttAudioDeviceId', '')

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

// Drop the removed `autoBlendIncludeReply` key (@ replies are always excluded now). Existence check, not value check, so it deletes regardless of on/off and skips the write after first run.
;(() => {
  const sentinel = Symbol()
  if (GM_getValue<unknown>('autoBlendIncludeReply', sentinel) !== sentinel) {
    GM_deleteValue('autoBlendIncludeReply')
  }
})()

// Replacement rules
// Master switch for cloud-synced rules. When off, `buildReplacementMap` skips the remote layer and auto-sync pauses (local rules unaffected). Toggling rebuilds the map immediately.
export const remoteRulesEnabled = gmSignal('remoteRulesEnabled', false)
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

// Live metrics from `lib/auto-seek.ts`, kept out of GM so a stale reload value doesn't paint a fake latency before the first tick. `autoSeekCurrentBufferLen` is seconds buffered ahead ≈ live latency; `autoSeekCurrentRate` is the last observed `video.playbackRate`.
export const autoSeekCurrentBufferLen = signal(0)
export const autoSeekCurrentRate = signal(1)

// Ephemeral STT → AI Chat bridge; `sttEndpointReached` flips on Soniox's `<end>` token. Kept out of GM so a reload mid-stream doesn't leave a stale buffer for the next mount.
export const sttTranscriptBuffer = signal('')
export const sttEndpointReached = signal(false)

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

// User-pinned emotes ("收藏" tab). Stores self-contained snapshots (see `FavoriteEmote`) so a room-exclusive emote still renders — grayed out — from a different room.
export const favoriteEmotes = gmSignal<FavoriteEmote[]>('favoriteEmotes', [])

// Fasong tab shared text
export const fasongText = signal('')
