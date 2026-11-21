/**
 * AI Chat engine — "viewer-persona" generation loop backing the AI 融入 section.
 * Every outgoing message is recorded in a 30s Set so the danmaku subscription
 * can drop the echo of our own send when Bilibili broadcasts it back (robust to
 * the logged-in account changing mid-session — no stable uid needed).
 */

import { batch, effect, signal } from '@preact/signals'

import type { LlmProviderProfile } from './store'
import type { LabeledFrame, SceneCutEvent, VisionFrame } from './vision/types'

import { ensureRoomId, getCsrfToken } from './api'
import { isCopyNinjaMember } from './copy-ninja/settings'
import { type DanmakuEvent, subscribeDanmaku } from './danmaku-stream'
import {
  type ChatCompletionResponseFormat,
  chatCompletion,
  classifyMediaRejection,
  type LlmContentPart,
  modelRejectsImages,
} from './llm'
import { isLlmReady } from './llm-tasks'
import { appendLog } from './log'
import { getActiveLlmPrompt } from './prompts'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeLlmProvider,
  aiChatAutoSend,
  aiChatContextMaxChars,
  aiChatMaxMessageLength,
  aiChatTemperature,
  aiChatViewerInterval,
  aiChatViewerWindow,
  sttEndpointReached,
  sttTranscriptBuffer,
  sttUtteranceStartedAt,
  visionClipEnabled,
  visionEnabled,
  visionMaxEdge,
  visionMaxFrames,
  visionMode,
  visionVisualTrigger,
} from './store'
import { isRecord, parseEmbeddedJson } from './utils'
import { describeAvailability } from './vision/availability'
import { requestFreshScene } from './vision/captioner'
import { getRecentClip } from './vision/clip-recorder'
import { clampVisionFrames, resolveVisionEdge } from './vision/config'
import { getKeptFrames, getLatestLuma, grabCurrentFrame, onSceneCut, visionAvailability } from './vision/frame-sampler'
import { lumaDiff, SAME_SCENE_DIFF, SCENE_CUT_DIFF } from './vision/luma'
import { latestScene, recordScene } from './vision/scene-memory'
import { selectFrames } from './vision/select-frames'

export interface ViewerChatEntry {
  uname: string | null
  uid: string | null
  text: string
  receivedAt: number
}

export interface AiChatDecision {
  send: boolean
  message: string
  reason: string
  /** Picture note for this round (the model's own, or the caption note); '' when none. */
  scene: string
  /** Whether `message` depends on what's on screen. */
  usesScene: boolean
}

/** UI thumbnail of a frame attached to an AI 融入 call. */
export interface AiChatFrameThumb {
  thumbUrl: string
  label: string
}

export interface AiChatCandidate {
  id: number
  transcript: string
  decision: AiChatDecision
  createdAt: number
  frames: AiChatFrameThumb[]
  /** The picture changed a lot before the decision landed. */
  stale: boolean
}

export interface AiChatHistoryEntry {
  id: number
  /** The transcript excerpt that drove the LLM call. Empty for viewer-only. */
  transcript: string
  /** Outgoing chat message, or empty when LLM skipped / user skipped. */
  message: string
  /** Reason — either the LLM's `reason` field or a synthetic user-side note. */
  reason: string
  sent: boolean
  decidedAt: number
  frames: AiChatFrameThumb[]
  /** Picture note for this round; '' when none. */
  scene: string
}

export type AiChatEngineStatus = 'idle' | 'waiting' | 'generating' | 'disabled'

/** Candidates emitted in Review mode (`aiChatAutoSend === false`). */
export const pendingCandidates = signal<AiChatCandidate[]>([])

/** Decision log for both modes; capped at FINISHED_HISTORY_CAP. */
export const aiChatHistory = signal<AiChatHistoryEntry[]>([])

/** Coarse state for the status pill in the section header. */
export const aiChatStatus = signal<AiChatEngineStatus>('disabled')

/** Wall-clock ms of the most recent decided generation; null until first this session. */
export const aiChatLastGenAt = signal<number | null>(null)

/** Monotonic count of viewer messages observed since engine start. */
export const aiChatViewerCount = signal(0)

/** Last notable vision problem for the UI (e.g. model rejects images); '' when fine. */
export const aiChatVisionNote = signal('')

/** `aiChatVisionNote` while the model's cached entry rules out images. */
export const TEXT_ONLY_MODEL_NOTE = '当前模型不支持图片输入'

/** prompt_tokens of the latest AI 融入 call, or null. */
export const aiChatLastPromptTokens = signal<number | null>(null)

/** Most-recent N viewer messages (ring; trimmed to `aiChatViewerWindow`). */
const viewerBuffer: ViewerChatEntry[] = []

/** Rolling (transcript, emitted-or-skipped) pairs fed into the context summary; `unsent` marks a reply that never posted, `scene` is the round's picture note. */
const conversationHistory: { transcript: string; chat: string; unsent?: boolean; scene: string }[] = []

let viewerReceivedSinceLastGen = 0

/** Independent per-send marks, stamped at dispatch, to filter our own echoes. */
const recentOutgoingSends = new Set<{ text: string; at: number }>()

