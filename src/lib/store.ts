import { computed, effect, signal } from '@preact/signals'

import { GM_getValue, GM_setValue } from '$'
import { type CustomChatWsStatus, subscribeCustomChatWsStatus } from './custom-chat-events'
import { appendLog } from './log'
import { memeContributorCandidatesByRoom, memeContributorSeenTextsByRoom } from './store-meme'
import { persistSendState, sendMsg } from './store-send'

export * from './store-ai-candidate'
export * from './store-auto-blend'
export * from './store-chat'
export * from './store-chatfilter'
export * from './store-guard-room'
export * from './store-hzm'
export * from './store-llm'
export * from './store-meme'
export * from './store-radar'
export * from './store-replacement'
export * from './store-send'
export * from './store-shadow-learn'
export * from './store-stt'
export * from './store-ui'

export const cachedRoomId = signal<number | null>(null)
export const cachedStreamerUid = signal<number | null>(null)

/**
 * 当前登录观众自身的 bilibili uid（来自 `DedeUserID` cookie），用于把
 * /radar/report 上的 `reporter_uid` 字段填进去。匿名访问时为 `null`，雷达上报
 * 路径在 `null` 时直接 short-circuit —— 我们不接受没有可哈希身份的观察上报，
 * 也不想给匿名访问者捎一个伪造的"reporter"。
 *
 * Cookie 不会主动触发变更事件；登录 / 登出在 B 站会刷页面，所以仅在 app 启动
 * 时读一次（见 `radar-report.ts` 的 `startRadarReportLoop`）已足够。其他 module
 * 也可以按需写入，但不要写入零或负值 —— validation 拒掉。
 */
export const cachedSelfUid = signal<number | null>(null)

/**
 * Reactive view of the live WebSocket connection state, mirrored from
 * `subscribeCustomChatWsStatus`. Lets UI surfaces (tab bar, settings) show
 * when the script has degraded to DOM-scrape mode without each component
 * needing its own subscription.
 *
 * Values: `off` (WS not started — features that need it are disabled),
 * `connecting`, `live` (healthy), `error` / `closed` (degraded — DOM
 * fallback in effect).
 */
export const liveWsStatus = signal<CustomChatWsStatus>('off')
subscribeCustomChatWsStatus(status => {
  liveWsStatus.value = status
})

// 当前直播间的候选梗（按房间隔离的派生视图）
export const memeContributorCandidates = computed<string[]>(() => {
  const id = cachedRoomId.value
  if (id === null) return []
  return memeContributorCandidatesByRoom.value[String(id)] ?? []
})

// 当前直播间的已见梗（被忽略或已贡献）
export const memeContributorSeenTexts = computed<string[]>(() => {
  const id = cachedRoomId.value
  if (id === null) return []
  return memeContributorSeenTextsByRoom.value[String(id)] ?? []
})

let sendStateRestored = false

effect(() => {
  const persist = persistSendState.value
  const roomId = cachedRoomId.value
  const sending = sendMsg.value
  if (roomId === null) return
  const key = String(roomId)
  if (persist[key]) {
    if (!sendStateRestored) {
      sendStateRestored = true
      const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
      if (stored[key]) {
        sendMsg.value = true
        appendLog('🔄 已恢复独轮车运行状态')
      }
      return
    }
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    GM_setValue('persistedSendMsg', { ...stored, [key]: sending })
  } else {
    const stored = GM_getValue<Record<string, boolean>>('persistedSendMsg', {})
    if (key in stored) {
      const { [key]: _, ...rest } = stored
      GM_setValue('persistedSendMsg', rest)
    }
  }
})
