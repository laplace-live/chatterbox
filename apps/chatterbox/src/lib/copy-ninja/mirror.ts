import type { ActionDeliveryMessage, CopyStatus } from '@laplace.live/kakashi-protocol'

import { getCsrfToken } from '../api'
import { isEmoticonUnique, isLockedEmoticon, isUnavailableEmoticon, looksLikeEmoticonUnique } from '../emoticon'
import { describeLlmGap, polishWithLlm } from '../llm-tasks'
import { appendLog } from '../log'
import { applyReplacements } from '../replacement'
import { enqueueDanmaku, SendPriority } from '../send-queue'
import { cachedRoomId, danmakuMaxUnits } from '../store'
import { abortableSleep, formatDanmakuError, processDanmakuMessages } from '../utils'
import { pickDelayMs, planCopy, shouldFollow } from './decisions'
import {
  copyNinjaDelayMaxSec,
  copyNinjaDelayMinSec,
  copyNinjaDropPercent,
  copyNinjaFollowRoom,
  copyNinjaKanchi,
  copyNinjaMasterRoomId,
  copyNinjaPaused,
  isCopySourceEnabled,
  SOURCE_LABELS,
} from './settings'

export type ReportResult = (eventId: string, status: CopyStatus, detail?: string) => void

/** 感知忍術 outcome: the text to send instead of the master's, or why nothing is sent. */
type Rewrite = { ok: true; text: string } | { ok: false; status: 'failed' | 'skipped'; detail: string }

interface Rewriting {
  result: Promise<Rewrite>
  /** Aborted once the copy is done with it, so an early exit stops paying for the call. */
  controller: AbortController
}

interface PendingCopy {
  msg: ActionDeliveryMessage
  plannedAt: number
  report: ReportResult
  /** Started on arrival so the LLM call overlaps the delay. */
  rewrite: Rewriting | null
}

/** A copy still unsent this long after its planned time (throttled background tab, long queue) is dropped as stale. */
const STALE_MS = 10_000
const MAX_PENDING = 20
const PAUSE_AFTER_FAILURES = 3
const FOLLOW_DELAY_MIN_SEC = 2
const FOLLOW_DELAY_MAX_SEC = 5

// Copies run one at a time in arrival order, so a master message split into segments can't be copied out of order.
const pending: PendingCopy[] = []
let draining = false
let lastPlannedAt = 0
/** Aborted and replaced by {@link cancelPendingCopies}; an aborted generation's copies never post, even from the send queue. */
let generation = new AbortController()
let consecutiveFailures = 0

let followTimer: ReturnType<typeof setTimeout> | null = null
let followTimerRoom: number | null = null

/** Apply this mirror's source filter and decay to a master action, then queue the copy after its delay. */
export function handleMirrorAction(msg: ActionDeliveryMessage, report: ReportResult): void {
  const { eventId, action } = msg
  if (copyNinjaPaused.value) {
    report(eventId, 'skipped', '分身已暂停')
    return
  }
  // Checked once: a tab's room resolves once per page and never changes.
  if (cachedRoomId.value !== action.roomId) {
    report(eventId, 'skipped', '不在同一直播间')
    return
  }
  const plan = planCopy({
    sourceEnabled: isCopySourceEnabled(action.source),
    dropPercent: copyNinjaDropPercent.value,
    delayMinSec: copyNinjaDelayMinSec.value,
    delayMaxSec: copyNinjaDelayMaxSec.value,
  })
  if (plan.kind === 'skip') {
    report(eventId, 'skipped', plan.reason)
    return
  }
  if (plan.kind === 'drop') {
    appendLog(`🍃 跟随·${SOURCE_LABELS[action.source]}：衰减忽略 ${action.text}`)
    report(eventId, 'dropped', '衰减忽略')
    return
  }
  if (pending.length >= MAX_PENDING) {
    report(eventId, 'skipped', '待发送队列已满')
    return
  }
  // Emote IDs are opaque, cached or not: a rewrite would post one as plain text.
  const kanchi = copyNinjaKanchi.value && !isEmoticonUnique(action.text) && !looksLikeEmoticonUnique(action.text)
  const gap = kanchi ? describeLlmGap('kanchi') : null
  if (gap) {
    appendLog(`⚠️ 跟随·${SOURCE_LABELS[action.source]}：感知忍術未就绪，${gap}`)
    report(eventId, 'failed', `感知忍術：${gap}`)
    return
  }
  // Never earlier than the copy before it, so random delays can't reorder copies.
  lastPlannedAt = Math.max(Date.now() + plan.delayMs, lastPlannedAt)
  const rewrite = kanchi ? startRewrite(action.text, lastPlannedAt + STALE_MS) : null
  pending.push({ msg, plannedAt: lastPlannedAt, report, rewrite })
  void drain()
}