const OUTGOING_TTL_MS = 30_000
const OUTGOING_CAP = 64

const HISTORY_ENTRIES_CAP = 50
const PENDING_CAP = 30
const FINISHED_HISTORY_CAP = 50

let nextEntryId = 1

type TriggerReason = 'transcript' | 'viewer' | 'manual' | 'visual'

let unsubscribeDanmaku: (() => void) | null = null
let unsubscribeSceneCut: (() => void) | null = null
let stopBufferEffect: (() => void) | null = null
let scheduledTimer: ReturnType<typeof setTimeout> | null = null
let scheduledReason: TriggerReason | null = null
let lastVisualTriggerAt: number | null = null
let inflight = false
let startCount = 0
/** Bumped on teardown; a send from an older session is dropped, even from the send queue. */
let session = 0

/** Buffer looks ready (endpoint detected / sentence-final / long). */
const DEBOUNCE_READY_MS = 500
/** Buffer not yet ready — wait longer so a sentence can finish forming. */
const DEBOUNCE_FALLBACK_MS = 8_000
/** Re-arm delay after a generation finishes and more content has landed. */
const DEBOUNCE_AFTER_GEN_VIEWER_MS = 3_000

const SENTENCE_END_REGEX = /[。.！!？?]$/
const READY_BUFFER_LEN = 200

/** Hard cap on one LLM call; a stalled fetch would leave `inflight` stuck true forever. */
const LLM_CALL_TIMEOUT_MS = 45_000

const TRANSCRIPT_VISION_WINDOW_MS = 20_000
const VIEWER_VISION_WINDOW_MS = 12_000
/** An unchanged picture re-uses the last upload's scene note within this age instead of re-uploading. */
const UNCHANGED_SCENE_MAX_AGE_MS = 60_000
const CAPTION_FRESH_MS = 15_000
const CAPTION_WAIT_MS = 8_000
/** A visual round needs a caption of the new picture, not the pre-cut one. */
const VISUAL_CAPTION_FRESH_MS = 3_000
const VISUAL_MIN_INTERVAL_MS = 60_000
/** Same reason as LLM_CALL_TIMEOUT_MS: a stuck frame grab or clip finalize must not hold `inflight`. */
const VISION_GATHER_TIMEOUT_MS = 10_000
const SCENE_MAX_CHARS = 40

const VISION_RULES =
  '你能看到直播画面（按时间先后排列，最后一张或视频结尾是当前画面）。\n' +
  '- 像真实观众一样对看到的内容做反应，不要描述或复述画面（不要说"画面中""我看到"）\n' +
  '- 只在画面里有具体、值得一提的细节时才提及；看不清或不确定的细节不要说\n' +
  '- 画面里的滚动文字、聊天框通常是叠加的弹幕，不是主播在说话\n' +
  '- 不评论主播的身材、长相，不读出画面中的个人信息\n\n'
const SCENE_TEXT_HINT = '上下文中的 [当前画面] / [画面] 是直播画面的文字描述，仅供理解语境，不要复述。\n\n'
const IMAGE_UNSUPPORTED_NOTE = '当前模型不支持图片输入，已改为纯文本'
const STALE_SKIP_REASON = '画面已变化，放弃可能过时的弹幕'

/** Media sent with one round, and the text that stands in when none is. */
interface GatheredVision {
  /** Labelled frame parts appended after the user text; [] for a text-only request. */
  frameParts: LlmContentPart[]
  /** Clip parts sent instead of `frameParts`, which stay the retry if the clip is rejected; null without a clip. */
  clipParts: LlmContentPart[] | null
  /** Frames behind `frameParts`, oldest first. */
  frames: LabeledFrame[]
  /** Line appended to the user text; '' when none. */
  note: string
  /** Picture description carried as text in `note` (caption or unchanged picture); '' otherwise. */
  textScene: string
}

const NO_VISION: GatheredVision = { frameParts: [], clipParts: null, frames: [], note: '', textScene: '' }

/** Session media downgrades per provider:base:model: 'frames' = clips rejected, 'none' = images rejected too. */
const mediaDowngrades = new Map<string, 'frames' | 'none'>()

/** Newest frame of the last request that carried media; drives the unchanged-picture dedupe. */
let lastUpload: { at: number; luma: Uint8Array } | null = null

function pruneRecentOutgoing(): void {
  const now = Date.now()
  for (const mark of recentOutgoingSends) {
    if (now - mark.at > OUTGOING_TTL_MS) recentOutgoingSends.delete(mark)
  }
}

/** Marks `text` as our own send; undo removes only this send's mark. */
function markOutgoing(text: string): () => void {
  const trimmed = text.trim()
  if (!trimmed) return () => {}
  pruneRecentOutgoing()
  const mark = { text: trimmed, at: Date.now() }
  recentOutgoingSends.add(mark)
  if (recentOutgoingSends.size > OUTGOING_CAP) {
    const oldest = recentOutgoingSends.values().next().value
    if (oldest !== undefined) recentOutgoingSends.delete(oldest)
  }
  return () => {
    recentOutgoingSends.delete(mark)
  }
}

