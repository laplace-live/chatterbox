import { effect, signal } from '@preact/signals'

import type { BilibiliEmoticonPackage, FavoriteEmote } from '../types'
import type { LlmModel } from './llm'
import type { SonioxModel } from './soniox-models'
import type { SttModelOption, SttProvider } from './stt/types'

import { GM_deleteValue, GM_getValue, GM_setValue } from '$'
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
// When on, each 常规发送 danmaku segment is wrapped in full-width 【】 so
// viewers can tell it apart from regular chat. Independent from the 同传
// tab's `sonioxWrapBrackets` (separate per-tab toggle) and off by default
// so existing users keep sending unwrapped text. The split length reserves
// the two wrapper graphemes (see `wrapSplitLen`) so a wrapped segment still
// fits `maxLength`.
export const normalSendWrapBrackets = gmSignal('normalSendWrapBrackets', false)
// "YOLO" mode for the 常规发送 tab: when on, pressing Enter inside the
// input box auto-polishes the text via the configured LLM and sends
// the polished result. When off, Enter sends as-typed (the historical
// behaviour). Persisted as a global preference rather than per-room
// because a "polish before send" expectation is about the user's own
// writing style, not about which streamer they're chatting with.
export const normalSendYolo = gmSignal('normalSendYolo', false)
// "YOLO" mode for the 独轮车 (auto-send) loop: when on, every line of
// the active template is run through the LLM (using the autoSend
// prompt) BEFORE the round's send loop fires. Off by default so
// existing users don't suddenly start emitting AI-rewritten danmaku
// without opting in. Polish happens upfront per round (not per
// segment), one LLM call per non-emote template line — keeps the
// per-send `msgSendInterval` cadence untouched (polish time is "round
// overhead" rather than getting interleaved with sends).
export const autoSendYolo = gmSignal('autoSendYolo', false)
export const forceScrollDanmaku = gmSignal('forceScrollDanmaku', false)
export const optimizeLayout = gmSignal('optimizeLayout', false)
export const danmakuDirectMode = gmSignal('danmakuDirectMode', true)
export const danmakuDirectConfirm = gmSignal('danmakuDirectConfirm', false)
export const danmakuDirectAlwaysShow = gmSignal('danmakuDirectAlwaysShow', false)
export const unlockLiveBlock = gmSignal('unlockLiveBlock', true)
export const unlockSpaceBlock = gmSignal('unlockSpaceBlock', true)
// Audio-only mode: bilibili's web player doesn't ship an audio-only toggle
// (the official app has one). When on, we stop the native HLS pull via
// `livePlayer.stopPlayback()` and play a true audio-only FLV stream
// (fetched with `only_audio=1` from the app endpoint) through a hidden
// `<audio>` element driven by lazy-loaded mpegts.js — ~180 kbps instead
// of ~1700 kbps for the original 1080P stream. Default off; opt in via
// the headphones button injected next to 小窗模式 (or the floating
// overlay button while audio-only is engaged). See `lib/audio-only.ts`.
export const audioOnlyEnabled = gmSignal('audioOnlyEnabled', false)
// Live playback controls for audio-only mode. Runtime signals (NOT
// GM-persisted): `lib/audio-only.ts` seeds them from the native player's
// volume/mute at engage time (so the level carries over seamlessly when
// you switch to audio-only), then pushes any change onto the hidden
// <audio> element via an effect. `components/audio-only-controls.tsx`
// reads/writes them to render the speaker + slider. Persisting them would
// fight the "inherit from the native player" seed, so we deliberately
// don't — re-seeded fresh each engage. `audioOnlyVolume` is 0–1.
export const audioOnlyVolume = signal(1)
export const audioOnlyMuted = signal(false)
// Auto-seek (自动追帧): nudges `video.playbackRate` to minimize live-stream
// latency. Event-driven (listens to <video> `progress`/`timeupdate`/etc.,
// no setInterval polling) so it costs ~0 while idle. Inert while
// `audioOnlyEnabled` is true. Threshold is in seconds — the seeker
// targets buffered-ahead == this value, speeding up above it and slowing
// down well below it. 1.5s matches the greasyfork 439875 default that's
// been battle-tested across thousands of bilibili rooms. See
// `lib/auto-seek.ts`.
export const autoSeekEnabled = gmSignal('autoSeekEnabled', false)
export const autoSeekBufferThreshold = gmSignal('autoSeekBufferThreshold', 1.7)
// Auto-quality (自动原画): on page load, switch the native player to
// 原画 (qn=10000) if it landed on a lower default. One-shot — does not
// keep enforcing across the session, so a user's later manual quality
// pick stays respected. Inert when `audioOnlyEnabled` is true at the
// moment the player becomes available (avoids ping-pong with audio-
// only's stopPlayback watchdog). Default off because upgrading quality
// silently increases bandwidth usage on metered connections. See
// `lib/auto-quality.ts`.
export const autoQualityEnabled = gmSignal('autoQualityEnabled', false)

