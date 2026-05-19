import {
  checkSelfRoomRestrictions,
  ensureRoomId,
  getCsrfToken,
  getDedeUid,
  type SendDanmakuResult,
  setRandomDanmakuColor,
} from './api'
import { isAutoBlendBlacklistedText, isAutoBlendBlacklistedUid } from './auto-blend-blacklist'
import { logAutoBlend, logAutoBlendSendResult } from './auto-blend-events'
import {
  formatAutoBlendCandidate,
  formatAutoBlendCandidateProgress,
  formatAutoBlendSenderInfo,
  formatAutoBlendStatus,
  shortAutoBlendText,
} from './auto-blend-status'
import { releaseAutoBlendLock, tryAcquireAutoBlendLock } from './auto-blend-tab-lock'
import { detectTrend, type TrendEvent } from './auto-blend-trend'
import { getAutoBlendTrendKey } from './chatfilter-runtime'
import { subscribeCustomChatEvents } from './custom-chat-events'
import { subscribeDanmaku } from './danmaku-stream'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { classifyRiskEvent, syncGuardRoomRiskEvent } from './guard-room-sync'
import { startLiveWsSource, stopLiveWsSource } from './live-ws-source'
import { describeLlmGap, polishWithLlm } from './llm-polish'
import { clearMemeSession, recordMemeCandidate } from './meme-contributor'
import {
  classifyByCode,
  describeRestrictionDuration,
  isAccountRestrictedError,
  isMutedError,
  isRateLimitError,
} from './moderation'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import { verifyBroadcast } from './send-verification'
import {
  autoBlendAvoidRepeat,
  autoBlendBurstSettleMs,
  autoBlendCandidateProgress,
  autoBlendCandidateText,
  autoBlendCooldownAuto,
  autoBlendCooldownSec,
  autoBlendDryRun,
  autoBlendEnabled,
  autoBlendLastActionText,
  autoBlendMinDistinctUsers,
  autoBlendRateLimitStopThreshold,
  autoBlendRateLimitWindowMin,
  autoBlendRequireDistinctUsers,
  autoBlendRoutineIntervalSec,
  autoBlendSendAllTrending,
  autoBlendSendCount,
  autoBlendStatusText,
  autoBlendThreshold,
  autoBlendUseReplacements,
  autoBlendWindowSec,
  autoBlendYolo,
  cachedRoomId,
  maxLength,
  msgSendInterval,
  randomChar,
  randomColor,
  randomInterval,
} from './store'
import { addRandomCharacter, formatDanmakuError, trimText } from './utils'

interface TrendRecordEvent {
  ts: number
  uid: string | null
}

interface TrendEntry {
  // Each event stores its own timestamp and uid together so pruneExpired can
  // drop both at once. Previously, timestamps and uniqueUids were stored
  // separately, leaving stale uids behind after old timestamps were pruned —
  // inflating the distinct-user count and causing false-positive triggers.
  events: TrendRecordEvent[]
}

// message → rolling-window trend data
const trendMap = new Map<string, TrendEntry>()
let nextTrendPruneAt = Number.POSITIVE_INFINITY
let lastPruneWindowMs = 0

// Global hard cooldown: while Date.now() < cooldownUntil, all incoming danmaku
// are discarded. Engaged after every send to prevent echo stacking.
let cooldownUntil = 0

let unsubscribe: (() => void) | null = null
let unsubscribeWsDanmaku: (() => void) | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let burstSettleTimer: ReturnType<typeof setTimeout> | null = null
let pendingBurstText: string | null = null
// Self-rescheduling timeout instead of setInterval: reads autoBlendRoutineIntervalSec
// fresh each tick, so changing the setting takes effect immediately without
// requiring a stop-and-restart.
let routineTimeout: ReturnType<typeof setTimeout> | null = null
let routineActive = false
let myUid: string | null = null
let isSending = false
// 上次自动跟车发出去的那条原文(同 trendMap 的 key,trim 后、replacement 前)。
// autoBlendAvoidRepeat 开启时 recordDanmaku 会把完全相同的新弹幕早期丢弃,
// 避免冷却结束后立刻被同一句再次刷上去。stopAutoBlend 时清空。
let lastAutoSentText: string | null = null
// CPM (chats-per-minute) 滑动窗口:跟踪每条非自身弹幕的时间戳。读取时按
// CPM_WINDOW_SEC 裁剪。包括所有非自身弹幕(黑名单/锁定表情/回复都算),
// 因为 CPM 衡量的是"房间整体活跃度",不是"达标候选活跃度"。
const messageTimestamps: number[] = []
let rateLimitHitCount = 0
let firstRateLimitHitAt = 0
let moderationStopReason: string | null = null
let consecutiveSilentDrops = 0
const SILENT_DROP_CHECK_THRESHOLD = 3
// B 站新发的、我们字符串/数字码都没识别的错误。3 次连发后强制 dry-run,
// 避免在被禁言的状态下继续真发(假阳性会被风控反推)。任何已识别错误或
// 成功发送会清零。
let consecutiveUnknownErrors = 0
const UNKNOWN_ERROR_DRYRUN_THRESHOLD = 3

// Let a freshly-started wave breathe briefly before following it. With a
// threshold of 2, firing on the exact second message makes every log look like
// "just started, 2 messages" and prevents all-trending mode from seeing the
// rest of the same wave.
const RATE_LIMIT_BACKOFF_MS = 2 * 60 * 1000