function isLikelySelfEcho(text: string): boolean {
  pruneRecentOutgoing()
  const trimmed = text.trim()
  for (const mark of recentOutgoingSends) {
    if (mark.text === trimmed) return true
  }
  return false
}

/**
 * Compose the rolling context block for the LLM user message (newest history
 * at the bottom). Viewer-chat block is prepended only if it fits the first half
 * of the char budget, else it pushes off too much history. Budget is chars not
 * tokens — that's what the user configures (`aiChatContextMaxChars`).
 */
function buildContextSummary(
  history: typeof conversationHistory,
  maxChars: number,
  viewerChats: ViewerChatEntry[]
): string {
  const combined: string[] = []
  let totalLength = 0
  if (viewerChats.length > 0) {
    const chatLines = viewerChats.map(c => `  ${c.uname ?? '观众'}: ${c.text}`).join('\n')
    const viewerBlock = `[最近观众弹幕]:\n${chatLines}`
    if (viewerBlock.length < Math.max(1, Math.floor(maxChars / 2))) {
      combined.push(viewerBlock)
      totalLength += viewerBlock.length
    }
  }
  for (let i = history.length - 1; i >= 0; i--) {
    const { transcript, chat, unsent, scene } = history[i]
    const reply = `${unsent ? '[你未能发送]' : '[你已发送]'}: ${chat}`
    // Viewer-only rounds have no transcript; an empty [主播] line just confuses the model.
    const round = transcript.trim() ? `[主播]: ${transcript}\n${reply}` : reply
    const block = scene ? `[画面]: ${scene}\n${round}` : round
    if (totalLength + block.length > maxChars) break
    combined.unshift(block)
    totalLength += block.length
  }
  return combined.join('\n\n')
}

function isReadyForGen(buffer: string): boolean {
  if (sttEndpointReached.value) return true
  if (SENTENCE_END_REGEX.test(buffer.trim())) return true
  if (buffer.length > READY_BUFFER_LEN) return true
  return false
}

/** `withScene` (media attached) also reads the model's `scene` / `uses_scene`. */
function parseDecision(content: string, maxLen: number, withScene: boolean): AiChatDecision {
  let obj: unknown
  try {
    obj = JSON.parse(content)
  } catch {
    // Providers that ignore `response_format` may wrap JSON in prose.
    obj = parseEmbeddedJson(content)
  }
  if (!isRecord(obj)) {
    throw new Error('LLM 返回内容无法解析为 JSON')
  }
  const send = obj.send === true
  let message = typeof obj.message === 'string' ? obj.message.trim() : ''
  if (message.length > maxLen) message = message.slice(0, maxLen)
  const reason = typeof obj.reason === 'string' ? obj.reason : ''
  if (!withScene) return { send, message, reason, scene: '', usesScene: false }
  // Cut by code point so an emoji is never split.
  const scene = typeof obj.scene === 'string' ? Array.from(obj.scene.trim()).slice(0, SCENE_MAX_CHARS).join('') : ''
  return { send, message, reason, scene, usesScene: obj.uses_scene === true }
}

// Vendor support for structured output varies (DeepSeek's native API 400s on `json_schema`, accepting only `json_object`). Remember the best working mode per provider config for the session; downgrade json_schema → json_object → none on rejection.
type ResponseFormatMode = 'json_schema' | 'json_object' | 'none'
const responseFormatModes = new Map<string, ResponseFormatMode>()

function buildResponseFormat(
  mode: ResponseFormatMode,
  maxLen: number,
  withScene: boolean
): ChatCompletionResponseFormat | undefined {
  if (mode === 'none') return undefined
  if (mode === 'json_object') return { type: 'json_object' }
  const properties = {
    send: { type: 'boolean' },
    message: { type: 'string', maxLength: maxLen },
    reason: { type: 'string' },
    ...(withScene && {
      scene: { type: 'string', maxLength: SCENE_MAX_CHARS },
      uses_scene: { type: 'boolean' },
    }),
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'ai_chat_response',
      strict: true,
      schema: {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
      },
    },
  }
}

/** JSON reply instructions for the system prompt; `withScene` adds the picture fields. */
function replyFormatInstructions(maxLen: number, withScene: boolean): string {
  const sceneFields = withScene
    ? '- "scene" (string)：用不超过 20 个字记录当前画面要点，仅供你之后参考，不会发送\n' +
      '- "uses_scene" (boolean)：message 是否依赖画面内容\n'
    : ''
  // Literal example required by DeepSeek's json_object mode; harmless elsewhere.
  const example = withScene
    ? '{"send": true, "message": "要发送的弹幕", "reason": "简短理由", "scene": "画面要点", "uses_scene": false}'
    : '{"send": true, "message": "要发送的弹幕", "reason": "简短理由"}'
  return (
    `你必须返回一个 JSON 对象，包含${withScene ? '五' : '三'}个字段：\n` +
    '- "send" (boolean)：当前内容是否值得作为弹幕发送\n' +
    `- "message" (string)：要发送的弹幕，长度不超过 ${maxLen} 个字符；send 为 false 时为空串\n` +
    '- "reason" (string)：你做此决定的简短理由\n' +
    sceneFields +
    `返回示例：${example}\n`
  )
}

