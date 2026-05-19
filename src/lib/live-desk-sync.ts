/**
 * Live-desk heartbeat loop: every N seconds, snapshot the current room's
 * activity (message count, unique uids, risk level) and POST to the
 * multi-room dashboard so other devices / tabs can see room state at a
 * glance. Restarts heartbeat with the new interval when the user changes
 * the cadence signal.
 *
 * (Briefly slated for spinoff under the wrong premise; staying. See
 * guard-room-sync.ts header for the retrospective.)
 */

import { ensureRoomId } from './api'
import { subscribeCustomChatEvents } from './custom-chat-events'
import {
  guardRoomCurrentRiskLevel,
  guardRoomLiveDeskHeartbeatSec,
  guardRoomLiveDeskSessionId,
  guardRoomWatchlistRooms,
} from './guard-room-live-desk-state'
import { syncGuardRoomLiveDeskHeartbeat } from './guard-room-sync'
import { appendLogQuiet } from './log'
import { autoBlendCandidateText, guardRoomEndpoint, guardRoomSyncKey } from './store'

interface SeenEvent {
  ts: number
  uid: string | null
}

const WINDOW_MS = 60 * 1000
// 自重排程的 timeout 而不是固定 setInterval:每 tick 重新读取
// guardRoomLiveDeskHeartbeatSec.value,这样用户改设置后下一次心跳就用新
// 间隔——之前的 setInterval 把启动时的值锁死,改 setting 要 stop+start 才生效。
let timer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
const seen: SeenEvent[] = []
// Epoch token:tick 跨 await 时,如果 stop 后立刻 start,旧的 in-flight
// uploadSnapshot 完成时不应被当作"新一代"心跳的回调使用。
let cycleEpoch = 0

function trimSeen(now: number): void {
  while (seen.length > 0 && now - seen[0].ts > WINDOW_MS) seen.shift()
}

async function uploadSnapshot(): Promise<void> {
  const sessionId = guardRoomLiveDeskSessionId.value.trim()
  if (!sessionId || !guardRoomEndpoint.value.trim() || !guardRoomSyncKey.value.trim()) return

  const roomId = await ensureRoomId()
  const rooms = guardRoomWatchlistRooms.value
  const current = rooms.find(item => item.roomId === roomId)
  const now = Date.now()
  trimSeen(now)
  const uniqueUsers = new Set(seen.map(item => item.uid).filter(Boolean))
  const candidateText = autoBlendCandidateText.value !== '暂无' ? autoBlendCandidateText.value : undefined

  await syncGuardRoomLiveDeskHeartbeat({
    sessionId,
    roomId,
    anchorName: current?.anchorName ?? `直播间 ${roomId}`,
    medalName: current?.medalName ?? '粉丝牌',
    liveStatus: 'live',
    sampledAt: new Date(now).toISOString(),
    messageCount: seen.length,
    activeUsersEstimate: uniqueUsers.size,
    candidateText,
    riskLevel: guardRoomCurrentRiskLevel.value,
  })
}

function scheduleNext(epoch: number): void {
  if (epoch !== cycleEpoch) return
  // 读取 *当前* signal 值,所以用户改 heartbeat sec 后下一 tick 即生效。
  const delayMs = Math.max(10, guardRoomLiveDeskHeartbeatSec.value) * 1000
  timer = setTimeout(() => {
    if (epoch !== cycleEpoch) return
    // void: 失败由 syncGuardRoomLiveDeskHeartbeat 内部已有的 dedup'd
    // notifyUser/warn 路径处理;ensureRoomId rejection 走 .catch 留 trace。
    uploadSnapshot()
      .catch(err => {
        appendLogQuiet(`⚠️ 直播间保安室 heartbeat 上传失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => scheduleNext(epoch))
  }, delayMs)
}

export function startLiveDeskSync(): void {
  if (timer || unsubscribe) return
  const epoch = ++cycleEpoch

  unsubscribe = subscribeCustomChatEvents(event => {
    if (event.kind !== 'danmaku') return
    const now = Date.now()
    seen.push({ ts: now, uid: event.uid })
    trimSeen(now)
  })

  // 立刻发一次,接着按当前 signal 值排下一次。
  uploadSnapshot()
    .catch(err => {
      appendLogQuiet(`⚠️ 直播间保安室 heartbeat 启动上传失败：${err instanceof Error ? err.message : String(err)}`)
    })
    .finally(() => scheduleNext(epoch))
}

export function stopLiveDeskSync(): void {
  // 推进 epoch 让所有 in-flight 的 scheduleNext / .finally 都失效。
  cycleEpoch++
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  unsubscribe?.()
  unsubscribe = null
  seen.splice(0, seen.length)
}