// === Adaptive cooldown ==================================================
// CPM 滑动窗口:30s 足够短,突发的话几秒就能看到 CPM 抬升;同时长到能把
// 单条噪音抹平。CPM_MIN_WINDOW_MS 是外推下限——刚启动只有一两条时
// 不至于把 CPM 估成几百。
const CPM_WINDOW_SEC = 30
const CPM_MIN_WINDOW_MS = 2000
// COOLDOWN_FLOOR_SEC 对应"最快也只 2 秒一发"的语义,在最热的房间不至于
// 刷得太密。CEILING 让冷场房间不会冷却到天荒地老。STEALTH_K = 300 ⇒
// 在任意 CPM 下,我们的 send 之间大约会有 5 条别人的弹幕(K/cpm 秒 ×
// cpm/60 = K/60 = 5),读起来像是"自然地融入聊天",既不会主导热闹房间,
// 也不会在冷场房间显得太机械。
const COOLDOWN_FLOOR_SEC = 2
const COOLDOWN_CEILING_SEC = 60
const COOLDOWN_STEALTH_K = 300

function pruneOldTimestamps(now: number): void {
  const cutoff = now - CPM_WINDOW_SEC * 1000
  let i = 0
  while (i < messageTimestamps.length && messageTimestamps[i] < cutoff) i++
  if (i > 0) messageTimestamps.splice(0, i)
}

/**
 * Compute the room's current CPM (chats per minute) based on the rolling
 * timestamp window. Pure read-mostly: prunes the window then extrapolates
 * from the actual span (capped to {@link CPM_WINDOW_SEC}) so a fresh
 * tracker stabilizes in seconds rather than waiting for the full window
 * to fill.
 */
export function getCurrentCpm(now: number): number {
  pruneOldTimestamps(now)
  const n = messageTimestamps.length
  if (n === 0) return 0
  const spanMs = now - messageTimestamps[0]
  const windowMs = Math.max(CPM_MIN_WINDOW_MS, Math.min(spanMs, CPM_WINDOW_SEC * 1000))
  return Math.round((n * 60_000) / windowMs)
}

/**
 * Map a CPM reading to a cooldown in seconds via K/cpm, clamped to
 * [{@link COOLDOWN_FLOOR_SEC}, {@link COOLDOWN_CEILING_SEC}]. Quiet rooms
 * (cpm == 0) get the ceiling so we don't immediately re-fire when chat
 * goes silent right after a trigger.
 *
 * Pure function — exported for unit testing.
 */
export function computeAutoCooldownSec(cpm: number): number {
  if (cpm <= 0) return COOLDOWN_CEILING_SEC
  const auto = Math.round(COOLDOWN_STEALTH_K / cpm)
  return Math.min(COOLDOWN_CEILING_SEC, Math.max(COOLDOWN_FLOOR_SEC, auto))
}

/** Cooldown(ms) that would be engaged if triggerSend fired right now. */
export function getEffectiveCooldownMs(now: number): number {
  if (!autoBlendCooldownAuto.value) return autoBlendCooldownSec.value * 1000
  return computeAutoCooldownSec(getCurrentCpm(now)) * 1000
}

/** Test-only: push a synthetic timestamp into the CPM tracking window. */
export function _pushCpmTimestampForTests(ts: number): void {
  messageTimestamps.push(ts)
}

/** Test-only: read the current size of the CPM tracking window. */
export function _getCpmWindowSizeForTests(): number {
  return messageTimestamps.length
}

/** Test-only: directly invoke recordDanmaku without setting up subscriptions. */
export function _recordDanmakuForTests(
  rawText: string,
  uid: string | null,
  isReply: boolean,
  hasLargeEmote = false
): void {
  recordDanmaku(rawText, uid, isReply, hasLargeEmote)
}

/** Test-only: seed lastAutoSentText for avoid-repeat tests. */
export function _setLastAutoSentTextForTests(text: string | null): void {
  lastAutoSentText = text
}

/** Test-only: read trend-map size for avoid-repeat assertions. */
export function _getTrendMapSizeForTests(): number {
  return trendMap.size
}

/** Test-only: observe the cooldown deadline (ms epoch). */
export function _getCooldownUntilForTests(): number {
  return cooldownUntil
}

/**
 * Test-only: force-set the cooldown deadline. Used to drive multi-round
 * scenarios (e.g. "3 consecutive unknown errorCodes flip dryRun") without
 * waiting full cooldowns between rounds, while keeping the unknown-error
 * counter / rate-limit counter intact (which `_resetAutoBlendStateForTests`
 * would clear).
 */
export function _setCooldownUntilForTests(value: number): void {
  cooldownUntil = value
}

/** Test-only: read lastAutoSentText (avoidRepeat ground truth). */
export function _getLastAutoSentTextForTests(): string | null {
  return lastAutoSentText
}

function getBurstSettleMs(): number {
  return Math.max(0, autoBlendBurstSettleMs.value)
}

function getRateLimitWindowMs(): number {
  return Math.max(1, autoBlendRateLimitWindowMin.value) * 60 * 1000
}

function getRateLimitStopThreshold(): number {
  return Math.max(1, autoBlendRateLimitStopThreshold.value)
}

function getRateLimitWindowLabel(): string {
  return `${Math.max(1, autoBlendRateLimitWindowMin.value)} 分钟内`
}

function clearPendingAutoBlend(reason: string): void {
  if (burstSettleTimer) {
    clearTimeout(burstSettleTimer)
    burstSettleTimer = null
  }
  pendingBurstText = null
  trendMap.clear()
  nextTrendPruneAt = Number.POSITIVE_INFINITY
  lastPruneWindowMs = 0
  updateCandidateText()
  autoBlendLastActionText.value = reason
}

function stopAutoBlendAfterModeration(reason: string): void {
  moderationStopReason = reason
  clearPendingAutoBlend(reason)
  autoBlendEnabled.value = false
  logAutoBlend(reason, reason.startsWith('🔴') ? 'error' : 'warning')
}