/** HTTP 4xx whose body mentions response_format = the vendor rejecting the directive, not a transient failure. */
function isResponseFormatRejection(err: unknown): boolean {
  return err instanceof Error && /HTTP 4\d\d/.test(err.message) && err.message.toLowerCase().includes('response_format')
}

interface AiChatConfig {
  systemPrompt: string
  provider: LlmProviderProfile
}

/** Active prompt and provider, or null (logged) when AI 融入 can't call the LLM. */
function readAiChatConfig(): AiChatConfig | null {
  const systemPrompt = getActiveLlmPrompt('aiChat')
  if (!systemPrompt.trim()) {
    appendLog('⚠️ [AI 融入] 未配置 AI 融入提示词')
    return null
  }
  const provider = activeLlmProvider.value
  if (!provider?.apiBase.trim() || !provider.apiKey.trim() || !provider.model.trim()) {
    appendLog('⚠️ [AI 融入] LLM 配置不完整，请检查「设置 → LLM 设置」')
    return null
  }
  return { systemPrompt, provider }
}

/** Whether the active model's cached entry rules out images; direct mode then attaches none. */
export function aiChatModelRejectsImages(): boolean {
  const provider = activeLlmProvider.value
  return !!provider && modelRejectsImages(provider.models, provider.model.trim())
}

function mediaKey(provider: LlmProviderProfile): string {
  return `${provider.id}:${provider.apiBase}:${provider.model}`
}

/** Earliest capture time a round's frames may come from: the utterance (≤ 20 s), the viewer burst, or just before the cut (`preCutAt`: capture time of the last frame kept before it). */
function visionWindowStart(
  reason: TriggerReason,
  now: number,
  utteranceStartedAt: number | null,
  preCutAt: number | null
): number {
  switch (reason) {
    case 'transcript': {
      const floor = now - TRANSCRIPT_VISION_WINDOW_MS
      return Math.max(utteranceStartedAt ?? floor, floor) - 1000
    }
    case 'viewer':
      return now - VIEWER_VISION_WINDOW_MS
    case 'visual':
      return (preCutAt ?? now - 3000) - 500
    case 'manual':
      return now
  }
}

/** The last upload's scene note when the picture still matches it, else null. */
function unchangedScene(current: VisionFrame, now: number): string | null {
  if (!lastUpload || now - lastUpload.at >= UNCHANGED_SCENE_MAX_AGE_MS) return null
  if (lumaDiff(current.luma, lastUpload.luma) >= SAME_SCENE_DIFF) return null
  const note = latestScene(UNCHANGED_SCENE_MAX_AGE_MS)
  // A note older than the upload describes an earlier picture.
  return note && note.at >= lastUpload.at ? note.scene : null
}

async function gatherCaptionVision(reason: TriggerReason): Promise<GatheredVision> {
  aiChatVisionNote.value = ''
  const note =
    (reason === 'visual' ? null : latestScene(CAPTION_FRESH_MS)) ??
    (await requestFreshScene(reason === 'visual' ? VISUAL_CAPTION_FRESH_MS : CAPTION_FRESH_MS, CAPTION_WAIT_MS))
  return note ? { ...NO_VISION, note: `[当前画面]: ${note.scene}`, textScene: note.scene } : NO_VISION
}

async function gatherDirectVision(
  provider: LlmProviderProfile,
  reason: TriggerReason,
  utteranceStartedAt: number | null,
  preCutAt: number | null
): Promise<GatheredVision> {
  const downgrade = mediaDowngrades.get(mediaKey(provider))
  if (downgrade === 'none') {
    aiChatVisionNote.value = IMAGE_UNSUPPORTED_NOTE
    return NO_VISION
  }
  if (modelRejectsImages(provider.models, provider.model)) {
    aiChatVisionNote.value = TEXT_ONLY_MODEL_NOTE
    return NO_VISION
  }
  aiChatVisionNote.value = ''
  const availability = visionAvailability.value
  if (availability !== 'ok') {
    return { ...NO_VISION, note: `（当前看不到直播画面：${describeAvailability(availability)}）` }
  }
  const current = await grabCurrentFrame()
  if (!current) return { ...NO_VISION, note: '（当前看不到直播画面）' }
  const now = Date.now()
  const frames = selectFrames({
    kept: getKeptFrames(),
    current,
    from: visionWindowStart(reason, now, utteranceStartedAt, preCutAt),
    max: reason === 'manual' ? 1 : clampVisionFrames(visionMaxFrames.value),
  })
  const unchanged = frames.length === 1 ? unchangedScene(current, now) : null
  if (unchanged) return { ...NO_VISION, note: `（画面与上次基本相同：${unchanged}）`, textScene: unchanged }
  // 512 px is about what 'low' detail downsamples to anyway; the hint just saves tokens.
  const lowDetail = resolveVisionEdge(visionMaxEdge.value) === 512
  const frameParts: LlmContentPart[] = [
    { type: 'text', text: '直播画面截图（按时间先后，最后一张为当前画面）：' },
    ...frames.flatMap((frame): LlmContentPart[] => [
      { type: 'text', text: `【${frame.label}】` },
      { type: 'image_url', image_url: lowDetail ? { url: frame.dataUrl, detail: 'low' } : { url: frame.dataUrl } },
    ]),
  ]
  const clip = visionClipEnabled.value && downgrade !== 'frames' ? await getRecentClip() : null
  const clipParts: LlmContentPart[] | null = clip && [
    { type: 'text', text: '最近几秒的直播画面视频片段（无声）：' },
    { type: 'video_url', video_url: { url: clip.dataUrl } },
  ]
  return { ...NO_VISION, frameParts, clipParts, frames }
}

