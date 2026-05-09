import { signal } from '@preact/signals'

import { ensureRoomId, getCsrfToken, getDedeUid, setRandomDanmakuColor } from './api'
import { subscribeDanmaku } from './danmaku-stream'
import { formatLockedEmoticonReject, isEmoticonUnique, isLockedEmoticon } from './emoticon'
import { appendLog } from './log'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  autoBlendAvoidRepeat,
  autoBlendCooldownAuto,
  autoBlendCooldownSec,
  autoBlendEnabled,
  autoBlendIncludeReply,
  autoBlendMessageBlacklist,
  autoBlendMinOccurrences,
  autoBlendSendCount,
  autoBlendUniqueUsers,
  autoBlendUseReplacements,
  autoBlendUserBlacklist,
  autoBlendWindowSec,
  maxLength,
  msgSendInterval,
  randomChar,
  randomColor,
  randomInterval,
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
  /**
   * Cooldown that WOULD be engaged if `triggerSend` fired right now. Reflects
   * the user's fixed `autoBlendCooldownSec` when auto-cooldown is off, or
   * the live CPM-derived value when it's on.
   */
  cooldownEffectiveSec: number
}

/** How many candidates to surface in the UI leaderboard. */
export const CANDIDATE_LIMIT = 3
/**
 * How often the UI snapshot is refreshed. 500 ms gives a snappy feel for the
 * leaderboard while keeping the cooldown countdown's per-second resolution
 * cheap (we re-emit at most twice per second).
 */
const SNAPSHOT_INTERVAL_MS = 500

// === CPM (chats-per-minute) tracking ====================================
//
// We sample the room's velocity over a sliding window so the user — and the
// adaptive-cooldown formula — can react to bursts vs. lulls in close to real
// time. 30 s is short enough that a sudden surge bumps CPM within a few
// seconds, but long enough to smooth out the choppiness of single-message
// noise.
const CPM_WINDOW_SEC = 30
// Floor on the extrapolation window: with a fresh tracker that's only seen
// one or two messages we'd otherwise compute absurd CPMs (a single message
// 100 ms in extrapolates to 600/min). 2 s caps the early-startup bias to a
// sane upper bound while still giving useful readings before the full
// 30 s window has filled.
const CPM_MIN_WINDOW_MS = 2000

// === Adaptive cooldown bounds ===========================================
//
// COOLDOWN_FLOOR_SEC matches the user's "2 second a chat at most" intent —
// even on the busiest rooms we won't fire more often than this. Ceiling
// keeps quiet rooms from waiting forever between sends.
const COOLDOWN_FLOOR_SEC = 2
const COOLDOWN_CEILING_SEC = 60
// "Stealth factor" K satisfies: at the chosen cooldown, exactly K/60 other
// messages will land between our sends. K=300 → ~5 messages between sends
// at any chat speed, which empirically reads as "blended in" without
// monopolizing fast rooms or feeling robotic in slow ones.
const COOLDOWN_STEALTH_K = 300

const counters = new Map<string, Counter>()
/**
 * Monotonic timestamps (ms) of every non-self danmaku observed since
 * `startAutoBlend`. Pruned to the last `CPM_WINDOW_SEC` on every read.
 * We track even messages that don't qualify as candidates (blacklisted
 * users, locked emotes, replies, in-cooldown traffic) because CPM is a
 * proxy for ROOM activity, not for trigger-eligible activity.
 */
const messageTimestamps: number[] = []
// Global hard cooldown: while `Date.now() < cooldownUntil`, EVERY incoming
// danmaku is discarded (not counted, not recorded). Engaged after a successful
// trigger so post-trigger noise (echoes of our own send, copycat trends, the
// pile-on after a popular line lands) cannot stack into another back-to-back
// auto-send.
let cooldownUntil = 0

let unsubscribe: (() => void) | null = null
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let myUid: string | null = null
let isSending = false
// Last trend text we successfully auto-sent (post-trim, pre-replacement —
// i.e. the same string used as the counters Map key). When
// `autoBlendAvoidRepeat` is on, identical incoming danmaku are dropped in
// `recordDanmaku` so the trend can't re-fire. Cleared on stopAutoBlend;
// overwritten on every successful trigger so consecutive distinct trends
// fire normally.
let lastAutoSentText: string | null = null

/**
 * Live snapshot consumed by `AutoBlendControls` so the user can see which
 * danmaku are currently accumulating toward the trigger, the room's chat
 * velocity, and how long the post-trigger cooldown still has to run.
 */
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