// Info button: an "i" icon next to the audio-only / 直播助手 buttons that
// opens a popover with streamer metadata sourced from Laplace workers
// (魔法期 / 公会 / MCN) plus a local 用户备注 editor. Each remote data
// category is independently gated below so a user can opt into, say,
// guild lookups without ever hitting the fertility endpoint. All three
// default OFF because the data is opinionated (especially fertility)
// and the user should consciously opt in. The toggles only gate which
// SECTIONS render inside the popover — the button itself is always
// visible because the 用户备注 editor needs a permanent entry point
// (see `InfoButton`).
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
// Master switch for the 烂梗库's networking. When off, the panel issues no
// requests at all — no list fetch, no 30s polling, no copy-count reports — so a
// privacy-conscious user can fully opt out of the LAPLACE memes service. Off by
// default: users consciously opt in to the network activity.
export const memesEnabled = gmSignal('memesEnabled', false)
export const dialogOpen = gmSignal('dialogOpen', false)

// Per-section open state for the Settings tab accordions. All default closed
// so the tab loads compact; user-toggled state is persisted per-section so
// users only have to open the panels they care about once.
export const settingsRulesOpen = gmSignal('settingsRulesOpen', false)
export const settingsBlacklistOpen = gmSignal('settingsBlacklistOpen', false)
export const settingsLlmOpen = gmSignal('settingsLlmOpen', false)
export const settingsAutoSeekOpen = gmSignal('settingsAutoSeekOpen', false)
export const settingsFeaturesOpen = gmSignal('settingsFeaturesOpen', false)
export const settingsUserNotesOpen = gmSignal('settingsUserNotesOpen', false)
export const settingsLogOpen = gmSignal('settingsLogOpen', false)
export const settingsImportExportOpen = gmSignal('settingsImportExportOpen', false)
// Persisted width (in CSS px) of the floating panel. Default 300 matches the
// pre-resize hard-coded `w-[300px]`. The resize handle clamps writes to
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
export const autoBlendUseReplacements = gmSignal('autoBlendUseReplacements', true)
// When true, drop incoming danmaku that exactly match the last text we
// auto-sent so a chat that keeps repeating the same line after our
// cooldown can't trigger another duplicate auto-send. Tracked only across
// the lifetime of one startAutoBlend session (cleared on stop).
export const autoBlendAvoidRepeat = gmSignal('autoBlendAvoidRepeat', false)
// "YOLO" mode for 自动融入: when on, every trend the auto-blend
// detector triggers on is run through the LLM (using the autoBlend
// prompt) before sending. Off by default so existing users don't
// suddenly start emitting AI-rewritten danmaku without opting in.
// Polish happens once per trigger (not once per repeat) to preserve
// the existing N-repeat semantics — one trend → N identical sends,
// just polished now — and to keep LLM costs bounded by triggers.
export const autoBlendYolo = gmSignal('autoBlendYolo', false)
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

// AI Chat prompt scope. Two-stage seed lineage:
//
// - v1 (legacy) shipped a single default. Tracked via
//   `llmPromptsAiChatSeeded`. Users on that build either have the
//   single default at index 0, or a customised list.
// - v2 ships four distinct persona templates (杠精 / 吐槽役 /
//   暖男 / 互动派). Tracked via `llmPromptsAiChatSeededV2`.
//
// v2 migration is **additive**: it merges any v2 templates the user
// doesn't already have (exact content match) onto the end of their
// list, preserving customisations and the v1 default. Fresh installs
// (empty list) get the full v2 lineup. Both v1 and v2 flags get set
// after the v2 run so neither stage re-seeds.
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