/** Picture input for one round; never throws, and gives up after VISION_GATHER_TIMEOUT_MS. */
async function gatherVision(
  provider: LlmProviderProfile,
  reason: TriggerReason,
  utteranceStartedAt: number | null,
  preCutAt: number | null
): Promise<GatheredVision> {
  if (!visionEnabled.value) return NO_VISION
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<GatheredVision>(resolve => {
    timer = setTimeout(() => {
      appendLog('⚠️ [AI 融入] 读取直播画面超时，本轮不附带画面')
      resolve(NO_VISION)
    }, VISION_GATHER_TIMEOUT_MS)
  })
  try {
    const gathered =
      visionMode.value === 'caption'
        ? gatherCaptionVision(reason)
        : gatherDirectVision(provider, reason, utteranceStartedAt, preCutAt)
    return await Promise.race([gathered, timedOut])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`⚠️ [AI 融入] 读取直播画面失败：${msg}`)
    return NO_VISION
  } finally {
    clearTimeout(timer)
  }
}

/** Frames a request carrying `vision`'s media shows; a clip is represented by the current frame. */
function attachedFrames(vision: GatheredVision, clip: boolean): LabeledFrame[] {
  const current = vision.frames.at(-1)
  return clip && current ? [{ ...current, label: '视频片段' }] : vision.frames
}

/** Remember the newest uploaded frame for the dedupe, and the model's note of it. */
function rememberUpload(frames: readonly LabeledFrame[], scene: string): void {
  const newest = frames.at(-1)
  if (!newest) return
  lastUpload = { at: newest.at, luma: newest.luma }
  if (scene) recordScene(scene, 'chat', newest.at)
}

interface AiChatCallResult {
  decision: AiChatDecision
  /** Frames the successful request carried, oldest first; [] when it went out text-only. */
  frames: LabeledFrame[]
}

