import { ensureRoomId, getCsrfToken, getDedeUid, setRandomDanmakuColor } from './api'
import { subscribeDanmaku } from './danmaku-stream'
import { formatLockedEmoticonReject, isEmoticonUnique, isLockedEmoticon } from './emoticon'
import { appendLog } from './log'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  autoBlendCooldownSec,
  autoBlendEnabled,
  autoBlendIncludeReply,
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

const counters = new Map<string, Counter>()
// Global hard cooldown: while `Date.now() < cooldownUntil`, EVERY incoming
// danmaku is discarded (not counted, not recorded). Engaged after a successful
// trigger so post-trigger noise (echoes of our own send, copycat trends, the
// pile-on after a popular line lands) cannot stack into another back-to-back
// auto-send.
let cooldownUntil = 0

let unsubscribe: (() => void) | null = null
let cleanupTimer: ReturnType<typeof setInterval> | null = null
let myUid: string | null = null
let isSending = false

function pruneExpired(now: number): void {
  const windowMs = autoBlendWindowSec.value * 1000
  for (const [k, c] of counters) {
    if (now - c.lastSeenAt > windowMs) counters.delete(k)
  }
}

function recordDanmaku(rawText: string, uid: string | null, isReply: boolean): void {
  if (!autoBlendEnabled.value) return

  // Global hard cooldown: short-circuit BEFORE any text/uid work so the freeze
  // is truly global — no counters touched, no echoes leaking through, no work
  // done on incoming events at all.
  const now = Date.now()
  if (now < cooldownUntil) return

  const text = rawText.trim()
  if (!text) return
  if (isReply && !autoBlendIncludeReply.value) return

  if (uid) {
    // Always exclude self by uid; the global cooldown after our own send is
    // the backup that catches echoes when uid extraction fails.
    if (myUid && uid === myUid) return
    // User-level blacklist set via the right-click menu in chat. Discard
    // entirely so the user neither contributes to unique-user counts nor
    // bumps totalCount toward the threshold.
    if (uid in autoBlendUserBlacklist.value) return
  }

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
  isSending = true
  // Engage the global hard cooldown up front (before the await) and wipe all
  // pending counters so nothing accumulates during the freeze and nothing
  // fires the instant the freeze ends with stale, half-built trends.
  cooldownUntil = Date.now() + autoBlendCooldownSec.value * 1000
  counters.clear()
  try {
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('🚲 自动融入：未登录，跳过')
      return
    }
    const roomId = await ensureRoomId()

    // Trending text might be a fan-club / 舰长 / etc. emote we can't send.
    // Bail out early so the cooldown still engages (preventing repeat
    // attempts) but no failed request hits Bilibili.
    if (isLockedEmoticon(originalText)) {
      appendLog(formatLockedEmoticonReject(originalText, '自动融入(表情)'))
      return
    }

    const isEmote = isEmoticonUnique(originalText)
    const useReplacements = autoBlendUseReplacements.value && !isEmote
    const replaced = useReplacements ? applyReplacements(originalText) : originalText
    const wasReplaced = useReplacements && originalText !== replaced

    const repeatCount = Math.max(1, autoBlendSendCount.value)
    const senderInfo = uniqueUsers > 0 ? `${uniqueUsers} 人 / ${totalCount} 条` : `${totalCount} 条`
    appendLog(`🚲 自动融入触发 (${senderInfo}): ${originalText}`)

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

  if (cleanupTimer === null) {
    cleanupTimer = setInterval(() => pruneExpired(Date.now()), 5000)
  }
}

export function stopAutoBlend(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  counters.clear()
  cooldownUntil = 0
}
