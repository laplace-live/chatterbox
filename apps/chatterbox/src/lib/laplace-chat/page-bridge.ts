import {
  BRIDGE_SOURCE,
  type BridgeMessage,
  CLIENT_SOURCE,
  PROTOCOL_VERSION,
  parseClientMessage,
  type SendMessage,
  type SendStatus,
} from '@laplace.live/chatterbox-sdk'
import { effect } from '@preact/signals'

import { GM_addValueChangeListener, GM_deleteValue, GM_getValue, GM_listValues, GM_setValue, unsafeWindow } from '$'
import { laplaceChatRelayEnabled } from '../store'
import { isRecord } from '../utils'
import { VERSION } from '../version'
import {
  REQUESTS_KEY_PREFIX,
  type RelayOutcome,
  type RelayRequest,
  type RelayRequests,
  RING_KEY,
  readRoomTabState,
  STALE_STATE_MS,
  TAB_KEY_PREFIX,
} from './relay-state'

/** How long room tabs get to answer the discovery ring. */
const DISCOVERY_MS = 1500
/** How long the chosen tab gets to pick a request up. */
const ACCEPT_MS = 5000
/** An accepted request is given up on once its tab stops answering rings for this long (closed, frozen, discarded). */
const TAB_SILENCE_MS = 10_000
const POLL_MS = 200
/** Ring cadence while requests are pending: wakes a tab that missed a request and keeps every tab's `seenAt` fresh. */
const RERING_MS = 1000
const MAX_IN_FLIGHT = 10

interface Pending {
  request: RelayRequest
  accepted: boolean
  /** `at` of the last outcome seen. */
  lastAt: number
}

let bridgeId = ''
const inFlight = new Set<string>()
const pending = new Map<string, Pending>()
let pollTimer: ReturnType<typeof setInterval> | undefined
let lastRingAt = 0

function post(message: BridgeMessage): void {
  window.postMessage(message, location.origin)
}

function postStatus(): void {
  post({
    source: BRIDGE_SOURCE,
    type: 'status',
    protocol: PROTOCOL_VERSION,
    version: VERSION,
    enabled: laplaceChatRelayEnabled.value,
  })
}

function postResult(id: string, status: SendStatus, outcome?: Pick<RelayOutcome, 'sent' | 'total' | 'error'>): void {
  inFlight.delete(id)
  post({
    source: BRIDGE_SOURCE,
    type: 'result',
    id,
    status,
    sent: outcome?.sent ?? 0,
    total: outcome?.total ?? 0,
    error: outcome?.error,
  })
}

/** Wake every relay party; returns the ring time. */
function ring(): number {
  lastRingAt = Date.now()
  GM_setValue(RING_KEY, `${bridgeId}:${lastRingAt}:${Math.random()}`)
  return lastRingAt
}

function writeRequests(): void {
  const key = REQUESTS_KEY_PREFIX + bridgeId
  const requests = [...pending.values()].filter(entry => !entry.accepted).map(entry => entry.request)
  if (requests.length > 0) GM_setValue(key, { updatedAt: Date.now(), requests } satisfies RelayRequests)
  else GM_deleteValue(key)
}

/** Live tab for `roomId` that answered a ring at or after `since`, preferring a visible one, then the freshest. */
function pickRoomTab(roomId: number, since: number): string | null {
  let best: { tabId: string; visible: boolean; seenAt: number } | null = null
  for (const key of GM_listValues()) {
    if (!key.startsWith(TAB_KEY_PREFIX)) continue
    const state = readRoomTabState(GM_getValue(key))
    if (!state) continue
    if (Date.now() - state.seenAt > STALE_STATE_MS) {
      GM_deleteValue(key)
      continue
    }
    if (state.seenAt < since || !state.roomIds.includes(roomId)) continue
    const better =
      !best || (state.visible && !best.visible) || (state.visible === best.visible && state.seenAt > best.seenAt)
    if (better) best = { tabId: key.slice(TAB_KEY_PREFIX.length), visible: state.visible, seenAt: state.seenAt }
  }
  return best?.tabId ?? null
}