async function callAiChatLlm(
  config: AiChatConfig,
  transcript: string,
  reason: TriggerReason,
  vision: GatheredVision
): Promise<AiChatCallResult | null> {
  const { systemPrompt, provider } = config
  const maxLen = Math.max(1, aiChatMaxMessageLength.value)
  // Snapshot guards against the buffer mutating mid-call.
  const viewerSnapshot = viewerBuffer.slice(-aiChatViewerWindow.value)
  const contextSummary = buildContextSummary(conversationHistory, aiChatContextMaxChars.value, viewerSnapshot)
  const sourceText =
    transcript ||
    (reason === 'visual'
      ? '（主播没有说话；本轮由直播画面变化触发）'
      : '（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）')
  const sourceFraming = transcript
    ? '主播的语音文字来自实时语音识别，可能是片段化的句子。上下文中包含最近的发送记录与最新观众弹幕，请综合理解后再决定是否发送。\n\n'
    : reason === 'visual'
      ? '主播目前没有说话，本轮由直播画面的明显变化触发。上下文中包含最近的发送记录与最新观众弹幕；画面变化不值得回应时不要发送。\n\n'
      : '当前未启用主播语音识别，没有主播语音文字。上下文中包含最近的发送记录与最新观众弹幕，请仅基于观众弹幕综合判断后再决定是否发送。\n\n'
  const systemHead =
    `${systemPrompt}\n\n` +
    `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n` +
    sourceFraming
  const userBody = contextSummary
    ? `上下文（最近的发送 / 观众弹幕）：\n"""\n${contextSummary}\n"""\n\n主播刚刚说：\n"""\n${sourceText}\n"""\n`
    : `主播刚刚说："${sourceText}"`
  const userText = vision.note ? `${userBody}\n${vision.note}` : userBody
  const modeKey = `${provider.id}:${provider.apiBase}`
  let rfMode = responseFormatModes.get(modeKey) ?? 'json_schema'
  let media = vision.clipParts ?? vision.frameParts
  let clip = vision.clipParts !== null
  // Bound the request so a stalled fetch can't wedge the engine (see LLM_CALL_TIMEOUT_MS).
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS)
  try {
    while (true) {
      const withScene = media.length > 0
      const visionHint = withScene ? VISION_RULES : vision.textScene ? SCENE_TEXT_HINT : ''
      try {
        const content = await chatCompletion({
          base: provider.apiBase,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: [
            { role: 'system', content: systemHead + visionHint + replyFormatInstructions(maxLen, withScene) },
            { role: 'user', content: withScene ? [{ type: 'text', text: userText }, ...media] : userText },
          ],
          temperature: aiChatTemperature.value,
          responseFormat: buildResponseFormat(rfMode, maxLen, withScene),
          signal: controller.signal,
          onPromptTokens: tokens => {
            aiChatLastPromptTokens.value = tokens
          },
        })
        const decision = parseDecision(content, maxLen, withScene)
        const frames = withScene ? attachedFrames(vision, clip) : []
        rememberUpload(frames, decision.scene)
        return { decision, frames }
      } catch (err) {
        if (isResponseFormatRejection(err)) {
          const next: ResponseFormatMode | null =
            rfMode === 'json_schema' ? 'json_object' : rfMode === 'json_object' ? 'none' : null
          if (next === null) throw err
          rfMode = next
          responseFormatModes.set(modeKey, next)
          appendLog(`ℹ️ [AI 融入] 服务商不支持当前结构化输出格式，已降级为 ${next === 'none' ? '纯提示词' : next} 重试`)
          continue
        }
        const rejection = withScene ? classifyMediaRejection(err) : null
        if (rejection === null) throw err
        // Any media complaint about a clip may still leave frames usable; about frames, only text is left.
        if (clip) {
          clip = false
          media = vision.frameParts
          mediaDowngrades.set(mediaKey(provider), 'frames')
          appendLog('ℹ️ [AI 融入] 当前模型不支持视频片段，已改用截图')
        } else if (rejection === 'payload') {
          // Too large isn't unsupported: smaller frames may pass, so only this round goes text-only.
          media = []
          appendLog(
            '⚠️ [AI 融入] 截图过大被服务商拒绝（HTTP 413），本轮改为纯文本；可在「设置 → 画面识别」调低清晰度或帧数'
          )
        } else {
          media = []
          mediaDowngrades.set(mediaKey(provider), 'none')
          aiChatVisionNote.value = IMAGE_UNSUPPORTED_NOTE
          appendLog(`⚠️ [AI 融入] ${IMAGE_UNSUPPORTED_NOTE}`)
        }
      }
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      appendLog(`⏱️ [AI 融入] LLM 调用超时（${Math.round(LLM_CALL_TIMEOUT_MS / 1000)} 秒），已跳过本次生成`)
      return null
    }
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ [AI 融入] LLM 调用失败：${msg}`)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Turns false once the engine session it was taken in is torn down. */
function sessionGuard(): () => boolean {
  const startedIn = session
  return () => session === startedIn
}

async function sendAiChatDanmaku(message: string, isCurrent: () => boolean): Promise<boolean> {
  try {
    const roomId = await ensureRoomId()
    // A torn-down session must not queue a send.
    if (!isCurrent()) return false
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ [AI 融入] 未找到登录信息，请先登录 Bilibili')
      return false
    }
    let unmark: (() => void) | undefined
    const result = await enqueueDanmaku(message, roomId, csrfToken, SendPriority.AUTO, 'ai', () => {
      if (!isCurrent()) return false
      // Mark at dispatch so cancelled queue entries never suppress viewer chat.
      unmark = markOutgoing(message)
      return true
    })
    // Cancelled or rejected sends never post; an unknown outcome keeps the mark in case it did.
    if (result.cancelled || result.rejected) unmark?.()
    appendLog(result, 'AI 融入', message)
    return result.success
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ [AI 融入] 发送失败：${msg}`)
    return false
  }
}

function appendHistory(entry: AiChatHistoryEntry): void {
  const next = [...aiChatHistory.value, entry]
  while (next.length > FINISHED_HISTORY_CAP) next.shift()
  aiChatHistory.value = next
}

function recordConvHistory(transcript: string, chat: string, unsent = false, scene = ''): void {
  // Collapse consecutive viewer-only skips: without STT they'd flood the context
  // with identical [跳过] blocks and bias the LLM into a keep-skipping spiral.
  const last = conversationHistory[conversationHistory.length - 1]
  const isViewerSkip = (t: string, c: string) => !t.trim() && c.startsWith('[跳过:')
  if (last && isViewerSkip(transcript, chat) && isViewerSkip(last.transcript, last.chat)) {
    last.chat = chat
    last.scene = scene
    return
  }
  conversationHistory.push({ transcript, chat, unsent, scene })
  while (conversationHistory.length > HISTORY_ENTRIES_CAP) conversationHistory.shift()
}

/** Record a skipped round so we don't loop on the same content. */
function recordSkip(transcript: string, reason: string, frames: AiChatFrameThumb[], scene: string): void {
  recordConvHistory(transcript, `[跳过:${reason || '无'}]`, false, scene)
  appendLog(`⏭️ [AI 融入] 本轮跳过：${reason || '（无理由）'}`)
  appendHistory({
    id: nextEntryId++,
    transcript,
    message: '',
    reason: reason || '（无理由）',
    sent: false,
    decidedAt: Date.now(),
    frames,
    scene,
  })
}