/** Rewrite `text` with the 感知忍術 prompt; gives up at `deadline`, when the copy would be stale anyway. */
function startRewrite(text: string, deadline: number): Rewriting {
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(Math.max(0, deadline - Date.now()))
  const signal = AbortSignal.any([generation.signal, controller.signal, timeout])
  const result = polishWithLlm('kanchi', text, { signal }).then(
    (rewritten): Rewrite => {
      // The master's replacements were applied to its text, not to this fresh one.
      const replaced = applyReplacements(rewritten)
      return replaced.trim()
        ? { ok: true, text: replaced }
        : { ok: false, status: 'skipped', detail: '感知忍術返回为空' }
    },
    (err: unknown): Rewrite =>
      timeout.aborted
        ? { ok: false, status: 'skipped', detail: '感知忍術超时' }
        : { ok: false, status: 'failed', detail: `感知忍術：${err instanceof Error ? err.message : String(err)}` }
  )
  return { result, controller }
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.length > 0) {
      const next = pending[0]
      const wait = next.plannedAt - Date.now()
      if (wait > 0) await abortableSleep(wait, generation.signal)
      // A cancel while sleeping empties the queue (and may refill it for a new session).
      if (pending[0] !== next) continue
      pending.shift()
      try {
        await copyAction(next, generation.signal)
      } catch (err) {
        console.error('[LAPLACE Chatterbox] Copy Ninja copy failed:', err)
      } finally {
        next.rewrite?.controller.abort()
      }
    }
  } finally {
    draining = false
  }
}

async function copyAction({ msg: { eventId, action }, plannedAt, report, rewrite }: PendingCopy, signal: AbortSignal) {
  if (copyNinjaPaused.value) return report(eventId, 'skipped', '分身已暂停')
  if (Date.now() - plannedAt > STALE_MS) return report(eventId, 'skipped', '已过期')
  const csrfToken = getCsrfToken()
  if (!csrfToken) return report(eventId, 'failed', '未登录')

  // Re-check emotes and length against THIS account: its unlocks and length cap can differ from the master's.
  if (isUnavailableEmoticon(action.text) || isLockedEmoticon(action.text)) {
    return report(eventId, 'skipped', '该账号无法使用此表情')
  }
  const label = `跟随·${SOURCE_LABELS[action.source]}`
  let text = action.text
  if (rewrite) {
    const rewritten = await rewrite.result
    if (signal.aborted) return
    if (!rewritten.ok) {
      appendLog(`⚠️ ${label}：${rewritten.detail}，未发送 ${action.text}`)
      return report(eventId, rewritten.status, rewritten.detail)
    }
    text = rewritten.text
    appendLog(`✨ ${label} 感知忍術：${action.text} → ${text}`)
  }
  const segments = isEmoticonUnique(text) ? [text] : processDanmakuMessages(text, danmakuMaxUnits.value)
  const stillWanted = () => !signal.aborted && !copyNinjaPaused.value && Date.now() - plannedAt <= STALE_MS
  for (const segment of segments) {
    const result = await enqueueDanmaku(segment, action.roomId, csrfToken, SendPriority.COPY, 'copy', stillWanted)
    if (result.cancelled) return report(eventId, 'skipped', '已取消')
    appendLog(result, label, segment)
    if (!result.success) {
      recordFailure()
      return report(eventId, 'failed', formatDanmakuError(result.error))
    }
  }
  consecutiveFailures = 0
  report(eventId, 'sent', rewrite ? `感知忍術：${text}` : undefined)
}

function recordFailure(): void {
  consecutiveFailures++
  if (consecutiveFailures < PAUSE_AFTER_FAILURES || copyNinjaPaused.value) return
  copyNinjaPaused.value = true
  cancelPendingCopies()
  appendLog(`⏸️ 拷贝忍者：连续 ${PAUSE_AFTER_FAILURES} 次跟随失败（可能被禁言或触发风控），已暂停，可在「忍者」页恢复`)
}

/** Clear the pause and failure streak. */
export function resumeMirror(): void {
  consecutiveFailures = 0
  copyNinjaPaused.value = false
}

/** Drop queued and in-queue copies (disconnect, stop, pause). */
export function cancelPendingCopies(): void {
  generation.abort()
  generation = new AbortController()
  pending.length = 0
  lastPlannedAt = 0
}

function wantsFollow(target: number): boolean {
  return shouldFollow({
    enabled: copyNinjaFollowRoom.value,
    paused: copyNinjaPaused.value,
    target,
    masterRoomId: copyNinjaMasterRoomId.value,
    currentRoomId: cachedRoomId.value,
  })
}

/** Move to `roomId` after a short random delay; the server re-sends this on every update, so a repeat is ignored. */
export function handleFollow(roomId: number): void {
  if (!wantsFollow(roomId) || followTimerRoom === roomId) return
  cancelFollow()
  const delayMs = pickDelayMs(FOLLOW_DELAY_MIN_SEC, FOLLOW_DELAY_MAX_SEC)
  appendLog(`🥷 主控在直播间 ${roomId}，${Math.round(delayMs / 1000)} 秒后跟随`)
  followTimerRoom = roomId
  followTimer = setTimeout(() => {
    followTimer = null
    followTimerRoom = null
    // Re-checked at fire time: the master may have moved, or following may have been turned off or paused.
    if (wantsFollow(roomId)) location.assign(`https://live.bilibili.com/${roomId}`)
  }, delayMs)
}

function cancelFollow(): void {
  if (followTimer) clearTimeout(followTimer)
  followTimer = null
  followTimerRoom = null
}

/** Forget all mirror state when Copy Ninja stops. */
export function resetMirror(): void {
  cancelPendingCopies()
  cancelFollow()
}