async function findRoomTab(roomId: number): Promise<string | null> {
  const since = ring()
  do {
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
    const tabId = pickRoomTab(roomId, since)
    if (tabId) return tabId
  } while (Date.now() - since < DISCOVERY_MS)
  return null
}

function checkPending(): void {
  const now = Date.now()
  let requestsChanged = false
  for (const [id, entry] of pending) {
    const state = readRoomTabState(GM_getValue(TAB_KEY_PREFIX + entry.request.tabId))
    const outcome = state?.outcomes[id]
    if (outcome && outcome.status !== 'accepted') {
      pending.delete(id)
      requestsChanged ||= !entry.accepted
      postResult(id, outcome.status, outcome)
      continue
    }
    if (outcome && outcome.at !== entry.lastAt) {
      requestsChanged ||= !entry.accepted
      entry.accepted = true
      entry.lastAt = outcome.at
      post({ source: BRIDGE_SOURCE, type: 'progress', id, sent: outcome.sent, total: outcome.total })
    }
    // Accepted requests may queue behind others in their tab, so only a gone or silent tab ends the wait.
    const timedOut = entry.accepted ? !state || now - state.seenAt > TAB_SILENCE_MS : now > entry.request.expiresAt
    if (timedOut) {
      pending.delete(id)
      requestsChanged ||= !entry.accepted
      postResult(id, 'no-response', outcome)
    }
  }
  if (requestsChanged) writeRequests()
  if (pending.size > 0 && now - lastRingAt >= RERING_MS) ring()
  if (pending.size === 0) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

async function handleSend(message: SendMessage): Promise<void> {
  const { id, roomId, text, wrapBrackets } = message
  if (inFlight.has(id)) return
  if (message.protocol !== PROTOCOL_VERSION) {
    postResult(id, 'invalid')
    return
  }
  if (!laplaceChatRelayEnabled.value) {
    postResult(id, 'disabled')
    return
  }
  if (inFlight.size >= MAX_IN_FLIGHT) {
    postResult(id, 'busy')
    return
  }
  inFlight.add(id)
  const tabId = await findRoomTab(roomId)
  if (!tabId) {
    postResult(id, 'no-room-tab')
    return
  }
  pending.set(id, {
    request: { id, tabId, roomId, text, wrapBrackets, expiresAt: Date.now() + ACCEPT_MS },
    accepted: false,
    lastAt: 0,
  })
  writeRequests()
  ring()
  pollTimer ??= setInterval(checkPending, POLL_MS)
}

function onMessage(event: MessageEvent): void {
  // Isolated-world managers see the page as `window`, page-context ones as `unsafeWindow`.
  if ((event.source !== window && event.source !== unsafeWindow) || event.origin !== location.origin) return
  const message = parseClientMessage(event.data)
  if (message?.type === 'ping') postStatus()
  else if (message?.type === 'send') void handleSend(message)
  // A send we can't parse still gets an answer, or the dashboard would wait out its fallback timeout.
  else if (isRecord(event.data) && event.data.source === CLIENT_SOURCE && typeof event.data.id === 'string')
    postResult(event.data.id, 'invalid')
}

/** Serve the LAPLACE Chat dashboard on its own origin: answer status pings and relay send requests to a live-room tab. */
export function startLaplaceChatBridge(): void {
  if (bridgeId) return
  bridgeId = crypto.randomUUID()
  window.addEventListener('message', onMessage)
  GM_addValueChangeListener(RING_KEY, (_key, _oldValue, _newValue, remote) => {
    if (remote && pending.size > 0) checkPending()
  })
  // Announces the bridge now and again whenever the setting flips in a room tab.
  effect(postStatus)
  window.addEventListener('pagehide', () => GM_deleteValue(REQUESTS_KEY_PREFIX + bridgeId))
}