function addPendingCandidate(
  transcript: string,
  decision: AiChatDecision,
  frames: AiChatFrameThumb[],
  stale: boolean
): void {
  const cand: AiChatCandidate = {
    id: nextEntryId++,
    transcript,
    decision,
    createdAt: Date.now(),
    frames,
    stale,
  }
  const next = [...pendingCandidates.value, cand]
  while (next.length > PENDING_CAP) next.shift()
  pendingCandidates.value = next
}

/** A picture-dependent reply whose picture cut away while it was being generated. */
function isStale(decision: AiChatDecision, frames: readonly LabeledFrame[]): boolean {
  if (!decision.usesScene) return false
  const newest = frames.at(-1)
  const latest = getLatestLuma()
  return !!newest && !!latest && lumaDiff(latest, newest.luma) >= SCENE_CUT_DIFF
}

async function runGeneration(reason: TriggerReason, preCutAt: number | null = null): Promise<void> {
  if (inflight) return
  const isCurrent = sessionGuard()
  // Snapshot + clear atomically; content landing during the await starts the next round.
  // Batched so the buffer effect can't see the cleared buffer with the endpoint still set and re-schedule.
  const transcript = sttTranscriptBuffer.value
  const utteranceStartedAt = sttUtteranceStartedAt.value
  batch(() => {
    sttTranscriptBuffer.value = ''
    // A round that consumed no speech keeps the in-progress utterance's start.
    if (transcript.trim()) sttUtteranceStartedAt.value = null
    sttEndpointReached.value = false
  })
  viewerReceivedSinceLastGen = 0

  // Transcript-driven runs need content; the others may proceed empty (observer-only context).
  if (reason === 'transcript' && !transcript.trim()) {
    return
  }

  inflight = true
  aiChatStatus.value = 'generating'
  try {
    const config = readAiChatConfig()
    if (!config) return
    const vision = await gatherVision(config.provider, reason, utteranceStartedAt, preCutAt)
    if (!isCurrent()) return
    // A picture-change round that can't see the picture has nothing to react to.
    if (reason === 'visual' && vision.frames.length === 0 && !vision.textScene) return
    const result = await callAiChatLlm(config, transcript.trim(), reason, vision)
    if (!result) {
      // callAiChatLlm already logged the failure
      return
    }
    if (!isCurrent()) return
    aiChatLastGenAt.value = Date.now()
    const decision = { ...result.decision, scene: result.decision.scene || vision.textScene }
    const frames = result.frames.map(({ thumbUrl, label }) => ({ thumbUrl, label }))

    if (decision.send && decision.message.trim()) {
      const stale = isStale(decision, result.frames)
      if (aiChatAutoSend.value) {
        if (stale) {
          recordSkip(transcript, STALE_SKIP_REASON, frames, decision.scene)
          return
        }
        const ok = await sendAiChatDanmaku(decision.message, isCurrent)
        if (!isCurrent()) return
        recordConvHistory(transcript, decision.message, !ok, decision.scene)
        appendHistory({
          id: nextEntryId++,
          transcript,
          message: decision.message,
          reason: decision.reason,
          sent: ok,
          decidedAt: Date.now(),
          frames,
          scene: decision.scene,
        })
      } else {
        // Review mode — record with a `[候选]` marker so the LLM won't re-propose
        // before the user acts.
        addPendingCandidate(transcript, decision, frames, stale)
        recordConvHistory(transcript, `[候选:${decision.message}]`, false, decision.scene)
      }
    } else {
      recordSkip(transcript, decision.reason, frames, decision.scene)
    }
  } finally {
    // A run from a torn-down session leaves the mutex and status pill to the session that replaced it.
    if (isCurrent()) {
      inflight = false
      aiChatStatus.value = scheduledTimer ? 'waiting' : 'idle'
    }
  }
}

function clearScheduled(): void {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
    scheduledReason = null
  }
}

/** Returns whether a round was scheduled. */
function scheduleGeneration(delay: number, reason: TriggerReason, preCutAt: number | null = null): boolean {
  // Gate here so a later LLM configure flips it via the parent effect's tracking,
  // without an engine restart.
  if (!isLlmReady('aiChat')) return false
  clearScheduled()
  scheduledReason = reason
  aiChatStatus.value = 'waiting'
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null
    const r = scheduledReason ?? reason
    scheduledReason = null
    void runGeneration(r, preCutAt)
  }, delay)
  return true
}

/** Scene-cut listener: lets a big picture change fill a silence, at most once a minute. */
function handleSceneCut(event: SceneCutEvent): void {
  if (!visionEnabled.value || !visionVisualTrigger.value) return
  if (inflight || scheduledTimer || sttTranscriptBuffer.value.trim()) return
  const now = Date.now()
  const lastGenAt = aiChatLastGenAt.value
  if (lastGenAt !== null && now - lastGenAt < VISUAL_MIN_INTERVAL_MS) return
  if (lastVisualTriggerAt !== null && now - lastVisualTriggerAt < VISUAL_MIN_INTERVAL_MS) return
  if (!scheduleGeneration(DEBOUNCE_READY_MS, 'visual', event.before?.at ?? null)) return
  lastVisualTriggerAt = now
}

export function triggerNow(): void {
  clearScheduled()
  void runGeneration('manual')
}

