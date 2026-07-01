/**
 * Global send queue serializing all outbound danmaku against Bilibili's
 * per-account rate limit: one POST in flight; manual actions cancel pending
 * AUTO items but only reorder STT; the in-flight send is never cancelled.
 */

import { type SendDanmakuResult, sendDanmaku } from './api'

/** Higher number = higher priority. Manual user actions jump ahead of automation. */
export const SendPriority = {
  AUTO: 0,
  STT: 1,
  MANUAL: 2,
} as const

export type SendPriority = (typeof SendPriority)[keyof typeof SendPriority]

interface QueueItem {
  message: string
  roomId: number
  csrfToken: string
  priority: SendPriority
  resolve: (result: SendDanmakuResult) => void
  reject: (err: unknown) => void
  cancelled: boolean
}

/** Floor gap between sends: Bilibili enforces ~1s/account, +10ms safety. Features may pace slower on top. */
const HARD_MIN_GAP_MS = 1010

const queue: QueueItem[] = []
let processing = false
let lastSendCompletedAt = 0

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
      while (queue.length > 0 && queue[0].cancelled) queue.shift()
      const item = queue.shift()
      if (!item) break

      if (lastSendCompletedAt > 0) {
        const sinceLast = Date.now() - lastSendCompletedAt
        if (sinceLast < HARD_MIN_GAP_MS) {
          await new Promise(r => setTimeout(r, HARD_MIN_GAP_MS - sinceLast))
        }
      }
      try {
        const result = await sendDanmaku(item.message, item.roomId, item.csrfToken)
        lastSendCompletedAt = Date.now()
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
 */
export function enqueueDanmaku(
  message: string,
  roomId: number,
  csrfToken: string,
  priority: SendPriority = SendPriority.AUTO
): Promise<SendDanmakuResult> {
  return new Promise((resolve, reject) => {
    const item: QueueItem = { message, roomId, csrfToken, priority, resolve, reject, cancelled: false }
    insertByPriority(item)

    if (priority === SendPriority.MANUAL) {
      for (const q of queue) {
        if (q !== item && !q.cancelled && q.priority === SendPriority.AUTO) {
          q.cancelled = true
          q.resolve({
            success: false,
            cancelled: true,
            message: q.message,
            isEmoticon: false,
            error: 'preempted',
          })
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
