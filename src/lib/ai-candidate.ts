/**
 * AI 候选引擎 —— Review-only 版本的"AI 陪聊"。
 *
 * 产品定位（重要）：LLM 听主播 STT + 房间弹幕，**生成弹幕候选放进队列**，
 * **用户必须点确认才发**。引擎本身**不会**自己发弹幕到 B 站。
 *
 * 跟 upstream chatterbox 的 `ai-chat.ts` 的关键区别：
 * - **没有 auto-send 路径**：upstream 有 `aiChatAutoSend` 开关，开了
 *   之后跳过候选队列直接 `enqueueDanmaku`。本 fork 把这条路径整段
 *   删除（包括相关 store signal），见 `store-ai-candidate.ts` 的说明。
 * - **不引 JSON schema 通路**：upstream 用 OpenAI-compat 的
 *   `response_format: json_schema`。fork 的 `chatCompletionViaLlm`
 *   是为 AI 润色设计的简单 single-system + single-user 接口，不支持
 *   JSON schema。这里改成把"输出 JSON"指令拼进 user message，靠
 *   `parseDecision` 防御式解析 —— upstream 自己也有这条 fallback
 *   路径（处理忽略 response_format 的供应商），可靠性足够。
 *
 * Pipeline（保留 upstream 的核心调度逻辑）：
 *
 *   Soniox onPartialResult ──► sttTranscriptBuffer + sttEndpointReached
 *                                            │
 *   .chat-items MutationObserver ──► viewerBuffer (ring N≤aiCandidateViewerWindow)
 *                                            │
 *                                  scheduler (debounce 500ms / 8000ms,
 *                                  pulled forward on endpoint detection,
 *                                  sentence-final regex, or buffer > 200ch;
 *                                  viewer-only trigger every
 *                                  aiCandidateViewerInterval messages)
 *                                            ▼
 *                                runGeneration:
 *                                  - snapshot transcript + viewer buffer
 *                                  - build context summary
 *                                  - call chatCompletionViaLlm (text)
 *                                  - parse {send, message, reason}
 *                                            ▼
 *                              addPendingCandidate  (← always Review)
 *                                            │
 *                              user clicks Send ─► enqueueDanmaku
 *
 * Self-send dedupe：用户点确认发出去的弹幕会被 B 站 broadcast 回 `.chat-items`，
 * 我们的 danmaku 订阅会看到自己刚发的字。30 秒 TTL 的 Set 去重 echo，
 * 这样它不会被当成"观众又说了一遍"喂回 LLM 上下文。
 *
 * Cherry-picked from laplace-live/chatterbox commits 90afd8e + aebeb47 +
 * 7676ec1，移除 `aiChatAutoSend` 路径，改路由 LLM 通过 fork 的
 * `chatCompletionViaLlm`。
 */

import { effect, signal } from '@preact/signals'

import { ensureRoomId, getCsrfToken } from './api'
import { type DanmakuEvent, subscribeDanmaku } from './danmaku-stream'
import { chatCompletionViaLlm } from './llm-driver'
import { describeLlmGap, isLlmReady } from './llm-polish'
import { appendLog } from './log'
import { getActiveLlmPrompt } from './prompts'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  aiCandidateContextMaxChars,
  aiCandidateMaxMessageLength,
  aiCandidateViewerInterval,
  aiCandidateViewerWindow,
  llmApiKey,
  llmBaseURL,
  llmModel,
  llmProvider,
  sttEndpointReached,
  sttTranscriptBuffer,
} from './store'

// ===========================================================================
// Public types
// ===========================================================================

export interface ViewerChatEntry {
  uname: string | null
  uid: string | null
  text: string
  receivedAt: number
}

export interface AiCandidateDecision {
  send: boolean
  message: string
  reason: string
}

export interface AiCandidateItem {
  id: number
  transcript: string
  decision: AiCandidateDecision
  createdAt: number
}

export interface AiCandidateHistoryEntry {
  id: number
  /** 触发本次生成的 STT 转录摘录。Viewer-only 触发时为空字符串。 */
  transcript: string
  /** 实际发出的弹幕，跳过时为空。 */
  message: string
  /** Reason —— LLM 给的 reason 字段或人工跳过时的合成说明。 */
  reason: string
  sent: boolean
  decidedAt: number
}

