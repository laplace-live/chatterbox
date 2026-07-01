/**
 * AI Chat engine — "viewer-persona" generation loop backing the AI 陪聊 section.
 * Every outgoing message is recorded in a 30s Set so the danmaku subscription
 * can drop the echo of our own send when Bilibili broadcasts it back (robust to
 * the logged-in account changing mid-session — no stable uid needed).
 */

import { effect, signal } from '@preact/signals'

import { ensureRoomId, getCsrfToken } from './api'
import { type DanmakuEvent, subscribeDanmaku } from './danmaku-stream'
import { type ChatCompletionResponseFormat, chatCompletion } from './llm'
import { isLlmReady } from './llm-tasks'
import { appendLog } from './log'
import { getActiveLlmPrompt } from './prompts'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  aiChatAutoSend,
  aiChatContextMaxChars,
  aiChatMaxMessageLength,
  aiChatTemperature,
  aiChatViewerInterval,
  aiChatViewerWindow,
  llmApiBase,
  llmApiKey,
  llmModel,
  sttEndpointReached,
  sttTranscriptBuffer,
} from './store'

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
}

export interface AiChatCandidate {
  id: number
  transcript: string
  decision: AiChatDecision
  createdAt: number
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

/** Most-recent N viewer messages (ring; trimmed to `aiChatViewerWindow`). */
const viewerBuffer: ViewerChatEntry[] = []

/** Rolling (transcript, emitted-or-skipped) pairs fed into the context summary. */
const conversationHistory: { transcript: string; chat: string }[] = []

let viewerReceivedSinceLastGen = 0

/** Recent outgoing texts (text → enqueue ms); drops our own echo from `.chat-items`. */
const recentOutgoingTexts = new Map<string, number>()

const OUTGOING_TTL_MS = 30_000
const OUTGOING_CAP = 64

const HISTORY_ENTRIES_CAP = 50
const PENDING_CAP = 30
const FINISHED_HISTORY_CAP = 50

let nextEntryId = 1

let unsubscribeDanmaku: (() => void) | null = null
let stopBufferEffect: (() => void) | null = null
let scheduledTimer: ReturnType<typeof setTimeout> | null = null
let scheduledReason: 'transcript' | 'viewer' | null = null
let inflight = false
let startCount = 0

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

function pruneRecentOutgoing(): void {
  const now = Date.now()
  for (const [text, ts] of recentOutgoingTexts) {
    if (now - ts > OUTGOING_TTL_MS) recentOutgoingTexts.delete(text)
  }
}

function markOutgoing(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  pruneRecentOutgoing()
  recentOutgoingTexts.set(trimmed, Date.now())
  // Map iteration is insertion order, so the first key is the oldest.
  if (recentOutgoingTexts.size > OUTGOING_CAP) {
    const oldest = recentOutgoingTexts.keys().next().value
    if (oldest !== undefined) recentOutgoingTexts.delete(oldest)
  }
}

function isLikelySelfEcho(text: string): boolean {
  pruneRecentOutgoing()
  return recentOutgoingTexts.has(text.trim())
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
    const { transcript, chat } = history[i]
    const block = `[主播]: ${transcript}\n[你已发送]: ${chat}`
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

function parseDecision(content: string, maxLen: number): AiChatDecision {
  let obj: unknown = null
  try {
    obj = JSON.parse(content)
  } catch {
    // Providers that ignore `response_format` may wrap JSON in prose;
    // grab the outermost {…} block.
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(content.slice(start, end + 1))
      } catch {}
    }
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('LLM 返回内容无法解析为 JSON')
  }
  const o = obj as { send?: unknown; message?: unknown; reason?: unknown }
  const send = o.send === true
  let message = typeof o.message === 'string' ? o.message.trim() : ''
  if (message.length > maxLen) message = message.slice(0, maxLen)
  const reason = typeof o.reason === 'string' ? o.reason : ''
  return { send, message, reason }
}