function handleSendFailure(result: SendDanmakuResult, roomId?: number): boolean {
  const now = Date.now()
  const error = result.error
  const duration = describeRestrictionDuration(result.error, result.errorData)
  const codeKind = classifyByCode(result.errorCode)

  if (codeKind === 'muted' || (codeKind === null && isMutedError(error))) {
    consecutiveUnknownErrors = 0
    const risk = classifyRiskEvent(result.error, result.errorData)
    void syncGuardRoomRiskEvent({
      ...risk,
      source: 'auto-blend',
      roomId,
      errorCode: result.errorCode,
      reason: result.error,
    })
    stopAutoBlendAfterModeration(
      `🔴 自动跟车：检测到你在本房间被禁言，已自动关闭。禁言时长：${duration}。建议等到禁言解除后再开。`
    )
    return true
  }

  if (codeKind === 'account' || (codeKind === null && isAccountRestrictedError(error))) {
    consecutiveUnknownErrors = 0
    const risk = classifyRiskEvent(result.error, result.errorData)
    void syncGuardRoomRiskEvent({
      ...risk,
      source: 'auto-blend',
      roomId,
      errorCode: result.errorCode,
      reason: result.error,
    })
    stopAutoBlendAfterModeration(
      `🔴 自动跟车：检测到账号级限制/风控，已自动关闭。限制时长：${duration}。建议先停用一段时间，或换账号再开。`
    )
    return true
  }

  const isRateLimit = codeKind === 'rate-limit' || (codeKind === null && isRateLimitError(error))
  if (!isRateLimit) {
    const risk = classifyRiskEvent(result.error, result.errorData)
    void syncGuardRoomRiskEvent({
      ...risk,
      source: 'auto-blend',
      roomId,
      errorCode: result.errorCode,
      reason: result.error,
    })
    // 我们的数字码 + 字符串匹配都没识别这个错误。可能是 B 站新发的、还没适配
    // 的限制类型。只有 errorCode 真的有值才算"未知错误"——errorCode 完全缺失
    // 通常是网络/CORS 之类的，不计数。
    if (result.errorCode !== undefined && result.errorCode !== 0) {
      consecutiveUnknownErrors += 1
      if (consecutiveUnknownErrors >= UNKNOWN_ERROR_DRYRUN_THRESHOLD && !autoBlendDryRun.value) {
        autoBlendDryRun.value = true
        consecutiveUnknownErrors = 0
        logAutoBlend(
          `⚠️ 自动跟车：连续 ${UNKNOWN_ERROR_DRYRUN_THRESHOLD} 次收到我们不认识的 B 站响应（errorCode=${result.errorCode}, reason="${error ?? ''}"），已切换到试运行模式避免在未知风险下继续真发。请把这条反馈给维护者。`,
          'warning'
        )
      }
    }
    return false
  }
  // 走到这里说明是 rate-limit 错误,已识别,清未知错误计数。
  consecutiveUnknownErrors = 0

  if (now - firstRateLimitHitAt > getRateLimitWindowMs()) {
    firstRateLimitHitAt = now
    rateLimitHitCount = 0
  }
  rateLimitHitCount += 1

  if (rateLimitHitCount >= getRateLimitStopThreshold()) {
    const windowLabel = getRateLimitWindowLabel()
    void syncGuardRoomRiskEvent({
      kind: 'rate_limited',
      source: 'auto-blend',
      level: 'stop',
      roomId,
      errorCode: result.errorCode,
      reason: result.error,
      advice: `${windowLabel}多次触发频率限制，自动跟车已经停车，建议休息一阵再开。`,
    })
    stopAutoBlendAfterModeration(
      `⚠️ 自动跟车：${windowLabel}多次触发发送频率限制，已自动关闭，避免继续被系统/房管盯上。建议歇一阵子再开，或切到「稳一点」档减少触发频率。`
    )
    return true
  }

  void syncGuardRoomRiskEvent({
    kind: 'rate_limited',
    source: 'auto-blend',
    level: 'observe',
    roomId,
    errorCode: result.errorCode,
    reason: result.error,
    advice: '触发发送频率限制，自动跟车会先歇 2 分钟。',
  })
  cooldownUntil = Math.max(cooldownUntil, now + RATE_LIMIT_BACKOFF_MS)
  clearPendingAutoBlend(
    `自动跟车：触发发送频率限制，已暂停 ${Math.round(RATE_LIMIT_BACKOFF_MS / 60000)} 分钟并清空本轮候选。`
  )
  updateStatusText()
  return true
}

function countUniqueUids(events: TrendRecordEvent[]): number {
  const s = new Set<string>()
  for (const e of events) if (e.uid) s.add(e.uid)
  return s.size
}

function updateCandidateText(): void {
  const candidates = Array.from(trendMap, ([text, entry]) => ({
    text,
    totalCount: entry.events.length,
    uniqueUsers: countUniqueUids(entry.events),
  }))
  autoBlendCandidateText.value = formatAutoBlendCandidate(candidates)
  autoBlendCandidateProgress.value = formatAutoBlendCandidateProgress(
    candidates,
    autoBlendThreshold.value,
    autoBlendRequireDistinctUsers.value,
    autoBlendMinDistinctUsers.value
  )
}

function updateStatusText(): void {
  autoBlendStatusText.value = formatAutoBlendStatus({
    enabled: autoBlendEnabled.value,
    dryRun: autoBlendDryRun.value,
    isSending,
    cooldownUntil,
    now: Date.now(),
    cooldownAuto: autoBlendCooldownAuto.value,
  })
}

function pruneExpired(now: number, force = false): void {
  const windowMs = autoBlendWindowSec.value * 1000
  if (!force && windowMs === lastPruneWindowMs && now < nextTrendPruneAt) return
  lastPruneWindowMs = windowMs
  let next = Number.POSITIVE_INFINITY
  for (const [k, entry] of trendMap) {
    entry.events = entry.events.filter(e => now - e.ts <= windowMs)
    if (entry.events.length === 0) trendMap.delete(k)
    else next = Math.min(next, entry.events[0].ts + windowMs + 1)
  }
  nextTrendPruneAt = next
  updateCandidateText()
}