// AI Chat settings — drive the "AI 陪聊" section appended to the 同传 tab.
// All gmSignals because user-tuned values (cadence, context budget,
// auto-vs-review preference, sampling temperature) must survive reloads;
// the transcript / candidate buffers themselves stay ephemeral and live
// next to the other runtime signals at the bottom of this file.
//
// Defaults mirror the ones laplace-cap's `useAiChatter` ships with so the
// "out of the box" behaviour reads identically once the user provides
// an LLM key and an active aiChat prompt:
// - `aiChatEnabled`           — master switch, off until the user opts in
// - `aiChatAutoSend`          — Review mode by default; flipping this on
//                               makes the engine bypass the candidate
//                               list and enqueue accepted danmaku
//                               straight away
// - `aiChatContextMaxChars`   — char budget for the rolling context
//                               summary fed to the LLM
// - `aiChatMaxMessageLength`  — cap on the generated danmaku length
//                               (also fed into the JSON schema as
//                               `message.maxLength`)
// - `aiChatViewerWindow`      — ring-buffer size for in-page viewer
//                               danmaku consumed as context
// - `aiChatViewerInterval`    — fire a viewer-only generation every N
//                               new viewer messages (laplace-cap
//                               default = 10)
// - `aiChatTemperature`       — sampling temperature passed to
//                               `chatCompletion`; defaults to OpenAI's
//                               own UI default to avoid surprises
export const aiChatEnabled = gmSignal('aiChatEnabled', false)
export const aiChatAutoSend = gmSignal('aiChatAutoSend', false)
export const aiChatContextMaxChars = gmSignal('aiChatContextMaxChars', 2048)
export const aiChatMaxMessageLength = gmSignal('aiChatMaxMessageLength', 40)
export const aiChatViewerWindow = gmSignal('aiChatViewerWindow', 50)
export const aiChatViewerInterval = gmSignal('aiChatViewerInterval', 10)
export const aiChatTemperature = gmSignal('aiChatTemperature', 0.7)

// ---------------------------------------------------------------------------
// STT (同传) settings
// ---------------------------------------------------------------------------
// The 同传 tab supports multiple realtime providers. `sttProvider` picks the
// active one; each provider keeps its own api key + model, while the output /
// capture settings (auto-send, segment length, 【】 wrap, mic device) are
// shared across providers under provider-neutral `stt*` keys. Default stays
// `soniox` so existing users see no change.
export const sttProvider = gmSignal<SttProvider>('sttProvider', 'soniox')

// --- Soniox (provider-specific) ---
export const sonioxApiKey = gmSignal('sonioxApiKey', '')
// Real-time STT model. Default `stt-rt-v5` preserves the behaviour from
// when the model was hard-coded — existing users keep the same model until
// they pick another. `sonioxModels` caches the most recently fetched list
// (id + optional name) so the dropdown stays populated across reloads
// without re-hitting Soniox's /v1/models endpoint on every mount, mirroring
// how `llmModels` caches the LLM catalog.
export const sonioxModel = gmSignal('sonioxModel', 'stt-rt-v5')
export const sonioxModels = gmSignal<SonioxModel[]>('sonioxModels', [])
export const sonioxLanguageHints = gmSignal<string[]>('sonioxLanguageHints', ['zh'])
// Realtime translation is Soniox-only (ElevenLabs Scribe is transcription-
// only), so these stay provider-specific; the tab hides the translation
// section when another provider is active.
export const sonioxTranslationEnabled = gmSignal('sonioxTranslationEnabled', false)
export const sonioxTranslationTarget = gmSignal('sonioxTranslationTarget', 'en')

// --- ElevenLabs (provider-specific) ---
export const elevenLabsApiKey = gmSignal('elevenLabsApiKey', '')
// No model setting: `scribe_v2_realtime` is the only realtime Scribe model and
// ElevenLabs exposes no API to list STT models, so the id is hardcoded in the
// engine (see `ELEVENLABS_DEFAULT_MODEL` in `stt-tab.tsx`).
// Single ISO-639-1/3 code, or empty for auto-detect — the shape Scribe's
// `languageCode` takes (not a multi-hint list like Soniox).
export const elevenLabsLanguageCode = gmSignal('elevenLabsLanguageCode', '')

