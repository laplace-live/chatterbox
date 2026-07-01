import { computed, signal } from '@preact/signals'

import { ensureRoomId, getCsrfToken, getDedeUid, setRandomDanmakuColor } from './api'
import { subscribeDanmaku } from './danmaku-stream'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { isLlmReady, polishWithLlm } from './llm-tasks'
import { appendLog } from './log'
import { compileMessageBlacklist, testMessageBlacklist } from './message-blacklist'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  autoBlendAvoidRepeat,
  autoBlendAvoidRepeatCount,
  autoBlendCooldownAuto,
  autoBlendCooldownSec,
  autoBlendEnabled,
  autoBlendMessageBlacklist,
  autoBlendMinOccurrences,
  autoBlendUniqueUsers,
  autoBlendUseReplacements,
  autoBlendUserBlacklist,
  autoBlendWindowSec,
  autoBlendYolo,
  maxLength,
  randomChar,
  randomColor,
} from './store'
import { addRandomCharacter, trimText } from './utils'

interface Counter {
  uniqueUids: Set<string>
  totalCount: number
  firstSeenAt: number
  lastSeenAt: number
}

/** A single row in the live "融入候选" leaderboard surfaced in the UI. */
export interface AutoBlendCandidate {
  text: string
  uniqueUsers: number
  totalCount: number
}

/** UI-facing live status: top-N candidates + room rhythm + cooldown info. */
export interface AutoBlendStatusValue {
  candidates: AutoBlendCandidate[]
  /** Seconds left in the post-trigger freeze, or 0 when not cooling down. */
  cooldownRemainingSec: number
  /** Rounded chats-per-minute of the room (excluding our own self-echoes). */
  chatsPerMinute: number
  /** Cooldown that would engage if `triggerSend` fired now (fixed or CPM-derived). */
  cooldownEffectiveSec: number
}

/** How many candidates to surface in the UI leaderboard. */
export const CANDIDATE_LIMIT = 3
const SNAPSHOT_INTERVAL_MS = 500

// CPM sampling window; short enough to catch surges, long enough to smooth noise.
const CPM_WINDOW_SEC = 30
// Extrapolation floor: caps absurd CPMs from a fresh tracker (one msg 100 ms in → 600/min).
const CPM_MIN_WINDOW_MS = 2000

const COOLDOWN_FLOOR_SEC = 2
const COOLDOWN_CEILING_SEC = 60
// Stealth factor: ~K/60 other messages land between our sends at any chat speed.
const COOLDOWN_STEALTH_K = 300

const counters = new Map<string, Counter>()
// Timestamps (ms) of every non-self danmaku; tracks ROOM activity, so includes
// messages that don't qualify as candidates. Pruned to `CPM_WINDOW_SEC` per read.
const messageTimestamps: number[] = []
// Global hard cooldown: while `Date.now() < cooldownUntil` every danmaku is
// discarded, so post-trigger noise can't stack into a back-to-back auto-send.
let cooldownUntil = 0

let unsubscribe: (() => void) | null = null
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let myUid: string | null = null
let isSending = false
// Recent auto-sent trends (counters Map keys); blocks re-fire of any within the last `autoBlendAvoidRepeatCount` when `autoBlendAvoidRepeat` is on.
let recentAutoSentTexts: string[] = []

/** Live snapshot consumed by `AutoBlendControls`: candidates, CPM, cooldown countdown. */
export const autoBlendStatus = signal<AutoBlendStatusValue>({
  candidates: [],
  cooldownRemainingSec: 0,
  chatsPerMinute: 0,
  cooldownEffectiveSec: 0,
})

function pruneExpired(now: number): void {
  const windowMs = autoBlendWindowSec.value * 1000
  for (const [k, c] of counters) {
    if (now - c.lastSeenAt > windowMs) counters.delete(k)
  }
}

function pruneOldTimestamps(now: number): void {
  const cutoff = now - CPM_WINDOW_SEC * 1000
  let i = 0
  while (i < messageTimestamps.length && messageTimestamps[i] < cutoff) i++
  if (i > 0) messageTimestamps.splice(0, i)
}

/** Current chats-per-minute, extrapolated from the tracked span (floored by `CPM_MIN_WINDOW_MS`). */
function getCurrentCpm(now: number): number {
  pruneOldTimestamps(now)
  const n = messageTimestamps.length
  if (n === 0) return 0
  const spanMs = now - messageTimestamps[0]
  const windowMs = Math.max(CPM_MIN_WINDOW_MS, Math.min(spanMs, CPM_WINDOW_SEC * 1000))
  return Math.round((n * 60_000) / windowMs)
}

/** Map CPM to a cooldown (sec) via `K / cpm`, clamped to floor/ceiling; cpm 0 → ceiling. */
function computeAutoCooldownSec(cpm: number): number {
  if (cpm <= 0) return COOLDOWN_CEILING_SEC
  const auto = Math.round(COOLDOWN_STEALTH_K / cpm)
  return Math.min(COOLDOWN_CEILING_SEC, Math.max(COOLDOWN_FLOOR_SEC, auto))
}

