/**
 * Global send queue serializing all outbound danmaku against Bilibili's
 * per-account rate limit: one POST in flight; manual actions cancel pending
 * AUTO items but only reorder STT; the in-flight send is never cancelled.
 */

import type { ActionSource } from '@laplace.live/kakashi-protocol'

import { type SendDanmakuResult, sendDanmaku } from './api'

/** Higher number = higher priority. Manual user actions jump ahead of automation. */
export const SendPriority = {
  AUTO: 0,
  STT: 1,
  /** Copy Ninja mirror copies; like STT, reorders ahead of AUTO but is never cancelled. */
  COPY: 1,
  MANUAL: 2,
} as const

export type SendPriority = (typeof SendPriority)[keyof typeof SendPriority]

/** Feature that produced a send; `copy` = a Copy Ninja mirror copy, which is never re-broadcast. */
export type SendSource = ActionSource | 'copy'

/** A send Bilibili accepted. */
export interface SentDanmaku {
  message: string
  roomId: number
  source: SendSource
}

interface QueueItem {
  message: string
  roomId: number
  csrfToken: string
  priority: SendPriority
  source: SendSource
  guard?: () => boolean
  resolve: (result: SendDanmakuResult) => void
  reject: (err: unknown) => void
  cancelled: boolean
}

/** Floor gap between sends: Bilibili enforces ~1s/account, +10ms safety. Features may pace slower on top. */
const HARD_MIN_GAP_MS = 1010

const queue: QueueItem[] = []
let processing = false
let lastSendCompletedAt = 0
const sentListeners = new Set<(sent: SentDanmaku) => void>()

/** Subscribe to accepted sends (Copy Ninja broadcasts from here); returns the unsubscribe. */
export function onDanmakuSent(listener: (sent: SentDanmaku) => void): () => void {
  sentListeners.add(listener)
  return () => sentListeners.delete(listener)
}

function cancelledResult(item: QueueItem, error: 'cancelled' | 'preempted'): SendDanmakuResult {
  return { success: false, cancelled: true, message: item.message, isEmoticon: false, error }
}

function notifySent(item: QueueItem): void {
  const sent: SentDanmaku = { message: item.message, roomId: item.roomId, source: item.source }
  for (const listener of sentListeners) {
    try {
      listener(sent)
    } catch (err) {
      console.error('[LAPLACE Chatterbox] onDanmakuSent listener failed:', err)
    }
  }
}

/** Insert after all items with priority >= its own (FIFO within a level, highest level first). */
function insertByPriority(item: QueueItem): void {
  let i = queue.length
  while (i > 0 && queue[i - 1].priority < item.priority) i--
  queue.splice(i, 0, item)
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true
  try {
    while (queue.length > 0) {
      if (lastSendCompletedAt > 0) {
        const sinceLast = Date.now() - lastSendCompletedAt
        if (sinceLast < HARD_MIN_GAP_MS) {
          await new Promise(r => setTimeout(r, HARD_MIN_GAP_MS - sinceLast))
        }
      }
      // Picked after the wait so a manual send arriving during it still preempts or jumps ahead.
      while (queue.length > 0 && queue[0].cancelled) queue.shift()
      const item = queue.shift()
      if (!item) break

      if (item.guard) {
        let allowed: boolean
        try {
          allowed = item.guard()
        } catch (err) {
          item.reject(err)
          continue
        }
        if (!allowed) {
          item.resolve(cancelledResult(item, 'cancelled'))
          continue
        }
      }
      try {
        const result = await sendDanmaku(item.message, item.roomId, item.csrfToken)
        lastSendCompletedAt = Date.now()
        if (result.success) notifySent(item)
        item.resolve(result)
      } catch (err) {
        lastSendCompletedAt = Date.now()
        item.reject(err)
      }
    }
  } finally {
    processing = false
  }
}

/**
 * Enqueue a danmaku send; resolves with the same {@link SendDanmakuResult} as raw {@link sendDanmaku}.
 * A preempted item (only AUTO, only by MANUAL) resolves with `cancelled: true` rather than a fake send.
 * @param guard Runs right before the POST, after any wait in the queue; `false` resolves `cancelled: true` unsent.
 */
export function enqueueDanmaku(
  message: string,
  roomId: number,
  csrfToken: string,
  priority: SendPriority,
  source: SendSource,
  guard?: () => boolean
): Promise<SendDanmakuResult> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = { message, roomId, csrfToken, priority, source, guard, resolve, reject, cancelled: false }
    insertByPriority(item)

    if (priority === SendPriority.MANUAL) {
      for (const q of queue) {
        if (q !== item && !q.cancelled && q.priority === SendPriority.AUTO) {
          q.cancelled = true
          q.resolve(cancelledResult(q, 'preempted'))
        }
      }
    }

    void processQueue()
  })
}

/** Number of pending (non-cancelled) items. */
export function getQueueDepth(): number {
  return queue.reduce((n, q) => (q.cancelled ? n : n + 1), 0)
}