/**
 * Gap between repeated sends of the same message inside one trigger
 * (i.e. between "shot 1 of 3" and "shot 2 of 3" when autoBlendSendCount > 1).
 *
 * Uses the *effective* cooldown so that toggling autoBlendCooldownAuto on
 * actually takes the manual autoBlendCooldownSec out of the picture — the
 * previous direct read meant manual seconds silently bounded the gap even in
 * adaptive mode. Always at least msgSendInterval and 1010ms (anti-spam floor).
 *
 * Pure-ish (reads signals); exported for unit testing.
 */
export function getAutoBlendRepeatGapMs(now: number): number {
  return Math.max(getEffectiveCooldownMs(now), msgSendInterval.value * 1000, 1010)
}

function getAutoBlendBurstGapMs(): number {
  return Math.max(msgSendInterval.value * 1000, 1010)
}

function meetsThreshold(entry: TrendEntry): boolean {
  if (entry.events.length < autoBlendThreshold.value) return false
  if (autoBlendRequireDistinctUsers.value) {
    const uniqueUids = countUniqueUids(entry.events)
    // Fallback: when uid extraction fails for every event (e.g. after a Bilibili
    // DOM change), treat total count as a proxy for unique users so the feature
    // keeps working. Worst case: a single spammer counts as one "user".
    const effectiveUnique = uniqueUids > 0 ? uniqueUids : entry.events.length
    if (effectiveUnique < autoBlendMinDistinctUsers.value) return false
  }
  return true
}

function pickBestTrendingText(preferredText: string | null): string | null {
  const windowMs = autoBlendWindowSec.value * 1000
  const events: TrendEvent[] = []
  for (const [text, entry] of trendMap) {
    if (!meetsThreshold(entry)) continue
    for (const event of entry.events) events.push({ ...event, text })
  }
  const result = detectTrend(events, windowMs, autoBlendThreshold.value)
  if (!result.shouldSend) return null
  if (preferredText && result.candidates.some(candidate => candidate.text === preferredText)) return preferredText
  return result.text
}

function scheduleBurstSend(text: string): void {
  pendingBurstText ??= text
  if (burstSettleTimer !== null) return

  burstSettleTimer = setTimeout(() => {
    burstSettleTimer = null
    const preferredText = pendingBurstText
    pendingBurstText = null

    if (!autoBlendEnabled.value || isSending || Date.now() < cooldownUntil) {
      updateStatusText()
      return
    }

    pruneExpired(Date.now())
    const chosen = pickBestTrendingText(preferredText)
    if (chosen !== null) void triggerSend(chosen, 'burst')
  }, getBurstSettleMs())
}

function maybeScheduleBurstFromCurrentTrends(): void {
  if (!autoBlendEnabled.value || isSending || Date.now() < cooldownUntil || burstSettleTimer !== null) return
  const chosen = pickBestTrendingText(pendingBurstText)
  if (chosen !== null) scheduleBurstSend(chosen)
}

function recordDanmaku(rawText: string, uid: string | null, isReply: boolean, hasLargeEmote: boolean): void {
  if (!autoBlendEnabled.value) return

  // 自身回声:在 CPM 跟踪之前过滤,免得自动跟车的发送被回灌进 CPM,
  // 进而把自适应冷却推到下限,导致越发越快的正反馈。
  if (uid && myUid && uid === myUid) return

  const now = Date.now()
  // CPM 是房间整体活跃度的代理,所以这里不管后面会不会被过滤,只要不是
  // 自身的弹幕都算上。黑名单/锁定表情/回复也算。
  messageTimestamps.push(now)

  updateStatusText()

  const text = rawText.trim()
  if (!text) return
  // @ 回复不入候选：@ 是定向对话，不应该被当作"群体趋势"被自动跟车放大。
  // 上游 chatterbox 624de4e 已经把这条改成无条件过滤；本 fork 同步这一约定，
  // 删除原先的 `autoBlendIncludeReply` 开关（一并移出 store / 备份 / UI）。
  if (isReply) return

  if (isAutoBlendBlacklistedUid(uid)) return
  // 文本黑名单(精确 trim 后匹配):"666"、"+1"、"哈哈哈" 这种万能水
  // 即使触发达标也不要跟。提前到这里,既不进 trendMap,也不出现在候选榜
  // 进度里,UI 上彻底看不到,语义和 UID 黑名单完全对称。
  if (isAutoBlendBlacklistedText(text)) return
  if (isLockedEmoticon(text)) return
  // 跨房间表情 unique ID(`room_<别人房间>_<id>` 等):看着像 ID,但不在
  // 当前房间的表情包内,直接发会被 B 站当成纯文本回显,出现"乱码刷屏"。
  // 与 isLockedEmoticon 同位置过滤——不让这种 trend 进入候选榜,避免
  // 触发后 triggerSend 才发现没法发,白白吃掉一个冷却。
  if (isUnavailableEmoticon(text)) return
  // fan-club 大表情(bulge-emoticon)的 `data-danmaku` 是显示名,不是
  // emoticon_unique。让它累积成 trend → 触发 → 因为 isEmoticonUnique
  // 返回 false → 走纯文本路径 → 屏幕上出现"应援"两个字而不是别人看到
  // 的大表情图。早期硬丢,与 locked 表情同档处理。
  if (hasLargeEmote) return

  // chatfilter（场景 A）：把 trendMap key 从 raw 文本换成 canonical，
  // 这样 "哈哈哈"/"哈哈哈哈"/"hhh" 合并为同一趋势。totalKey 同时用作
  // avoid-repeat 指纹与 lastAutoSentText 比较，保证两端语义一致。
  // 关闭 chatfilter 或场景 A 关时，getAutoBlendTrendKey 直接返回 trim 后原文，
  // 行为退回原样。null = chatfilter 把它判为应丢弃。
  const trendKey = getAutoBlendTrendKey(rawText)
  if (trendKey === null) return

  // 不重复上次自动发送:在计数前丢弃,所以被屏蔽的句子也不会进候选榜——
  // 仍能命中的,必然是我们刚刚自己发出去的那条。
  if (autoBlendAvoidRepeat.value && lastAutoSentText !== null && trendKey === lastAutoSentText) return

  pruneExpired(now)

  let entry = trendMap.get(trendKey)
  if (!entry) {
    entry = { events: [] }
    trendMap.set(trendKey, entry)
  }
  entry.events.push({ ts: now, uid })
  const expiresAt = now + autoBlendWindowSec.value * 1000 + 1
  if (expiresAt < nextTrendPruneAt) nextTrendPruneAt = expiresAt
  updateCandidateText()

  // During cooldown/sending we still keep counting, but defer the actual follow
  // until the feature is allowed to send again. This preserves the wave for
  // later routine or burst handling instead of throwing away the hottest part.
  if (now < cooldownUntil || isSending) return

  if (meetsThreshold(entry)) scheduleBurstSend(trendKey)
}