async function callAiChatLlm(sourceText: string): Promise<AiChatDecision | null> {
  const systemPrompt = getActiveLlmPrompt('aiChat')
  if (!systemPrompt.trim()) {
    appendLog('⚠️ [AI 陪聊] 未配置 AI 陪聊提示词')
    return null
  }
  const base = llmApiBase.value
  const apiKey = llmApiKey.value
  const model = llmModel.value
  if (!base.trim() || !apiKey.trim() || !model.trim()) {
    appendLog('⚠️ [AI 陪聊] LLM 配置不完整，请检查「设置 → LLM 设置」')
    return null
  }
  const maxLen = Math.max(1, aiChatMaxMessageLength.value)
  // Snapshot guards against the buffer mutating mid-call.
  const viewerSnapshot = viewerBuffer.slice(-aiChatViewerWindow.value)
  const contextSummary = buildContextSummary(conversationHistory, aiChatContextMaxChars.value, viewerSnapshot)
  const decoratedSystem =
    `${systemPrompt}\n\n` +
    `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n` +
    '主播的语音文字来自实时语音识别，可能是片段化的句子。上下文中包含最近的发送记录与最新观众弹幕，请综合理解后再决定是否发送。\n\n' +
    '你必须返回一个 JSON 对象，包含三个字段：\n' +
    '- "send" (boolean)：当前内容是否值得作为弹幕发送\n' +
    `- "message" (string)：要发送的弹幕，长度不超过 ${maxLen} 个字符；send 为 false 时为空串\n` +
    '- "reason" (string)：你做此决定的简短理由\n'
  const userContent = contextSummary
    ? `上下文（最近的发送 / 观众弹幕）：\n"""\n${contextSummary}\n"""\n\n主播刚刚说：\n"""\n${sourceText}\n"""\n`
    : `主播刚刚说："${sourceText}"`
  const responseFormat: ChatCompletionResponseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'ai_chat_response',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          send: { type: 'boolean' },
          message: { type: 'string', maxLength: maxLen },
          reason: { type: 'string' },
        },
        required: ['send', 'message', 'reason'],
        additionalProperties: false,
      },
    },
  }
  // Bound the request so a stalled fetch can't wedge the engine (see LLM_CALL_TIMEOUT_MS).
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), LLM_CALL_TIMEOUT_MS)
  try {
    const content = await chatCompletion({
      base,
      apiKey,
      model,
      messages: [
        { role: 'system', content: decoratedSystem },
        { role: 'user', content: userContent },
      ],
      temperature: aiChatTemperature.value,
      responseFormat,
      signal: controller.signal,
    })
    return parseDecision(content, maxLen)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      appendLog(`⏱️ [AI 陪聊] LLM 调用超时（${Math.round(LLM_CALL_TIMEOUT_MS / 1000)} 秒），已跳过本次生成`)
      return null
    }
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ [AI 陪聊] LLM 调用失败：${msg}`)
    return null
  } finally {
    clearTimeout(timeoutId)
  }
}

async function sendAiChatDanmaku(message: string): Promise<boolean> {
  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ [AI 陪聊] 未找到登录信息，请先登录 Bilibili')
      return false
    }
    // Record BEFORE the send so the echo can find the entry when it broadcasts back.
    markOutgoing(message)
    const result = await enqueueDanmaku(message, roomId, csrfToken, SendPriority.AUTO)
    appendLog(result, 'AI 陪聊', message)
    return result.success
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ [AI 陪聊] 发送失败：${msg}`)
    return false
  }
}

function appendHistory(entry: AiChatHistoryEntry): void {
  const next = [...aiChatHistory.value, entry]
  while (next.length > FINISHED_HISTORY_CAP) next.shift()
  aiChatHistory.value = next
}

function recordConvHistory(transcript: string, chat: string): void {
  conversationHistory.push({ transcript, chat })
  while (conversationHistory.length > HISTORY_ENTRIES_CAP) conversationHistory.shift()
}