/**
 * Current chats-per-minute. Extrapolates from the actual span of the
 * tracked timestamps so a fresh tracker reaches a realistic reading within
 * seconds rather than waiting the full 30 s window to fill — capped by
 * `CPM_MIN_WINDOW_MS` to prevent single-message readings from spiking.
 */
function getCurrentCpm(now: number): number {
  pruneOldTimestamps(now)
  const n = messageTimestamps.length
  if (n === 0) return 0
  const spanMs = now - messageTimestamps[0]
  const windowMs = Math.max(CPM_MIN_WINDOW_MS, Math.min(spanMs, CPM_WINDOW_SEC * 1000))
  return Math.round((n * 60_000) / windowMs)
}

/**
 * Map a CPM reading to a cooldown in seconds via `K / cpm`, clamped to the
 * floor / ceiling. Quiet rooms (cpm == 0) get the ceiling so we don't
 * immediately re-fire when chat goes silent right after a trigger.
 */
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

/**
 * Recompute the UI snapshot and write it to `autoBlendStatus`, but only if it
 * actually changed (to avoid spurious component re-renders during quiet
 * moments when the timer keeps ticking but no danmaku have arrived).
 */
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
  // Primary sort by total occurrences (the volume threshold), tie-broken by
  // unique users (the diversity threshold), then by text for a stable order
  // when both are equal — the leaderboard otherwise jitters between equal-
  // weight entries on every tick.
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

function recordDanmaku(rawText: string, uid: string | null, isReply: boolean): void {
  if (!autoBlendEnabled.value) return

  // Self-echo: always ignore. Our own auto-blend sends bounce back through
  // the MutationObserver and would otherwise inflate CPM (skewing adaptive
  // cooldown) and pollute candidate counters. Lifted above the cooldown
  // gate so it's filtered even during the freeze. The post-send cooldown
  // is the backup that catches echoes when uid extraction fails.
  if (uid && myUid && uid === myUid) return

  const now = Date.now()
  // Track every observed (non-self) message for CPM, including those that
  // get filtered out below (blacklisted, locked emote, reply, in cooldown).
  // CPM is meant to reflect ROOM activity, not trigger-eligible activity.
  messageTimestamps.push(now)

  // Global hard cooldown: short-circuit BEFORE any further text work so the
  // freeze is truly global — no counters touched, no echoes leaking through.
  if (now < cooldownUntil) return

  const text = rawText.trim()
  if (!text) return
  if (isReply && !autoBlendIncludeReply.value) return

  // User opt-in: don't let an exact repeat of our last auto-send re-trigger
  // us. Dropped before any counter updates so the blocked text also stays
  // out of the candidate leaderboard — anything still matching is, by
  // definition, the trend we just acted on.
  if (autoBlendAvoidRepeat.value && lastAutoSentText !== null && text === lastAutoSentText) return

  if (uid) {
    // User-level blacklist set via the right-click menu in chat. Discard
    // entirely so the user neither contributes to unique-user counts nor
    // bumps totalCount toward the threshold.
    if (uid in autoBlendUserBlacklist.value) return
  }

  // Message-level blacklist (exact match on the same trimmed text the
  // counters key off). Drop before any counter / leaderboard work so a
  // blacklisted line never appears as a candidate even at 1/N progress.
  // `Object.hasOwn` (not `in`) — keys are arbitrary user text, and `in`
  // walks the prototype chain so it would falsely match every danmaku
  // whose text happens to be `Object.prototype` property name (e.g.
  // "toString", "constructor", "valueOf"), silently filtering them
  // forever even when the blacklist is empty.
  if (Object.hasOwn(autoBlendMessageBlacklist.value, text)) return

  // Locked emotes (fan-club / 舰长 / 提督 / 总督 etc.) can never be
  // auto-sent, so keep them out of `counters` entirely. This stops a popular
  // locked emote from (a) accumulating a trend we couldn't act on and
  // (b) hijacking a `triggerSend` cycle — the global cooldown would
  // otherwise engage and freeze legitimate plain-text trends for several
  // seconds. The `triggerSend` safety net below still catches the rare race
  // where the emoticon cache loads AFTER counters started accumulating.
  if (isLockedEmoticon(text)) return

  pruneExpired(now)

  let c = counters.get(text)
  if (!c) {
    c = { uniqueUids: new Set(), totalCount: 0, firstSeenAt: now, lastSeenAt: now }
    counters.set(text, c)
  }
  c.totalCount++
  c.lastSeenAt = now
  if (uid) c.uniqueUids.add(uid)

  // Require BOTH x distinct users AND z total occurrences within the window.
  // Fallback: when uid extraction fails for every event we use totalCount as
  // a stand-in for unique users, so the feature still works on an unfamiliar
  // DOM (worst case: counts a single spammer as one "user").
  const effectiveUniqueUsers = c.uniqueUids.size > 0 ? c.uniqueUids.size : c.totalCount
  if (effectiveUniqueUsers >= autoBlendUniqueUsers.value && c.totalCount >= autoBlendMinOccurrences.value) {
    void triggerSend(text, c.uniqueUids.size, c.totalCount)
  }
}