function scheduleNextRoutine(): void {
  routineTimeout = setTimeout(() => {
    routineTimerTick()
    if (routineActive) scheduleNextRoutine()
  }, autoBlendRoutineIntervalSec.value * 1000)
}

function routineTimerTick(): void {
  if (!autoBlendEnabled.value) return
  const now = Date.now()
  if (now < cooldownUntil) {
    updateStatusText()
    return
  }
  updateStatusText()

  pruneExpired(now)

  // Collect candidates that meet the threshold.
  const candidates: Array<[string, number]> = []
  for (const [text, entry] of trendMap) {
    if (meetsThreshold(entry)) {
      candidates.push([text, entry.events.length])
    }
  }
  if (candidates.length === 0) return

  // Weighted random choice: W_i = count_i / sum_counts.
  // Over many ticks this naturally sends more-popular messages more often —
  // proportional distribution without needing a separate multi-send mechanism.
  // Sort by count desc so the math-fallback (`chosen = candidates[0]`) is the
  // most popular candidate rather than an arbitrary map-iteration tail entry.
  candidates.sort((a, b) => b[1] - a[1])
  const totalWeight = candidates.reduce((s, [, c]) => s + c, 0)
  let r = Math.random() * totalWeight
  let chosen = candidates[0][0]
  for (const [text, count] of candidates) {
    r -= count
    if (r <= 0) {
      chosen = text
      break
    }
  }

  void triggerSend(chosen, 'routine')
}

/**
 * Collects the list of messages to send for this trigger.
 * - Routine: always just the one chosen message.
 * - Burst + sendAllTrending: every message currently meeting threshold, sorted
 *   by count descending (triggered text first on ties). Each is sent once,
 *   regardless of autoBlendSendCount (which still applies per-message for
 *   single-message triggers to avoid combinatorial spam).
 */
function collectBurst(
  triggeredText: string,
  reason: string
): Array<{ text: string; uniqueUsers: number; totalCount: number }> {
  if (reason !== 'burst' || !autoBlendSendAllTrending.value) {
    const entry = trendMap.get(triggeredText)
    const uniqueUsers = entry ? countUniqueUids(entry.events) : 0
    const totalCount = entry ? entry.events.length : 0
    return [{ text: triggeredText, uniqueUsers, totalCount }]
  }

  const all: Array<{ text: string; uniqueUsers: number; totalCount: number }> = []
  for (const [text, entry] of trendMap) {
    if (meetsThreshold(entry)) {
      all.push({ text, uniqueUsers: countUniqueUids(entry.events), totalCount: entry.events.length })
    }
  }

  // Sort by count descending; triggered text wins ties.
  all.sort((a, b) => {
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount
    return a.text === triggeredText ? -1 : 1
  })

  return all.length > 0 ? all : [{ text: triggeredText, uniqueUsers: 0, totalCount: 0 }]
}