function addPendingCandidate(transcript: string, decision: AiChatDecision): void {
  const cand: AiChatCandidate = {
    id: nextEntryId++,
    transcript,
    decision,
    createdAt: Date.now(),
  }
  const next = [...pendingCandidates.value, cand]
  while (next.length > PENDING_CAP) next.shift()
  pendingCandidates.value = next
}

async function runGeneration(reason: 'transcript' | 'viewer' | 'manual'): Promise<void> {
  if (inflight) return
  // Snapshot + clear atomically; content landing during the await starts the next round.
  const transcript = sttTranscriptBuffer.value
  sttTranscriptBuffer.value = ''
  sttEndpointReached.value = false
  viewerReceivedSinceLastGen = 0

  // Transcript-driven runs need content; viewer/manual may proceed empty (observer-only context).
  if (reason === 'transcript' && !transcript.trim()) {
    return
  }

  inflight = true
  aiChatStatus.value = 'generating'
  try {
    const sourceText = transcript.trim() || '（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）'
    const decision = await callAiChatLlm(sourceText)
    if (!decision) {
      // callAiChatLlm already logged the failure
      return
    }
    aiChatLastGenAt.value = Date.now()

    if (decision.send && decision.message.trim()) {
      if (aiChatAutoSend.value) {
        const ok = await sendAiChatDanmaku(decision.message)
        recordConvHistory(transcript, decision.message)
        appendHistory({
          id: nextEntryId++,
          transcript,
          message: decision.message,
          reason: decision.reason,
          sent: ok,
          decidedAt: Date.now(),
        })
      } else {
        // Review mode — record with a `[候选]` marker so the LLM won't re-propose
        // before the user acts.
        addPendingCandidate(transcript, decision)
        recordConvHistory(transcript, `[候选:${decision.message}]`)
      }
    } else {
      // Record the skip so we don't loop on the same content.
      recordConvHistory(transcript, `[跳过:${decision.reason || '无'}]`)
      appendHistory({
        id: nextEntryId++,
        transcript,
        message: '',
        reason: decision.reason || '（无理由）',
        sent: false,
        decidedAt: Date.now(),
      })
    }
  } finally {
    inflight = false
    // Don't resurrect the pill out of 'disabled' if torn down mid-flight.
    // peek() avoids the narrowing the 'generating' assignment above would impose.
    if (aiChatStatus.peek() !== 'disabled') {
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

function scheduleGeneration(delay: number, reason: 'transcript' | 'viewer'): void {
  // Gate here so a later LLM configure flips it via the parent effect's tracking,
  // without an engine restart.
  if (!isLlmReady('aiChat')) return
  clearScheduled()
  scheduledReason = reason
  aiChatStatus.value = 'waiting'
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null
    const r = scheduledReason ?? reason
    scheduledReason = null
    void runGeneration(r)
  }, delay)
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
    appendLog('⚠️ [AI 陪聊] 发送内容为空')
    return
  }
  pendingCandidates.value = pendingCandidates.value.filter(c => c.id !== id)
  void (async () => {
    const ok = await sendAiChatDanmaku(message)
    appendHistory({
      id: nextEntryId++,
      transcript: cand.transcript,
      message,
      reason: cand.decision.reason,
      sent: ok,
      decidedAt: Date.now(),
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
  recentOutgoingTexts.clear()
  // Reset so a restart recovers an engine left wedged by a stalled in-flight call.
  inflight = false
  clearScheduled()
  // Clear stale STT state so we don't fire on content accumulated while off.
  sttTranscriptBuffer.value = ''
  sttEndpointReached.value = false

  unsubscribeDanmaku = subscribeDanmaku({
    onMessage: (ev: DanmakuEvent) => {
      const text = ev.text.trim()
      if (!text) return
      // Drop our own echoes and 大表情 emotes (display names, not textual context).
      if (isLikelySelfEcho(text)) return
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
  if (unsubscribeDanmaku) {
    unsubscribeDanmaku()
    unsubscribeDanmaku = null
  }
  if (stopBufferEffect) {
    stopBufferEffect()
    stopBufferEffect = null
  }
  clearScheduled()
  aiChatStatus.value = 'disabled'
}