export type AiCandidateEngineStatus = 'idle' | 'waiting' | 'generating' | 'disabled'

// ===========================================================================
// UI-visible signals
// ===========================================================================

/** Review 模式下排队等用户点击的候选。无 auto-send 路径，所有生成都到这里。 */
export const pendingCandidates = signal<AiCandidateItem[]>([])

/** 历史记录（决策日志），UI 展示用。容量上限见 FINISHED_HISTORY_CAP。 */
export const aiCandidateHistory = signal<AiCandidateHistoryEntry[]>([])

/** 引擎状态指示。 */
export const aiCandidateStatus = signal<AiCandidateEngineStatus>('disabled')

/** 上次决策的 wall-clock，UI 用来渲染「N 秒前」状态文字。 */
export const aiCandidateLastGenAt = signal<number | null>(null)

/** 启动后看到的 viewer 弹幕总数。UI 用它除以 aiCandidateViewerInterval
 *  展示「距离下次 viewer 触发还差 N 条」。 */
export const aiCandidateViewerCount = signal(0)

// ===========================================================================
// Module-local mutable state
// ===========================================================================

/** Most-recent N viewer messages (ring; 修剪到 aiCandidateViewerWindow)。 */
const viewerBuffer: ViewerChatEntry[] = []

/** 滚动会话历史（transcript + 我们发过 / 跳过的内容），喂给 LLM 当上下文。 */
const conversationHistory: { transcript: string; chat: string }[] = []

/** Viewer-only 触发计数器（每次生成清零）。 */
let viewerReceivedSinceLastGen = 0

/** 最近发出的 text → 入队 timestamp。用来过滤 B 站把我们自己的发送
 *  broadcast 回来的回响。 */
const recentOutgoingTexts = new Map<string, number>()

const OUTGOING_TTL_MS = 30_000
const OUTGOING_CAP = 64

/** convHistory 最大条目。容量小是因为 summary builder 从新往旧走，
 *  到字符预算就停。 */
const HISTORY_ENTRIES_CAP = 50
/** Pending 候选上限；溢出从队首丢。 */
const PENDING_CAP = 30
/** 决策日志上限（UI feed）。 */
const FINISHED_HISTORY_CAP = 50

/** 严格递增的 ID（候选 / 历史共用）。 */
let nextEntryId = 1

// Disposer + scheduling state
let unsubscribeDanmaku: (() => void) | null = null
let stopBufferEffect: (() => void) | null = null
let scheduledTimer: ReturnType<typeof setTimeout> | null = null
let scheduledReason: 'transcript' | 'viewer' | null = null
let inflight = false
let startCount = 0

// ===========================================================================
// Debounce 常量（port from laplace-cap useAiChatter.ts）
// ===========================================================================

/** Buffer 已就绪（端点检测 / 句号 / 长度超阈）。 */
const DEBOUNCE_READY_MS = 500
/** Buffer 尚未就绪 —— 等更久让句子成型。 */
const DEBOUNCE_FALLBACK_MS = 8_000
/** 生成完之后、新内容继续累积时的 re-arm 延迟。 */
const DEBOUNCE_AFTER_GEN_VIEWER_MS = 3_000

const SENTENCE_END_REGEX = /[。.！!？?]$/
const READY_BUFFER_LEN = 200

// ===========================================================================
// Self-send dedupe
// ===========================================================================

function pruneRecentOutgoing(): void {
  const now = Date.now()
  for (const [text, ts] of recentOutgoingTexts) {
    if (now - ts > OUTGOING_TTL_MS) recentOutgoingTexts.delete(text)
  }
}

// Exported for unit tests so the self-echo dedupe (TTL + cap eviction)
// can be verified without bringing up the full engine.
export function markOutgoing(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  pruneRecentOutgoing()
  recentOutgoingTexts.set(trimmed, Date.now())
  // 廉价容量上限，避免长会话无限增长。Map 的迭代顺序就是插入顺序，
  // 第一个 key 就是最旧的。
  if (recentOutgoingTexts.size > OUTGOING_CAP) {
    const oldest = recentOutgoingTexts.keys().next().value
    if (oldest !== undefined) recentOutgoingTexts.delete(oldest)
  }
}