async function triggerSend(triggeredText: string, reason: string): Promise<void> {
  // Claim the slot atomically. Bail without engaging cooldown so the trend
  // keeps accumulating and can re-evaluate once this send completes.
  if (isSending) {
    // Only log for routine skips — burst can fire dozens of times per second
    // during a wave, which would flood the log panel.
    if (reason === 'routine') {
      const text = shortAutoBlendText(triggeredText)
      autoBlendLastActionText.value = `还在发，先跳过：${text}`
      logAutoBlend(`自动跟车：还在发，先跳过补跟：${text}`)
    }
    return
  }
  isSending = true
  updateStatusText()

  pruneExpired(Date.now())
  const targets = collectBurst(triggeredText, reason)

  // Cooldown + trendMap.delete are deferred to the first target that actually
  // reaches the send step (see `engageCooldownOnce` below). If every target
  // is filtered out (locked/unavailable emoticon, AI 润色 (YOLO) LLM gap or
  // empty output, LLM error), nothing fires — and we must not consume a 20–45s
  // cooldown for a no-op wave the user never saw followed.
  let cooldownEngaged = false
  const engageCooldownOnce = (): void => {
    if (cooldownEngaged) return
    cooldownEngaged = true
    // 实时读 effective cooldown(自动模式下会按当前 CPM 算):突发命中的瞬间
    // 立刻拿到积极的冷却值,而不是回看上一次 sample。
    const cooldownNow = Date.now()
    cooldownUntil = cooldownNow + getEffectiveCooldownMs(cooldownNow)
    // Remove all targeted entries upfront so they don't immediately re-trigger
    // when cooldown ends; non-targeted entries keep their counts.
    for (const { text } of targets) trendMap.delete(text)
    updateCandidateText()
    updateStatusText()
  }

  try {
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      autoBlendLastActionText.value = '未登录，跳过'
      logAutoBlend('自动跟车：没检测到登录态，先跳过', 'warning')
      return
    }
    const roomId = await ensureRoomId()

    const reasonLabel = reason === 'burst' ? '刚刷起来' : '补跟'

    // For multi-trend burst: log the summary header upfront.
    // For single target: skip the trigger line — result will carry all info in one line.
    // For multi-trend burst each message is sent once; for single-message
    // triggers autoBlendSendCount controls how many times to repeat.
    const isMulti = targets.length > 1
    if (isMulti) {
      logAutoBlend(`自动跟车：同一波有 ${targets.length} 句话达标，开始依次跟`)
    }

    let memeRecorded = false

    for (let ti = 0; ti < targets.length; ti++) {
      // F: 用户中途关闭自动跟车 → 立刻停止整批发送,不再消费冷却也不再 enqueue。
      if (!autoBlendEnabled.value) break
      const { text: originalText, uniqueUsers, totalCount } = targets[ti]
      if (isLockedEmoticon(originalText)) {
        logAutoBlend(formatLockedEmoticonReject(originalText, '自动跟车(表情)'), 'warning')
        continue
      }
      // Safety net: 同 recordDanmaku 处的同位过滤,但表情缓存如果在累积期内
      // 才加载(罕见竞态),早期过滤没赶上;到这里时缓存已稳定可靠,再补一刀。
      if (isUnavailableEmoticon(originalText)) {
        logAutoBlend(formatUnavailableEmoticonReject(originalText, '自动跟车(表情)'), 'warning')
        continue
      }
      const isEmote = isEmoticonUnique(originalText)

      // AI 润色（原代号 YOLO；自动跟车的 LLM 改写）：在所有 fork-specific 过滤都过完后,
      // 在 applyReplacements 之前。这样：
      //   - 文本/UID/locked/unavailable/large-emote 黑名单都已经把不该跟的拦下来了
      //     （改写不会绕过黑名单），
      //   - 替换规则仍然作为最后一道安全网套用在改写结果上,
      //   - 表情类（unique ID）一律不送 LLM——它是一串不透明的标识符,改写没意义。
      // 失败/未配置：跳过该 target,不耗冷却（continue 让外层多 target 的 burst 继续）。
      // signal 名仍叫 `autoBlendYolo`（GM 持久化键），保留以避免用户配置迁移。
      let polished = originalText
      if (autoBlendYolo.value && !isEmote) {
        const gap = describeLlmGap('autoBlend')
        if (gap) {
          autoBlendLastActionText.value = `自动跟车 AI 润色 跳过：${gap}`
          logAutoBlend(`🤖 自动跟车 AI 润色 跳过（${shortAutoBlendText(originalText)}）：${gap}`, 'warning')
          continue
        }
        try {
          const out = (await polishWithLlm('autoBlend', originalText)).trim()
          if (!out) {
            logAutoBlend(`🤖 自动跟车 AI 润色 跳过（${shortAutoBlendText(originalText)}）：LLM 返回为空`, 'warning')
            continue
          }
          polished = out
          logAutoBlend(`🤖 自动跟车 AI 润色：${shortAutoBlendText(originalText)} → ${shortAutoBlendText(polished)}`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logAutoBlend(`🤖 自动跟车 AI 润色 跳过（${shortAutoBlendText(originalText)}）：${msg}`, 'warning')
          continue
        }
      }

      const useReplacements = autoBlendUseReplacements.value && !isEmote
      const replaced = useReplacements ? applyReplacements(polished) : polished
      const wasReplaced = polished !== originalText || (useReplacements && polished !== replaced)

      if (isMulti) {
        logAutoBlend(`  - ${shortAutoBlendText(originalText)}（${formatAutoBlendSenderInfo(uniqueUsers, totalCount)}）`)
      }

      const repeatCount =
        reason === 'burst' && autoBlendSendAllTrending.value ? 1 : Math.max(1, autoBlendSendCount.value)

      // 这一刻才确定真要发(所有早期过滤都过了),在这里 engage 全局冷却 + 从
      // trendMap 摘掉本批所有目标。dry-run 也算"发"——它同样要被冷却约束。
      engageCooldownOnce()

      for (let i = 0; i < repeatCount; i++) {
        // F: 用户中途关闭自动跟车 → 立刻终止该 target 的重发循环。
        if (!autoBlendEnabled.value) break
        let toSend = replaced
        if (!isEmote && randomChar.value) toSend = addRandomCharacter(toSend)
        if (!isEmote) toSend = trimText(toSend, maxLength.value)[0] ?? toSend

        if (!isEmote && randomColor.value) {
          await setRandomDanmakuColor(roomId, csrfToken)
        }

        const display = wasReplaced || toSend !== originalText ? `${originalText} → ${toSend}` : toSend

        if (autoBlendDryRun.value) {
          autoBlendLastActionText.value = `试运行命中：${shortAutoBlendText(display)}`
          logAutoBlend(`自动跟车试运行（未发送）：${display}`)
          continue
        }

        const result = await enqueueDanmaku(toSend, roomId, csrfToken, SendPriority.AUTO)

        if (isMulti) {
          const label = repeatCount > 1 ? `自动跟车 [${i + 1}/${repeatCount}]` : '自动跟车'
          logAutoBlendSendResult(result, label, display)
          if (result.success && !result.cancelled) {
            autoBlendLastActionText.value = `已跟车：${shortAutoBlendText(display)}`
          } else if (result.cancelled) {
            autoBlendLastActionText.value = `被手动发送打断：${shortAutoBlendText(display)}`
          } else {
            autoBlendLastActionText.value = `没发出去：${shortAutoBlendText(display)}`
          }
        } else {
          // Single target: one compact line combining trigger info + result.
          const info = `${reasonLabel}，${formatAutoBlendSenderInfo(uniqueUsers, totalCount)}`
          const repeatSuffix = repeatCount > 1 ? ` [${i + 1}/${repeatCount}]` : ''
          if (result.cancelled) {
            autoBlendLastActionText.value = `被手动发送打断：${shortAutoBlendText(display)}`
            logAutoBlend(`自动跟车${repeatSuffix}：被手动发送打断：${display}`)
          } else if (result.success) {
            autoBlendLastActionText.value = `已跟车：${shortAutoBlendText(display)}`
            logAutoBlend(`已跟车${repeatSuffix}（${info}）：${display}`)
          } else {
            const error = formatDanmakuError(result.error)
            autoBlendLastActionText.value = `没发出去：${shortAutoBlendText(display)}`
            logAutoBlend(`自动跟车没发出去${repeatSuffix}（${info}）：${display}，原因：${error}`, 'error')
          }
        }

        if (result.success && !result.cancelled) {
          // 仅在 *实际成功送出* 后才把原文记入 avoid-repeat 指纹。
          // 早期版本在 send 之前就无条件写入,会把"被手动打断/被审核拒绝/接口失败"
          // 的句子也永久打入历史,导致用户后来手动想发同一句也被 recordDanmaku
          // 静默过滤掉。始终用 *原文*(未润色)做指纹——这样即使 LLM 把 "666" 润色
          // 成 "哥哥太厉害了",下一波同样的 "666" 仍会被识别为重复。
          lastAutoSentText = originalText
          autoBlendLastActionText.value = `已提交，等待回显：${shortAutoBlendText(display)}`
          // Route through verifyBroadcast so the auto-follow path gets the
          // same shadow-ban → AI-evasion → rule-learning chain that the
          // manual / +1 / loop paths use. verifyBroadcast handles the ⚠️
          // log + bypass-suggestion candidates + optional auto-resend
          // (when shadowBanMode === 'auto-resend') internally.
          const echoSource = await verifyBroadcast({
            text: toSend,
            label: '自动',
            display,
            sinceTs: result.startedAt ?? Date.now(),
            isEmoticon: isEmote,
            enableAiEvasion: true,
            roomId,
            csrfToken,
            toastDedupeKey: `auto-blend:${originalText}`,
          })
          if (echoSource === 'ws' || echoSource === 'dom') {
            consecutiveSilentDrops = 0
            const sourceLabel = echoSource === 'ws' ? 'WS' : 'DOM'
            autoBlendLastActionText.value = `已${sourceLabel}回显：${shortAutoBlendText(display)}`
          } else if (isEmote) {
            // verifyBroadcast skips echo wait for emoticons (broadcast text
            // often differs from the click-text). Don't count as a silent drop.
            consecutiveSilentDrops = 0
          } else {
            // API accepted (code 0) but no WS/DOM broadcast echo — Bilibili silently
            // discarded the message. Common causes: muted in room, fan medal required,
            // account risk control, or send frequency too high.
            // verifyBroadcast already wrote the ⚠️ warning + AI evasion side
            // effects; here we just keep the silent-drop counter for the
            // 3-strike room-restriction probe and update the panel status.
            consecutiveSilentDrops++
            autoBlendLastActionText.value = `接口成功未见广播：${shortAutoBlendText(display)}`

            if (consecutiveSilentDrops >= SILENT_DROP_CHECK_THRESHOLD) {
              consecutiveSilentDrops = 0
              logAutoBlend('自动跟车：连续多次未见广播，正在巡检当前房间限制状态…')
              try {
                const signals = await checkSelfRoomRestrictions(roomId)
                if (signals.length > 0) {
                  const desc = signals.map(s => `${s.message}（${s.duration}）`).join('；')
                  stopAutoBlendAfterModeration(`🔴 自动跟车：巡检发现限制，已自动关闭：${desc}`)
                  return
                }
                logAutoBlend(
                  '自动跟车：巡检未发现明确禁言/限制，弹幕仍未广播。可能原因：该房间需要粉丝牌、发送频率过快、或账号存在风控。'
                )
              } catch {
                logAutoBlend('自动跟车：巡检请求失败，无法确认限制原因。', 'warning')
              }
            }
          }
        }

        if (!result.success && !result.cancelled && handleSendFailure(result, roomId)) return

        if (result.success && !result.cancelled && !isEmote && !memeRecorded) {
          memeRecorded = true
          recordMemeCandidate(originalText, roomId)
        }

        {
          const cooldownNow = Date.now()
          cooldownUntil = Math.max(cooldownUntil, cooldownNow + getEffectiveCooldownMs(cooldownNow))
        }
        updateStatusText()

        if (i < repeatCount - 1) {
          const interval = getAutoBlendRepeatGapMs(Date.now())
          const offset = randomInterval.value ? Math.floor(Math.random() * 500) : 0
          await new Promise(r => setTimeout(r, interval + offset))
        }
      }

      // Gap between different trending messages in a multi-send burst.
      if (isMulti && ti < targets.length - 1) {
        await new Promise(r => setTimeout(r, getAutoBlendBurstGapMs()))
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    autoBlendLastActionText.value = `出错：${msg}`
    logAutoBlend('自动跟车出错', 'error', msg)
  } finally {
    // 防紧凑重触发：如果所有 target 都因为表情过滤 / AI 润色 (YOLO) 失败 / LLM 空返回被
    // 跳过（cooldownEngaged 仍为 false），但 trendMap 里那些已达标的 entry 仍在,
    // 下一条同样的弹幕进来会立刻再触发同一波。强制一个短冷却 + 清掉本批
    // trendMap entry，避免日志被刷屏 + 浪费 LLM 配额。短冷却（5s）比正常冷却
    // 短，因为这一波本来就没"实际发出去"，不应消费完整 20-45s。
    if (!cooldownEngaged && targets.length > 0) {
      const FILTERED_WAVE_COOLDOWN_MS = 5000
      cooldownUntil = Math.max(cooldownUntil, Date.now() + FILTERED_WAVE_COOLDOWN_MS)
      for (const { text } of targets) trendMap.delete(text)
      updateCandidateText()
    }
    isSending = false
    updateStatusText()
  }
}

export function startAutoBlend(): void {
  if (unsubscribe) return
  myUid = getDedeUid() ?? null
  rateLimitHitCount = 0
  firstRateLimitHitAt = 0
  moderationStopReason = null
  consecutiveSilentDrops = 0
  consecutiveUnknownErrors = 0
  nextTrendPruneAt = Number.POSITIVE_INFINITY
  lastPruneWindowMs = 0
  autoBlendStatusText.value = '观察中'
  autoBlendCandidateText.value = '暂无'
  autoBlendCandidateProgress.value = null
  autoBlendLastActionText.value = '暂无'

  unsubscribe = subscribeDanmaku({
    onMessage: ev => recordDanmaku(ev.text, ev.uid, ev.isReply, ev.hasLargeEmote),
  })
  startLiveWsSource()
  unsubscribeWsDanmaku = subscribeCustomChatEvents(event => {
    if (event.kind !== 'danmaku' || event.source !== 'ws') return
    // WS 协议没有 bulge-emoticon DOM marker;大表情判定只在 DOM 流上有效。
    // WS 流统一传 false——若 DOM 流后续观察到同一条会自然命中过滤。
    recordDanmaku(event.text, event.uid, event.isReply, false)
  })

  if (cleanupTimer === null) {
    cleanupTimer = setInterval(() => {
      // Skip the full pipeline (prune + status format + burst scheduling)
      // when there's nothing to evaluate. This timer fires once a second for
      // the entire feature lifetime, including idle rooms.
      if (trendMap.size === 0) return
      pruneExpired(Date.now())
      updateStatusText()
      maybeScheduleBurstFromCurrentTrends()
    }, 1000)
  }

  routineActive = true
  scheduleNextRoutine()

  // 跨 tab 互斥：异步抢锁。startAutoBlend 必须保持同步签名（既有测试和 useEffect
  // 都按 sync 调用），所以这里不 await。如果抢锁失败（另一个 tab 持锁），异步
  // 回调 stopAutoBlend + 把 enabled 置 false + 提示用户。
  //
  // 微小窗口（一次微任务）内 runtime 已启动但锁未确认——可接受，因为：
  //   - recordDanmaku 只往 trendMap 加,不直接发
  //   - scheduleBurstSend 用 setTimeout(>= 100ms burstSettleMs)
  //   - routineTimerTick 间隔 ≥ 10s
  // 微任务先于这些 timer 触发,所以这一窗口内不会出现实际发送。
  const roomIdAtStart = cachedRoomId.peek()
  if (roomIdAtStart !== null) {
    void tryAcquireAutoBlendLock(roomIdAtStart).then(acquired => {
      if (!acquired && autoBlendEnabled.value) {
        autoBlendEnabled.value = false
        // stopAutoBlend 会被 app.tsx 的 useEffect 触发,但我们也显式调一遍
        // 以防止 race（signal 已置 false 但 effect 还没跑）。stopAutoBlend
        // 是幂等的——见 `if (cleanupTimer)` 等守卫。
        stopAutoBlend()
        autoBlendStatusText.value = '已被另一 tab 占用'
        autoBlendLastActionText.value = '另一个 tab 已经在跟车，本 tab 让出'
        logAutoBlend(
          '⚠️ 自动跟车：检测到本浏览器另一个 tab 已经在同一直播间开了自动跟车，本 tab 不重复启动——避免 B 站按双倍频率风控。请关掉那个 tab 后再试。',
          'warning'
        )
      }
    })
  }
}

export function stopAutoBlend(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
  routineActive = false
  if (routineTimeout) {
    clearTimeout(routineTimeout)
    routineTimeout = null
  }
  if (burstSettleTimer) {
    clearTimeout(burstSettleTimer)
    burstSettleTimer = null
  }
  pendingBurstText = null
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  if (unsubscribeWsDanmaku) {
    unsubscribeWsDanmaku()
    unsubscribeWsDanmaku = null
  }
  stopLiveWsSource()
  trendMap.clear()
  nextTrendPruneAt = Number.POSITIVE_INFINITY
  lastPruneWindowMs = 0
  const currentRoomId = cachedRoomId.peek()
  if (currentRoomId !== null) clearMemeSession(currentRoomId)
  cooldownUntil = 0
  // Mirror `_resetAutoBlendStateForTests`: a triggerSend awaiting
  // verifyBroadcast holds `isSending = true` past stopAutoBlend, so toggling
  // off → on inside that window left the module wedged (next burst gated by
  // the stale flag). The in-flight closure's `finally` will still run and
  // re-set isSending=false harmlessly.
  isSending = false
  consecutiveSilentDrops = 0
  consecutiveUnknownErrors = 0
  rateLimitHitCount = 0
  firstRateLimitHitAt = 0
  lastAutoSentText = null
  messageTimestamps.length = 0
  autoBlendStatusText.value = '已关闭'
  autoBlendCandidateText.value = '暂无'
  autoBlendCandidateProgress.value = null
  autoBlendLastActionText.value = moderationStopReason ?? '暂无'
  moderationStopReason = null
  // 释放跨 tab 互斥锁，让另一个 tab 能接管。
  releaseAutoBlendLock()
}

/**
 * 测试用：把模块级状态完全清掉。`triggerSend` 在等待 `waitForSentEcho`（最长 4s）
 * 时不会立刻退出，于是 `isSending` 这种闭包状态会跨测试泄漏，触发下一个测试
 * 的 `scheduleBurstSend` 早退。仿照 `live-ws-source._resetLiveWsStateForTests`
 * 的形态提供一个测试 seam，便于集成测试在 afterEach 里把模块归零。
 */
export function _resetAutoBlendStateForTests(): void {
  isSending = false
  consecutiveSilentDrops = 0
  consecutiveUnknownErrors = 0
  rateLimitHitCount = 0
  firstRateLimitHitAt = 0
  moderationStopReason = null
  cooldownUntil = 0
  pendingBurstText = null
  lastAutoSentText = null
  messageTimestamps.length = 0
  if (burstSettleTimer) {
    clearTimeout(burstSettleTimer)
    burstSettleTimer = null
  }
  trendMap.clear()
  nextTrendPruneAt = Number.POSITIVE_INFINITY
  lastPruneWindowMs = 0
}