/** The cooldown that would be engaged if `triggerSend` fired right now. */
function getEffectiveCooldownSec(now: number): number {
  if (!autoBlendCooldownAuto.value) return autoBlendCooldownSec.value
  return computeAutoCooldownSec(getCurrentCpm(now))
}

function candidatesEqual(a: AutoBlendCandidate[], b: AutoBlendCandidate[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.text !== y.text || x.uniqueUsers !== y.uniqueUsers || x.totalCount !== y.totalCount) return false
  }
  return true
}

/** Recompute the UI snapshot; writes `autoBlendStatus` only on change to avoid spurious re-renders. */
function emitStatus(now: number): void {
  const cooldownRemainingSec = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))
  const chatsPerMinute = getCurrentCpm(now)
  const cooldownEffectiveSec = autoBlendCooldownAuto.value
    ? computeAutoCooldownSec(chatsPerMinute)
    : autoBlendCooldownSec.value

  const candidates: AutoBlendCandidate[] = []
  for (const [text, c] of counters) {
    candidates.push({ text, uniqueUsers: c.uniqueUids.size, totalCount: c.totalCount })
  }
  // Sort by total, then unique users, then text for a stable order (else the leaderboard jitters).
  candidates.sort(
    (a, b) => b.totalCount - a.totalCount || b.uniqueUsers - a.uniqueUsers || a.text.localeCompare(b.text, 'zh-Hans-CN')
  )
  if (candidates.length > CANDIDATE_LIMIT) candidates.length = CANDIDATE_LIMIT

  const prev = autoBlendStatus.peek()
  if (
    prev.cooldownRemainingSec === cooldownRemainingSec &&
    prev.chatsPerMinute === chatsPerMinute &&
    prev.cooldownEffectiveSec === cooldownEffectiveSec &&
    candidatesEqual(prev.candidates, candidates)
  ) {
    return
  }

  autoBlendStatus.value = { candidates, cooldownRemainingSec, chatsPerMinute, cooldownEffectiveSec }
}

// `computed` so patterns compile once per blacklist edit, not per danmaku (hot path).
const messageBlacklistMatcher = computed(() => compileMessageBlacklist(Object.keys(autoBlendMessageBlacklist.value)))

function recordDanmaku(rawText: string, uid: string | null, isReply: boolean, hasLargeEmote: boolean): void {
  if (!autoBlendEnabled.value) return

  // Self-echo: filtered above the cooldown gate so our own sends never inflate CPM or counters.
  if (uid && myUid && uid === myUid) return

  const now = Date.now()
  // CPM reflects ROOM activity, so record even messages filtered out below.
  messageTimestamps.push(now)

  // Short-circuit the global freeze before any text work so nothing leaks through.
  if (now < cooldownUntil) return

  const text = rawText.trim()
  if (!text) return
  // @ replies target one user, never a trend.
  if (isReply) return

  // Don't let an exact repeat of a recent auto-send re-trigger; dropped pre-counter so it stays off the leaderboard.
  if (autoBlendAvoidRepeat.value && recentAutoSentTexts.slice(-autoBlendAvoidRepeatCount.value).includes(text)) return

  if (uid) {
    if (uid in autoBlendUserBlacklist.value) return
  }

  // Literal entries match the whole trimmed text; `/pattern/flags` catch evasion variants (口交 / 口***交 / 口 活 交).
  if (testMessageBlacklist(messageBlacklistMatcher.value, text)) return

  // Locked emotes (fan-club / 舰长 / 提督 / 总督) can't be auto-sent; keep them out of `counters` so they
  // don't accumulate an unactionable trend or waste a `triggerSend` cooldown. `triggerSend` re-checks the cache race.
  if (isLockedEmoticon(text)) return

  // Cross-room emote IDs (`room_<otherRoom>_<id>`) would land as plain text; drop like locked emotes.
  // `isUnavailableEmoticon` is a no-op until the cache loads, so current-room IDs aren't filtered during startup.
  if (isUnavailableEmoticon(text)) return

  // 大表情 (DOM marker `.bulge`): `data-danmaku` is the display name (emoticon `emoji`, not `emoticon_unique`),
  // so `isEmoticonUnique` always returns false and it would send as raw text (e.g. "应援") — drop it.
  if (hasLargeEmote) return

  pruneExpired(now)

  let c = counters.get(text)
  if (!c) {
    c = { uniqueUids: new Set(), totalCount: 0, firstSeenAt: now, lastSeenAt: now }
    counters.set(text, c)
  }
  c.totalCount++
  c.lastSeenAt = now
  if (uid) c.uniqueUids.add(uid)

  // Require both distinct-user and total-occurrence thresholds; fall back to totalCount when uid extraction fails.
  const effectiveUniqueUsers = c.uniqueUids.size > 0 ? c.uniqueUids.size : c.totalCount
  if (effectiveUniqueUsers >= autoBlendUniqueUsers.value && c.totalCount >= autoBlendMinOccurrences.value) {
    void triggerSend(text, c.uniqueUids.size, c.totalCount)
  }
}