async function triggerSend(originalText: string, uniqueUsers: number, totalCount: number): Promise<void> {
  // Claim the slot atomically. If another send is in-flight we bail WITHOUT
  // engaging the cooldown so the trend keeps accumulating and naturally
  // re-evaluates threshold on the next matching danmaku once we're free.
  if (isSending) return

  // Safety net for the rare race where the emoticon cache loaded only AFTER
  // this trend started accumulating in `recordDanmaku` (so the filter there
  // missed it). Bail BEFORE engaging the cooldown / clearing counters, so
  // we don't penalize legitimate plain-text trends for an emote we were
  // never going to send. Drop the trend so it can't immediately re-fire.
  if (isLockedEmoticon(originalText)) {
    counters.delete(originalText)
    appendLog(formatLockedEmoticonReject(originalText, '自动融入(表情)'))
    return
  }

  isSending = true
  // Engage the global hard cooldown up front (before the await) and wipe all
  // pending counters so nothing accumulates during the freeze and nothing
  // fires the instant the freeze ends with stale, half-built trends.
  // Cooldown duration is whatever the user-or-auto policy resolves to RIGHT
  // NOW — read fresh (not from the snapshot signal) so a bursty room gets
  // an aggressive cooldown the moment it actually triggers, even if the
  // last 500 ms snapshot tick read a slower CPM.
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
    const useReplacements = autoBlendUseReplacements.value && !isEmote
    const replaced = useReplacements ? applyReplacements(originalText) : originalText
    const wasReplaced = useReplacements && originalText !== replaced

    const repeatCount = Math.max(1, autoBlendSendCount.value)
    const senderInfo = uniqueUsers > 0 ? `${uniqueUsers} 人 / ${totalCount} 条` : `${totalCount} 条`
    appendLog(`🚲 自动融入触发 (${senderInfo}): ${originalText}`)

    // Record what we're acting on BEFORE the loop so `autoBlendAvoidRepeat`
    // takes effect even if some repeats inside the burst fail — the user's
    // intent ("don't re-fire on this trend") doesn't depend on every send
    // succeeding. Tracked unconditionally; only consulted when the option
    // is on, so flipping it off doesn't require us to keep this updated.
    lastAutoSentText = originalText

    for (let i = 0; i < repeatCount; i++) {
      let toSend = replaced
      if (!isEmote && randomChar.value) toSend = addRandomCharacter(toSend)
      if (!isEmote) toSend = trimText(toSend, maxLength.value)[0] ?? toSend

      if (!isEmote && randomColor.value) {
        await setRandomDanmakuColor(roomId, csrfToken)
      }

      const result = await enqueueDanmaku(toSend, roomId, csrfToken, SendPriority.AUTO)
      const baseLabel = result.isEmoticon ? '自动融入(表情)' : '自动融入'
      const label = repeatCount > 1 ? `${baseLabel} [${i + 1}/${repeatCount}]` : baseLabel
      const display = wasReplaced || toSend !== originalText ? `${originalText} → ${toSend}` : toSend
      appendLog(result, label, display)

      if (i < repeatCount - 1) {
        const interval = msgSendInterval.value * 1000
        const offset = randomInterval.value ? Math.floor(Math.random() * 500) : 0
        await new Promise(r => setTimeout(r, Math.max(0, interval - offset)))
      }
    }
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
    onMessage: ev => recordDanmaku(ev.text, ev.uid, ev.isReply),
  })

  // Single timer drives both the safety-net prune (in case the room goes
  // quiet and no `recordDanmaku` calls fire to prune from the inside) AND
  // the live UI snapshot. 500 ms is fast enough for a responsive
  // leaderboard / cooldown countdown but slow enough that the per-tick
  // sort+slice over a small Map is negligible.
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
  lastAutoSentText = null
  autoBlendStatus.value = { candidates: [], cooldownRemainingSec: 0, chatsPerMinute: 0, cooldownEffectiveSec: 0 }
}
