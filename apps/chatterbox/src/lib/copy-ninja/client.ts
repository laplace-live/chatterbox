import type { ClientMessage, CopyStatus, Presence, ServerMessage } from '@laplace.live/kakashi-protocol'
import { CloseCode, MAX_DETAIL_LENGTH, PROTOCOL_VERSION, parseServerMessage } from '@laplace.live/kakashi-protocol'
import { effect, signal } from '@preact/signals'

import { fetchSelfUname, getDedeUid } from '../api'
import { appendLog } from '../log'
import { isTabHidden } from '../page-visibility'
import { onDanmakuSent } from '../send-queue'
import { cachedRoomId } from '../store'
import { VERSION } from '../version'
import { cancelPendingCopies, handleFollow, handleMirrorAction, resetMirror } from './mirror'
import {
  copyNinjaClaimedRole,
  copyNinjaEffectiveRole,
  copyNinjaFollowRoom,
  copyNinjaKnownUids,
  copyNinjaMasterRoomId,
  copyNinjaPaused,
  copyNinjaResults,
  copyNinjaRoster,
  copyNinjaSelfUid,
  copyNinjaServerUrl,
  copyNinjaServerVersion,
  copyNinjaStatus,
  copyNinjaStatusDetail,
  copyNinjaToken,
  rememberMembers,
} from './settings'

const RETRY_MIN_MS = 1000
const RETRY_MAX_MS = 30_000

const pageVisible = signal(!isTabHidden())

let session = 0
let socket: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelayMs = RETRY_MIN_MS
let disposers: (() => void)[] = []

function presence(): Presence {
  return {
    role: copyNinjaClaimedRole.value,
    roomId: cachedRoomId.value,
    visible: pageVisible.value,
    // A paused mirror reports off, so resuming makes the server send the follow again.
    follow: copyNinjaFollowRoom.value && !copyNinjaPaused.value,
  }
}

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function reportResult(eventId: string, status: CopyStatus, detail?: string): void {
  send({ type: 'result', eventId, status, detail: detail?.slice(0, MAX_DETAIL_LENGTH) })
}

function handleMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'welcome':
      copyNinjaStatus.value = 'connected'
      copyNinjaStatusDetail.value = ''
      copyNinjaServerVersion.value = msg.serverVersion
      retryDelayMs = RETRY_MIN_MS
      appendLog(`🥷 拷贝忍者：已连接 kakashi-server v${msg.serverVersion}`)
      break
    case 'roster':
      copyNinjaRoster.value = msg.members
      copyNinjaMasterRoomId.value = msg.masterRoomId
      rememberMembers(msg.members)
      break
    case 'action':
      if (copyNinjaEffectiveRole.value === 'mirror') handleMirrorAction(msg, reportResult)
      else reportResult(msg.eventId, 'skipped', '该账号不是分身')
      break
    case 'result':
      copyNinjaResults.value = {
        ...copyNinjaResults.value,
        [msg.uid]: { status: msg.status, detail: msg.detail },
      }
      if (msg.status === 'failed') appendLog(`🥷 分身 ${msg.uname} 跟随失败：${msg.detail ?? '未知原因'}`)
      break
    case 'follow':
      handleFollow(msg.roomId)
      break
    case 'error':
      appendLog(`🥷 拷贝忍者：${msg.message}`)
      break
  }
}

/** Why a close is fatal (no retry until settings change), or null to keep retrying. */
function fatalCloseReason(code: number): string | null {
  if (code === CloseCode.UNAUTHORIZED) return '令牌错误，请检查令牌设置'
  if (code === CloseCode.PROTOCOL_MISMATCH) return '脚本与 kakashi-server 版本不兼容，请更新两者到最新版'
  return null
}

function connect(id: number, uid: string, uname: string): void {
  if (id !== session) return
  let ws: WebSocket
  try {
    ws = new WebSocket(copyNinjaServerUrl.value)
  } catch (err) {
    copyNinjaStatus.value = 'error'
    copyNinjaStatusDetail.value = `服务器地址无效：${err instanceof Error ? err.message : String(err)}`
    return
  }
  socket = ws
  copyNinjaStatus.value = 'connecting'

  ws.addEventListener('open', () => {
    send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      token: copyNinjaToken.value,
      clientVersion: VERSION,
      uid,
      uname,
      ...presence(),
    })
  })
  ws.addEventListener('message', e => {
    if (typeof e.data !== 'string') return
    let json: unknown
    try {
      json = JSON.parse(e.data)
    } catch {
      return
    }
    const msg = parseServerMessage(json)
    if (msg) handleMessage(msg)
  })
  ws.addEventListener('close', e => {
    if (socket !== ws) return
    socket = null
    copyNinjaRoster.value = []
    copyNinjaMasterRoomId.value = null
    cancelPendingCopies()
    const fatal = fatalCloseReason(e.code)
    if (fatal) {
      copyNinjaStatus.value = 'error'
      copyNinjaStatusDetail.value = fatal
      appendLog(`🥷 拷贝忍者：${fatal}`)
      return
    }
    if (copyNinjaStatus.value === 'connected') appendLog('🥷 拷贝忍者：与 kakashi-server 断开，正在重连…')
    copyNinjaStatus.value = 'connecting'
    copyNinjaStatusDetail.value =
      '连不上 kakashi-server：请确认它已在本机运行；Chrome 若拒绝过「本地网络访问」权限，需在站点设置中允许后刷新'
    retryTimer = setTimeout(() => connect(id, uid, uname), retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS)
  })
}

/** Connect this tab to kakashi-server; calling it again restarts the connection (e.g. after URL/token edits). */
export function startCopyNinja(): void {
  stopCopyNinja()
  const id = ++session
  const uid = getDedeUid()
  if (!uid) {
    copyNinjaStatus.value = 'error'
    copyNinjaStatusDetail.value = '未登录 Bilibili，登录后刷新页面'
    return
  }
  copyNinjaSelfUid.value = uid
  copyNinjaStatus.value = 'connecting'

  const onVisibility = () => {
    pageVisible.value = !isTabHidden()
  }
  document.addEventListener('visibilitychange', onVisibility)
  disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))

  disposers.push(effect(() => send({ type: 'presence', ...presence() })))

  // A pause synced from another tab of this account must stop this tab's queue and rewrites too.
  disposers.push(
    effect(() => {
      if (copyNinjaPaused.value) cancelPendingCopies()
    })
  )

  disposers.push(
    onDanmakuSent(sent => {
      if (sent.source === 'copy' || copyNinjaEffectiveRole.value !== 'master') return
      send({
        type: 'action',
        action: { kind: 'danmaku', roomId: sent.roomId, text: sent.message, source: sent.source },
      })
    })
  )

  void fetchSelfUname().then(name => connect(id, uid, name ?? uid))
}

export function stopCopyNinja(): void {
  session++
  for (const dispose of disposers) dispose()
  disposers = []
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  retryDelayMs = RETRY_MIN_MS
  const ws = socket
  socket = null
  ws?.close(1000)
  resetMirror()
  copyNinjaRoster.value = []
  copyNinjaMasterRoomId.value = null
  copyNinjaKnownUids.value = new Set()
  copyNinjaResults.value = {}
  copyNinjaStatus.value = 'off'
  copyNinjaStatusDetail.value = ''
}