async function triggerSend(originalText: string, uniqueUsers: number, totalCount: number): Promise<void> {
  // Bail without engaging cooldown if a send is in-flight, so the trend keeps accumulating.
  if (isSending) return

  // Safety net for the cache-load race that `recordDanmaku` missed; bail before cooldown/clear, drop so it can't re-fire.
  if (isLockedEmoticon(originalText)) {
    counters.delete(originalText)
    appendLog(formatLockedEmoticonReject(originalText, '自动融入(表情)'))
    return
  }

  // Same race / handling for cross-room emote IDs; by trigger time the cache has reliably loaded.
  if (isUnavailableEmoticon(originalText)) {
    counters.delete(originalText)
    appendLog(formatUnavailableEmoticonReject(originalText, '自动融入(表情)'))
    return
  }

  isSending = true
  // Engage the freeze and clear counters before the await; read cooldown fresh (not the snapshot signal)
  // so a bursty room gets an aggressive cooldown the moment it triggers.
  const cooldownNow = Date.now()
  cooldownUntil = cooldownNow + getEffectiveCooldownSec(cooldownNow) * 1000
  counters.clear()
  try {
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('🚲 自动融入：未登录，跳过')
      return
    }
    const roomId = await ensureRoomId()

    const isEmote = isEmoticonUnique(originalText)

    // Polish the ORIGINAL trend (not the post-replacement string) so the LLM sees natural Chinese;
    // once per trigger (not per repeat) to bound cost. Skipped for emotes (opaque ID → useless plain text).
    let yoloed = originalText
    if (autoBlendYolo.value && !isEmote) {
      if (!isLlmReady('autoBlend')) {
        // Cooldown is already engaged — prevents log-spam re-firing while misconfigured.
        appendLog('🚲 自动融入 YOLO 已开启，但 LLM 配置不完整，本轮跳过')
        return
      }
      try {
        const polished = await polishWithLlm('autoBlend', originalText)
        if (!polished.trim()) {
          // Empty polish = refusal; bail rather than send an empty danmaku.
          appendLog('⚠️ 自动融入 AI 返回为空，本轮跳过')
          return
        }
        appendLog(`✨ 自动融入 AI 润色：${originalText} → ${polished}`)
        yoloed = polished
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        appendLog(`🔴 自动融入 AI 润色失败：${msg}`)
        return
      }
    }

    const useReplacements = autoBlendUseReplacements.value && !isEmote
    const replaced = useReplacements ? applyReplacements(yoloed) : yoloed
    // Drives the `→` arrow in the log when any transform (YOLO or replacement) changed the string.
    const wasReplaced = replaced !== originalText

    const senderInfo = uniqueUsers > 0 ? `${uniqueUsers} 人 / ${totalCount} 条` : `${totalCount} 条`
    appendLog(`🚲 自动融入触发 (${senderInfo}): ${originalText}`)

    // Record before sending so `autoBlendAvoidRepeat` holds even if the send fails.
    recentAutoSentTexts.push(originalText)
    const avoidCap = autoBlendAvoidRepeatCount.value
    if (recentAutoSentTexts.length > avoidCap) recentAutoSentTexts = recentAutoSentTexts.slice(-avoidCap)

    let toSend = replaced
    if (!isEmote && randomChar.value) toSend = addRandomCharacter(toSend)
    if (!isEmote) toSend = trimText(toSend, maxLength.value)[0] ?? toSend

    if (!isEmote && randomColor.value) {
      await setRandomDanmakuColor(roomId, csrfToken)
    }

    const result = await enqueueDanmaku(toSend, roomId, csrfToken, SendPriority.AUTO)
    const label = result.isEmoticon ? '自动融入(表情)' : '自动融入'
    const display = wasReplaced || toSend !== originalText ? `${originalText} → ${toSend}` : toSend
    appendLog(result, label, display)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 自动融入出错：${msg}`)
  } finally {
    isSending = false
  }
}

export function startAutoBlend(): void {
  if (unsubscribe) return
  myUid = getDedeUid() ?? null

  unsubscribe = subscribeDanmaku({
    onMessage: ev => recordDanmaku(ev.text, ev.uid, ev.isReply, ev.hasLargeEmote),
  })

  // One timer drives both the safety-net prune (when the room is quiet) and the UI snapshot.
  if (snapshotTimer === null) {
    snapshotTimer = setInterval(() => {
      const now = Date.now()
      pruneExpired(now)
      emitStatus(now)
    }, SNAPSHOT_INTERVAL_MS)
  }
}

export function stopAutoBlend(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer)
    snapshotTimer = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  counters.clear()
  messageTimestamps.length = 0
  cooldownUntil = 0
  recentAutoSentTexts = []
  autoBlendStatus.value = { candidates: [], cooldownRemainingSec: 0, chatsPerMinute: 0, cooldownEffectiveSec: 0 }
}