// --- Deepgram (provider-specific) ---
export const deepgramApiKey = gmSignal('deepgramApiKey', '')
// Default `nova-3` (Deepgram's flagship realtime model). `deepgramModels`
// caches the streaming-filtered list from /v1/models so the dropdown stays
// populated across reloads, mirroring `sonioxModels`.
export const deepgramModel = gmSignal('deepgramModel', 'nova-3')
export const deepgramModels = gmSignal<SttModelOption[]>('deepgramModels', [])
// `multi` enables nova-3 multilingual code-switching; or a specific BCP-47 / ISO
// code. (Deepgram has no "auto"; `multi` is the closest for mixed-language streams.)
export const deepgramLanguage = gmSignal('deepgramLanguage', 'multi')

// --- Gladia (provider-specific) ---
export const gladiaApiKey = gmSignal('gladiaApiKey', '')
// Gladia realtime is one model family (`solaria-1`) with no list endpoint, so
// the id is hardcoded in the engine — no model signal, like ElevenLabs. Single
// language code ('' = auto-detect with code-switching).
export const gladiaLanguage = gmSignal('gladiaLanguage', '')

// --- Shared output / capture (every provider) ---
// These were Soniox-prefixed before multi-provider support; migrate the
// persisted values to neutral keys one time. Idempotent and sentinel-guarded
// per key — copy the old value only if the new key is unset, then delete the
// old key — so it self-disables once migrated, and a re-imported pre-upgrade
// backup (which rewrites the old key then reloads, see `settings-io.ts`) is
// migrated again on the next load.
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
// Empty string = use system default microphone. Validated against the live
// device list before each start so a stale id (mic unplugged across
// sessions) silently falls back to default instead of erroring out.
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

// Drop the now-removed `autoBlendIncludeReply` setting — @ replies are
// always excluded from the auto-blend detector, so the persisted
// preference is dead weight. Sentinel-based existence check (rather
// than a value check) so we delete the key whether the user had it on
// or off, but still skip the GM write entirely after the first run.
;(() => {
  const sentinel = Symbol()
  if (GM_getValue<unknown>('autoBlendIncludeReply', sentinel) !== sentinel) {
    GM_deleteValue('autoBlendIncludeReply')
  }
})()

// Replacement rules
// Master switch for the cloud-synced replacement rules. Off by default — the
// shared 云端词库 is opinionated, so users opt in consciously. When off,
// `buildReplacementMap` skips the remote layer and the periodic auto-sync is
// paused (local global / room rules are unaffected). "刷新生效" doesn't apply —
// the map is rebuilt immediately on toggle.
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

// Live metrics published by `lib/auto-seek.ts`. Kept out of GM so a
// stale page-reload value doesn't paint a fake "你当前的延迟" before
// the first real tick lands. Consumers (SettingsTab) read these as
// regular signal values — Preact re-renders on change automatically.
//
// `autoSeekCurrentBufferLen`: seconds buffered ahead of the playhead.
//   1:1 proxy for live-stream latency (buffered seconds ≈ how far
//   behind real-time the viewer is).
// `autoSeekCurrentRate`: the most recent `video.playbackRate` we
//   observed (whether we set it or another script did).
export const autoSeekCurrentBufferLen = signal(0)
export const autoSeekCurrentRate = signal(1)

// Ephemeral STT → AI Chat bridge. `SttTab.onPartialResult` appends each
// finalised chunk to `sttTranscriptBuffer` (and flips `sttEndpointReached`
// when Soniox emits its `<end>` token); the AI Chat engine consumes both
// at generation time and clears them. Kept out of GM storage so a page
// reload during an active stream doesn't leave a stale buffer waiting to
// be sent to the LLM on next mount.
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

// User-pinned emotes, surfaced as the leftmost "收藏" tab in the picker.
// GM-persisted so favorites survive reloads and follow the user across rooms;
// stores self-contained snapshots (see `FavoriteEmote`) so a room-exclusive
// emote can still render — grayed out — when viewed from a different room.
export const favoriteEmotes = gmSignal<FavoriteEmote[]>('favoriteEmotes', [])

// Fasong tab shared text
export const fasongText = signal('')