// Exported for unit tests (see `markOutgoing`).
export function isLikelySelfEcho(text: string): boolean {
  pruneRecentOutgoing()
  return recentOutgoingTexts.has(text.trim())
}

/**
 * Test-only hook. Clears the recent-outgoing map so a test starting
 * with a fresh state isn't tainted by a previous test's `markOutgoing`
 * calls. Same DI pattern as `_resetSendQueueForTests` / `_setGmXhrForTests`
 * in the rest of the fork.
 */
export function _resetSelfEchoForTests(): void {
  recentOutgoingTexts.clear()
}

// ===========================================================================
// 上下文 summary
// ===========================================================================

/**
 * 组装喂给 LLM 的滚动上下文块。最新历史在底部；最近 viewer 弹幕区只在
 * 不超过半个字符预算时加进来（否则会把历史挤掉头部）。
 *
 * 用字符不用 token —— 用户配置就是字符（`aiCandidateContextMaxChars`），
 * 不想为了一个供应商也不卡的模糊上限拖一个 tokenizer 进 bundle。
 */
// Exported for unit tests. Pure function: caller passes everything in.
// `history` shape matches the module-local `conversationHistory` but is
// generalised so test fixtures don't need to import the live mutable array.
export function buildContextSummary(
  history: ReadonlyArray<{ transcript: string; chat: string }>,
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

// ===========================================================================
// Readiness detection
// ===========================================================================

// Exported for unit tests. Takes the endpoint flag as a param so tests
// don't have to flip the global signal (which would couple unrelated
// tests across files via signal state).
export function isReadyForGen(buffer: string, endpointReached: boolean): boolean {
  if (endpointReached) return true
  if (SENTENCE_END_REGEX.test(buffer.trim())) return true
  if (buffer.length > READY_BUFFER_LEN) return true
  return false
}

// ===========================================================================
// JSON-decision 防御式解析
// ===========================================================================

// Exported for unit tests. Pure function: no module state touched.
export function parseDecision(content: string, maxLen: number): AiCandidateDecision {
  let obj: unknown = null
  try {
    obj = JSON.parse(content)
  } catch {
    // 退路：抓第一个平衡的 {…} 块。许多供应商即使不支持 response_format
    // 也会输出 JSON 包在一句话里（"好的，这是 JSON：{ … }"）。lastIndexOf
    // 配 indexOf 拿最外层块。
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        obj = JSON.parse(content.slice(start, end + 1))
      } catch {
        // 放弃，下面 throw
      }
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

// ===========================================================================
// LLM 调用
// ===========================================================================

async function callAiCandidateLlm(sourceText: string): Promise<AiCandidateDecision | null> {
  const personaPrompt = getActiveLlmPrompt('aiCandidate')
  if (!personaPrompt.trim()) {
    appendLog('⚠️ [AI 陪聊] 未配置 AI 陪聊提示词')
    return null
  }
  const gap = describeLlmGap('aiCandidate')
  if (gap) {
    appendLog(`⚠️ [AI 陪聊] ${gap}`)
    return null
  }
  const maxLen = Math.max(1, aiCandidateMaxMessageLength.value)
  // 调用瞬间 snapshot viewer buffer，避免 LLM 飞行期间 buffer 变化。
  const viewerSnapshot = viewerBuffer.slice(-aiCandidateViewerWindow.value)
  const contextSummary = buildContextSummary(conversationHistory, aiCandidateContextMaxChars.value, viewerSnapshot)
  const decoratedSystem =
    `${personaPrompt}\n\n` +
    `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n\n` +
    '主播的语音文字来自实时语音识别，可能是片段化的句子。上下文中包含最近的发送记录与最新观众弹幕，请综合理解后再决定是否发送。\n\n' +
    '你必须返回一个 JSON 对象，包含三个字段：\n' +
    '- "send" (boolean)：当前内容是否值得作为弹幕发送\n' +
    `- "message" (string)：要发送的弹幕，长度不超过 ${maxLen} 个字符；send 为 false 时为空串\n` +
    '- "reason" (string)：你做此决定的简短理由\n' +
    '只输出 JSON，不要 markdown 代码块、不要解释、不要任何其它文字。'
  const userContent = contextSummary
    ? `上下文（最近的发送 / 观众弹幕）：\n"""\n${contextSummary}\n"""\n\n主播刚刚说：\n"""\n${sourceText}\n"""\n`
    : `主播刚刚说："${sourceText}"`
  try {
    const content = await chatCompletionViaLlm({
      provider: llmProvider.value,
      apiKey: llmApiKey.value,
      model: llmModel.value,
      baseURL: llmBaseURL.value,
      systemPrompt: decoratedSystem,
      userText: userContent,
      // 给 JSON + 简短理由留 300 token 足够。aiCandidateMaxMessageLength 默认
      // 40 字 ≈ 80 token，加上 JSON 结构开销 + reason，300 安全。
      maxTokens: 300,
    })
    return parseDecision(content, maxLen)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ [AI 陪聊] LLM 调用失败：${msg}`)
    return null
  }
}

// ===========================================================================
// 发送（仅在用户点确认时调用，不在 auto-send 路径）
// ===========================================================================

async function sendAcceptedCandidate(message: string): Promise<boolean> {
  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ [AI 陪聊] 未找到登录信息，请先登录 Bilibili')
      return false
    }
    // 在 send 之前 mark outgoing，让 danmaku-stream 同步广播回来时能识别
    // 是我们自己刚发的。
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

// ===========================================================================
// History / candidate 管理
// ===========================================================================

function appendHistory(entry: AiCandidateHistoryEntry): void {
  const next = [...aiCandidateHistory.value, entry]
  while (next.length > FINISHED_HISTORY_CAP) next.shift()
  aiCandidateHistory.value = next
}

function recordConvHistory(transcript: string, chat: string): void {
  conversationHistory.push({ transcript, chat })
  while (conversationHistory.length > HISTORY_ENTRIES_CAP) conversationHistory.shift()
}

function addPendingCandidate(transcript: string, decision: AiCandidateDecision): void {
  const cand: AiCandidateItem = {
    id: nextEntryId++,
    transcript,
    decision,
    createdAt: Date.now(),
  }
  const next = [...pendingCandidates.value, cand]
  while (next.length > PENDING_CAP) next.shift()
  pendingCandidates.value = next
}

// ===========================================================================
// 生成主流程（Review-only）
// ===========================================================================

async function runGeneration(reason: 'transcript' | 'viewer' | 'manual'): Promise<void> {
  if (inflight) return
  // Atomic snapshot + clear transcript。在下面 await 期间到达的内容累积进
  // 新一轮 buffer，由 effect 触发下一次生成。
  const transcript = sttTranscriptBuffer.value
  sttTranscriptBuffer.value = ''
  sttEndpointReached.value = false
  viewerReceivedSinceLastGen = 0

  // 短路：transcript-driven 触发需要真有 transcript 内容；viewer / manual
  // 触发即使空 transcript 也可以跑（LLM 仅基于 viewer 上下文反应）。
  if (reason === 'transcript' && !transcript.trim()) {
    return
  }

  inflight = true
  aiCandidateStatus.value = 'generating'
  try {
    const sourceText = transcript.trim() || '（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）'
    const decision = await callAiCandidateLlm(sourceText)
    if (!decision) {
      // callAiCandidateLlm 已经 log 过失败
      return
    }
    aiCandidateLastGenAt.value = Date.now()

    if (decision.send && decision.message.trim()) {
      // Review 模式 —— 总是排进候选队列，等用户点。不在引擎里发。
      addPendingCandidate(transcript, decision)
      // 记录到 convHistory 时带 [候选:] 前缀，让 LLM 下一次看到时知道
      // "这条已经提议过了，别立刻又提一遍同样的"。
      recordConvHistory(transcript, `[候选:${decision.message}]`)
    } else {
      // 跳过 —— 记录避免反复看到同一内容打圈
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
    aiCandidateStatus.value = scheduledTimer ? 'waiting' : 'idle'
  }
}

// ===========================================================================
// Scheduler
// ===========================================================================

function clearScheduled(): void {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
    scheduledReason = null
  }
}

function scheduleGeneration(delay: number, reason: 'transcript' | 'viewer'): void {
  // 在 scheduler 这层 gate，避免给 callAiCandidateLlm 排一个它马上就拒绝的
  // 工作。读了几个 signal，它们成为 parent effect 的依赖，所以后续的
  // LLM 配置完成会自动重新启用这条路径，不需要重启引擎。
  if (!isLlmReady('aiCandidate')) return
  clearScheduled()
  scheduledReason = reason
  aiCandidateStatus.value = 'waiting'
  scheduledTimer = setTimeout(() => {
    scheduledTimer = null
    const r = scheduledReason ?? reason
    scheduledReason = null
    void runGeneration(r)
  }, delay)
}

// ===========================================================================
// Public actions (UI-driven)
// ===========================================================================

export function triggerNow(): void {
  clearScheduled()
  void runGeneration('manual')
}

/**
 * 用户在候选队列里点了发送。把 `editedMessage` 传进来就用编辑后的版本，
 * 否则用 LLM 原始的 message。
 */
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
    const ok = await sendAcceptedCandidate(message)
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

export function clearAiCandidateHistory(): void {
  aiCandidateHistory.value = []
}

// ===========================================================================
// Engine lifecycle
// ===========================================================================

/**
 * 启动引擎（idempotent + ref-counted）。第一个调用者建立：
 * - 一个共享的 subscribeDanmaku 订阅，喂 viewerBuffer + viewer-interval 计数
 * - 一个 Preact effect，每次 sttTranscriptBuffer / sttEndpointReached 变化
 *   都重新评估 debounce timer
 *
 * 后续调用只增 ref count，不重订阅。与 `stopAiCandidateEngine` 1:1 配对；
 * 最后一个 stop 拆掉一切。
 */
export function startAiCandidateEngine(): void {
  startCount++
  if (startCount > 1) return

  // 全新一轮 session state。**不**清空 aiCandidateHistory —— 让用户 toggle
  // off→on 不丢决策日志。pending candidates 清掉因为它们引用的 transcript
  // 可能已经不相关。
  viewerBuffer.length = 0
  conversationHistory.length = 0
  viewerReceivedSinceLastGen = 0
  pendingCandidates.value = []
  aiCandidateViewerCount.value = 0
  recentOutgoingTexts.clear()
  // 清掉引擎关闭期间 STT 累积的旧 state，避免一启动就拿到陈年内容生成。
  sttTranscriptBuffer.value = ''
  sttEndpointReached.value = false

  unsubscribeDanmaku = subscribeDanmaku({
    onMessage: (ev: DanmakuEvent) => {
      const text = ev.text.trim()
      if (!text) return
      // 滤掉自己的回响 + 大表情（携带表情名而非有意义的文本上下文）。
      // @ 回复保留，因为文本内容仍可能带对话信号。
      if (isLikelySelfEcho(text)) return
      if (ev.hasLargeEmote) return
      const entry: ViewerChatEntry = {
        uname: ev.uname,
        uid: ev.uid,
        text,
        receivedAt: Date.now(),
      }
      viewerBuffer.push(entry)
      const window = aiCandidateViewerWindow.value
      while (viewerBuffer.length > window) viewerBuffer.shift()
      aiCandidateViewerCount.value = aiCandidateViewerCount.value + 1
      viewerReceivedSinceLastGen++

      // Viewer-only 触发。只在没排队任务时 fire —— 否则忙的 transcript 会
      // 跟 viewer 节奏赛跑双发。
      const interval = Math.max(1, aiCandidateViewerInterval.value)
      if (viewerReceivedSinceLastGen >= interval && !scheduledTimer && !inflight) {
        scheduleGeneration(DEBOUNCE_AFTER_GEN_VIEWER_MS, 'viewer')
      }
    },
  })

  stopBufferEffect = effect(() => {
    // 同时跟踪两个 transcript signal，让端点标记能把已排队的 gen 提前
    // 触发（buffer 文本单独 trigger 不到的话）。
    const buffer = sttTranscriptBuffer.value
    const ep = sttEndpointReached.value
    if (!buffer.trim() && !ep) return
    if (inflight) return
    const ready = isReadyForGen(buffer, ep)
    scheduleGeneration(ready ? DEBOUNCE_READY_MS : DEBOUNCE_FALLBACK_MS, 'transcript')
  })

  aiCandidateStatus.value = 'idle'
}

/**
 * 降 ref count；归零时拆掉订阅、effect、pending timer。零之后再 stop
 * 也安全（idempotent past zero），remount 时的 stray stop 不会让 count
 * 变负。
 */
export function stopAiCandidateEngine(): void {
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
  aiCandidateStatus.value = 'disabled'
}
