import type { GmValueListenerId } from '$'

import {
  GM_addValueChangeListener,
  GM_deleteValue,
  GM_getValue,
  GM_listValues,
  GM_removeValueChangeListener,
  GM_setValue,
} from '$'
import { tryAiEvasion } from '../ai-evasion'
import { ensureRoomId, getCsrfToken } from '../api'
import { appendLog } from '../log'
import { isTabHidden } from '../page-visibility'
import { applyReplacements } from '../replacement'
import { enqueueDanmaku, SendPriority } from '../send-queue'
import { cachedRoomId, danmakuMaxUnits, laplaceChatRelayEnabled } from '../store'
import { extractRoomNumber, formatDanmakuError, processDanmakuMessages } from '../utils'
import { wrapSegment, wrapSplitUnits } from '../wrap'
import {
  isRoomId,
  REQUESTS_KEY_PREFIX,
  type RelayOutcome,
  type RelayRequest,
  RING_KEY,
  type RoomTabState,
  readRelayRequests,
  TAB_KEY_PREFIX,
} from './relay-state'

type OutcomeUpdate = Omit<RelayOutcome, 'at'>

/** How long a finished outcome stays readable by the dashboard bridge. */
const OUTCOME_TTL_MS = 10 * 60_000
const MAX_ERROR = 200
const LOG_LABEL = '控制台'

let tabId: string | null = null
let ringListener: GmValueListenerId | null = null
const outcomes = new Map<string, RelayOutcome>()
let relayChain = Promise.resolve()

function servedRoomIds(): number[] {
  return [...new Set([cachedRoomId.value, Number(extractRoomNumber(location.href))])].filter(isRoomId)
}

/** Clip a send error for the wire. */
function clipError(error: string): string {
  return error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error
}

function writeState(): void {
  if (!tabId) return
  const now = Date.now()
  for (const [id, outcome] of outcomes) {
    if (outcome.status !== 'accepted' && now - outcome.at > OUTCOME_TTL_MS) outcomes.delete(id)
  }
  GM_setValue(TAB_KEY_PREFIX + tabId, {
    roomIds: servedRoomIds(),
    visible: !isTabHidden(),
    seenAt: now,
    outcomes: Object.fromEntries(outcomes),
  } satisfies RoomTabState)
}

function ring(): void {
  if (tabId) GM_setValue(RING_KEY, `${tabId}:${Date.now()}:${Math.random()}`)
}

function report(id: string, update: OutcomeUpdate): void {
  // Strictly increasing so the bridge sees every update, even two in the same millisecond.
  const at = Math.max(Date.now(), (outcomes.get(id)?.at ?? 0) + 1)
  outcomes.set(id, { ...update, at })
  writeState()
  ring()
}

/** Send `request.text` the way 常规发送 would: replacement rules, split at the room's cap, AI evasion on rejection. */
async function relay(request: RelayRequest, requestsKey: string): Promise<OutcomeUpdate> {
  const session = tabId
  // A segment posts only while the setting is on, this relay runs, and the dashboard still lists the request:
  // it drops requests it gave up on or when it closes, so a tab that resumes late can't post a duplicate.
  const active = () =>
    session !== null &&
    tabId === session &&
    laplaceChatRelayEnabled.value &&
    !!readRelayRequests(GM_getValue(requestsKey))?.some(listed => listed.id === request.id)
  if (!active()) return { status: 'disabled', sent: 0, total: 0 }
  const csrfToken = getCsrfToken()
  if (!csrfToken) return { status: 'not-logged-in', sent: 0, total: 0 }
  const roomId = await ensureRoomId()
  if (!servedRoomIds().includes(request.roomId)) return { status: 'no-room-tab', sent: 0, total: 0 }

  const text = applyReplacements(request.text.trim()).trim()
  if (!text) return { status: 'failed', sent: 0, total: 0, error: '替换规则处理后内容为空' }
  const wrap = request.wrapBrackets
  const segments = processDanmakuMessages(text, wrapSplitUnits(danmakuMaxUnits.value, wrap)).map(segment =>
    wrapSegment(segment, wrap)
  )
  const total = segments.length
  let sent = 0
  let error: string | undefined
  for (const [i, segment] of segments.entries()) {
    report(request.id, { status: 'accepted', sent, total })
    const label = total > 1 ? `${LOG_LABEL} [${i + 1}/${total}]` : LOG_LABEL
    const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL, 'laplace-chat', active)
    appendLog(result, label, segment)
    if (result.success) {
      sent++
      continue
    }
    // Checked before evasion too, so a stopped relay never sends the segment to the audit endpoint.
    if (result.cancelled || !active()) return { status: 'disabled', sent, total }
    const evaded = await tryAiEvasion(segment, roomId, csrfToken, label, 'laplace-chat', active)
    if (evaded.cancelled) return { status: 'disabled', sent, total }
    if (evaded.success) sent++
    else error ??= clipError(formatDanmakuError(result.error))
  }
  return { status: sent === total ? 'sent' : sent > 0 ? 'partial' : 'failed', sent, total, error }
}

async function handleRequest(request: RelayRequest, requestsKey: string): Promise<void> {
  let outcome: OutcomeUpdate
  try {
    outcome = await relay(request, requestsKey)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 ${LOG_LABEL}发送出错：${message}`)
    outcome = { status: 'failed', sent: 0, total: 0, error: clipError(message) }
  }
  report(request.id, outcome)
}

function scanRequests(): void {
  const now = Date.now()
  for (const key of GM_listValues()) {
    if (!key.startsWith(REQUESTS_KEY_PREFIX)) continue
    // Only the bridge that wrote a list deletes it: aging lists out here would cancel sends a waking bridge still wants.
    // A crashed dashboard's list is left behind on purpose; its requests are all handled or expired, so it stays inert.
    for (const request of readRelayRequests(GM_getValue(key)) ?? []) {
      // Picked-up requests already have an outcome; expired ones were already reported to the dashboard as unanswered.
      if (request.tabId !== tabId || outcomes.has(request.id) || now > request.expiresAt) continue
      report(request.id, { status: 'accepted', sent: 0, total: 0 })
      // One relay at a time, so two split superchats never interleave their segments.
      relayChain = relayChain.then(() => handleRequest(request, key))
    }
  }
}

/** Leave discovery when the page goes away; a page restored from the back/forward cache rejoins on the next ring. */
function forget(): void {
  if (tabId) GM_deleteValue(TAB_KEY_PREFIX + tabId)
}

/** Offer this room tab to the LAPLACE Chat dashboard bridge: answer its rings and send what it addresses to this tab. */
export function startLaplaceChatRelay(): void {
  if (tabId) return
  tabId = crypto.randomUUID()
  outcomes.clear()
  writeState()
  ringListener = GM_addValueChangeListener(RING_KEY, (_key, _oldValue, _newValue, remote) => {
    if (!remote) return
    writeState()
    scanRequests()
  })
  window.addEventListener('pagehide', forget)
  // The real room id resolves asynchronously; until then the tab matches by the URL's room number.
  void ensureRoomId().then(writeState, () => {})
}

export function stopLaplaceChatRelay(): void {
  if (!tabId) return
  if (ringListener !== null) GM_removeValueChangeListener(ringListener)
  window.removeEventListener('pagehide', forget)
  GM_deleteValue(TAB_KEY_PREFIX + tabId)
  tabId = null
  ringListener = null
}
