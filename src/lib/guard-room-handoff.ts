/**
 * URL-param handoff: lets the multi-room dashboard send the user to a live
 * page with `?guard_room_source=guard-room&guard_room_mode=...&...` and have
 * chatterbox auto-arm itself accordingly (e.g. start auto-blend in
 * dry-run). Used when the user clicks a room link from the dashboard.
 *
 * (Briefly slated for spinoff under the wrong premise; staying. See
 * guard-room-sync.ts header for the retrospective.)
 */

import { guardRoomLiveDeskSessionId } from './guard-room-live-desk-state'
import { appendLog, notifyUser } from './log'
import { autoBlendDryRun, autoBlendEnabled, guardRoomHandoffActive, guardRoomSyncKey } from './store'

let applied = false

// 直播间保安室 session id 写进 GM 持久存储并随每次心跳 POST 发出去。
// 限制 charset/length, 防止恶意构造的 URL 把"<script>"、超长字符串、或非
// 可打印字符塞进持久存储和外发请求体。
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

function sanitizeSessionId(raw: string | null): string | null {
  if (!raw) return null
  return SESSION_ID_PATTERN.test(raw) ? raw : null
}

/**
 * 把 ?guard_room_* query 参数从地址栏 + history 上抹掉,这样:
 *  1. 用户刷新本页不会再次自动接管(避免无限放大同一次 handoff)
 *  2. 用户复制粘贴当前 URL 不会无意中把 session id 泄给别人
 *  3. 浏览器历史不留下接管痕迹
 * 失败(老浏览器没 history.replaceState)就静默忽略——原行为继续。
 */
function stripHandoffParams(url: URL): void {
  try {
    url.searchParams.delete('guard_room_source')
    url.searchParams.delete('guard_room_mode')
    url.searchParams.delete('guard_room_autostart')
    url.searchParams.delete('guard_room_session')
    window.history.replaceState(window.history.state, '', url.toString())
  } catch {
    // best-effort
  }
}

export function applyGuardRoomHandoff(): void {
  if (applied) return
  applied = true

  const url = new URL(window.location.href)
  if (url.searchParams.get('guard_room_source') !== 'guard-room') return
  guardRoomHandoffActive.value = true

  const mode = url.searchParams.get('guard_room_mode')
  const autostart = url.searchParams.get('guard_room_autostart') === '1'
  const sessionId = sanitizeSessionId(url.searchParams.get('guard_room_session'))

  // 仅在用户已经配置过 Guard Room 同步 key 的情况下才接受 autostart/session 改写。
  // 没配过 key 的用户 = 没用过这个功能,不会期待陌生 URL 能自动接管页面 →
  // 这种场景下任何 ?guard_room_* 链接都是攻击向量。
  const hasGuardRoomConfig = guardRoomSyncKey.value.trim().length > 0

  if (sessionId && hasGuardRoomConfig) {
    guardRoomLiveDeskSessionId.value = sessionId
  }

  if (mode === 'dry-run') {
    autoBlendDryRun.value = true
  }

  if (autostart && hasGuardRoomConfig) {
    autoBlendEnabled.value = true
    notifyUser(
      'warning',
      '直播间保安室已接管本页，自动跟车进入试运行',
      '若不是你本人发起，请关闭自动跟车并删除该链接。'
    )
    appendLog('直播间保安室：已接管本页，自动跟车进入试运行。')
  } else if (autostart) {
    appendLog('⚠️ 收到带 autostart 的接管链接，但未配置直播间保安室 key，已忽略。')
  }

  // 抹掉 URL 中的接管参数(见 stripHandoffParams)。
  stripHandoffParams(url)
}