export function acceptCandidate(id: number, editedMessage?: string): void {
  const cand = pendingCandidates.value.find(c => c.id === id)
  if (!cand) return
  const raw = editedMessage ?? cand.decision.message
  const message = raw.trim()
  if (!message) {
    appendLog('⚠️ [AI 融入] 发送内容为空')
    return
  }
  pendingCandidates.value = pendingCandidates.value.filter(c => c.id !== id)
  const isCurrent = sessionGuard()
  void (async () => {
    const ok = await sendAiChatDanmaku(message, isCurrent)
    if (!isCurrent()) return
    appendHistory({
      id: nextEntryId++,
      transcript: cand.transcript,
      message,
      reason: cand.decision.reason,
      sent: ok,
      decidedAt: Date.now(),
      frames: cand.frames,
      scene: cand.decision.scene,
    })
  })()
}

export function skipCandidate(id: number): void {
  const cand = pendingCandidates.value.find(c => c.id === id)
  if (!cand) return
  pendingCandidates.value = pendingCandidates.value.filter(c => c.id !== id)
  appendHistory({
    id: nextEntryId++,
    transcript: cand.transcript,
    message: '',
    reason: cand.decision.reason ? `（用户跳过）${cand.decision.reason}` : '（用户跳过）',
    sent: false,
    decidedAt: Date.now(),
    frames: cand.frames,
    scene: cand.decision.scene,
  })
}

export function clearPendingCandidates(): void {
  pendingCandidates.value = []
}

export function clearAiChatHistory(): void {
  aiChatHistory.value = []
}

/**
 * Start the engine (idempotent + reference-counted). First caller wires the
 * danmaku subscription and the debounce effect; pair 1:1 with `stopAiChatEngine`.
 */
export function startAiChatEngine(): void {
  startCount++
  if (startCount > 1) return

  // Deliberately keep `aiChatHistory` across off/on toggles; clear pending
  // candidates since their transcripts may no longer be relevant.
  viewerBuffer.length = 0
  conversationHistory.length = 0
  viewerReceivedSinceLastGen = 0
  pendingCandidates.value = []
  aiChatViewerCount.value = 0
  // A dispatched send can still echo after a restart.
  pruneRecentOutgoing()
  // Reset so a restart recovers an engine left wedged by a stalled in-flight call.
  inflight = false
  clearScheduled()
  // Clear stale STT state so we don't fire on content accumulated while off.
  sttTranscriptBuffer.value = ''
  sttEndpointReached.value = false
  sttUtteranceStartedAt.value = null

  unsubscribeSceneCut = onSceneCut(handleSceneCut)
  unsubscribeDanmaku = subscribeDanmaku({
    onMessage: (ev: DanmakuEvent) => {
      const text = ev.text.trim()
      if (!text) return
      // Drop our own echoes, Copy Ninja group copies, and 大表情 emotes (display names, not textual context).
      if (isLikelySelfEcho(text)) return
      if (ev.uid && isCopyNinjaMember(ev.uid)) return
      if (ev.hasLargeEmote) return
      const entry: ViewerChatEntry = {
        uname: ev.uname,
        uid: ev.uid,
        text,
        receivedAt: Date.now(),
      }
      viewerBuffer.push(entry)
      const window = aiChatViewerWindow.value
      while (viewerBuffer.length > window) viewerBuffer.shift()
      aiChatViewerCount.value = aiChatViewerCount.value + 1
      viewerReceivedSinceLastGen++

      // Viewer-only trigger; only when nothing else is queued, else it double-fires.
      const interval = Math.max(1, aiChatViewerInterval.value)
      if (viewerReceivedSinceLastGen >= interval && !scheduledTimer && !inflight) {
        scheduleGeneration(DEBOUNCE_AFTER_GEN_VIEWER_MS, 'viewer')
      }
    },
  })

  stopBufferEffect = effect(() => {
    // Track both signals so an endpoint marker can pull a scheduled gen forward.
    const buffer = sttTranscriptBuffer.value
    const ep = sttEndpointReached.value
    if (!buffer.trim() && !ep) return
    if (inflight) return
    const ready = ep || isReadyForGen(buffer)
    scheduleGeneration(ready ? DEBOUNCE_READY_MS : DEBOUNCE_FALLBACK_MS, 'transcript')
  })

  aiChatStatus.value = 'idle'
}

/**
 * Decrement the ref count; at zero, tear down subscriptions, effect, and timer.
 * Idempotent past zero so a stray call can't drive the count negative.
 */
export function stopAiChatEngine(): void {
  if (startCount === 0) return
  startCount--
  if (startCount > 0) return
  session++
  // Like start: a stopped engine must not leave candidates that can still be sent.
  pendingCandidates.value = []
  if (unsubscribeDanmaku) {
    unsubscribeDanmaku()
    unsubscribeDanmaku = null
  }
  if (unsubscribeSceneCut) {
    unsubscribeSceneCut()
    unsubscribeSceneCut = null
  }
  if (stopBufferEffect) {
    stopBufferEffect()
    stopBufferEffect = null
  }
  clearScheduled()
  aiChatStatus.value = 'disabled'
}
