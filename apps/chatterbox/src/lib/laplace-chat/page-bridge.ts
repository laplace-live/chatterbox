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
/** An accepted request is given up on once its tab leaves this many rings in a row unanswered (closed, frozen, discarded). */
const SILENT_RINGS = 10
const POLL_MS = 200
/** Ring cadence while requests are pending: wakes a tab that missed a request and keeps every tab's `seenAt` fresh. */
const RERING_MS = 1000
const MAX_IN_FLIGHT = 10

interface Pending {
  request: RelayRequest
  accepted: boolean
  /** `at` of the last outcome seen. */
  lastAt: number
  /** The tab's `seenAt` when it last answered, and the rings since. */
  seenAt: number
  unanswered: number
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

/** Every request stays listed until settled: room tabs post a segment only while its request is still listed. */
function writeRequests(): void {
  const key = REQUESTS_KEY_PREFIX + bridgeId
  const requests = [...pending.values()].map(entry => entry.request)
  if (requests.length > 0) GM_setValue(key, { updatedAt: Date.now(), requests } satisfies RelayRequests)
  else GM_deleteValue(key)
}

/** Live tab for `roomId` that answered a ring at or after `since`, preferring a visible one, then the freshest. */
function pickRoomTab(roomId: number, since: number): string | null {
  // A tab still sending this room's earlier requests keeps the room, so the relays share one send queue.
  const busyTabId = [...pending.values()].find(entry => entry.request.roomId === roomId)?.request.tabId
  let best: { tabId: string; visible: boolean; seenAt: number } | null = null
  for (const key of GM_listValues()) {
    if (!key.startsWith(TAB_KEY_PREFIX)) continue
    const state = readRoomTabState(GM_getValue(key))
    if (!state || state.seenAt < since || !state.roomIds.includes(roomId)) continue
    if (key.slice(TAB_KEY_PREFIX.length) === busyTabId) return busyTabId
    const better =
      !best || (state.visible && !best.visible) || (state.visible === best.visible && state.seenAt > best.seenAt)
    if (better) best = { tabId: key.slice(TAB_KEY_PREFIX.length), visible: state.visible, seenAt: state.seenAt }
  }
  return best?.tabId ?? null
}

async function findRoomTab(roomId: number): Promise<string | null> {
  // Before the ring, so a live tab's answer always lands after the delete instead of being wiped by it.
  for (const key of GM_listValues()) {
    if (!key.startsWith(TAB_KEY_PREFIX)) continue
    const state = readRoomTabState(GM_getValue(key))
    if (state && Date.now() - state.seenAt > STALE_STATE_MS) GM_deleteValue(key)
  }
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
  const ringDue = now - lastRingAt >= RERING_MS
  let requestsChanged = false
  for (const [id, entry] of pending) {
    const state = readRoomTabState(GM_getValue(TAB_KEY_PREFIX + entry.request.tabId))
    if (state && state.seenAt !== entry.seenAt) {
      entry.seenAt = state.seenAt
      entry.unanswered = 0
    }
    const outcome = state?.outcomes[id]
    if (outcome && outcome.status !== 'accepted') {
      pending.delete(id)
      requestsChanged = true
      postResult(id, outcome.status, outcome)
      continue
    }
    // Re-posted on every ring so a send queued behind others never trips the SDK's silence timeout.
    if (outcome && (outcome.at !== entry.lastAt || ringDue)) {
      entry.accepted = true
      entry.lastAt = outcome.at
      post({ source: BRIDGE_SOURCE, type: 'progress', id, sent: outcome.sent, total: outcome.total })
    }
    // Silence counts unanswered rings, not time, so a dashboard whose timers paused (throttling, sleep) can't misjudge
    // a live tab. Unaccepted requests get one extra ring of grace: a pickup just before `expiresAt` may still be landing.
    const timedOut = entry.accepted ? entry.unanswered > SILENT_RINGS : now > entry.request.expiresAt + RERING_MS
    if (timedOut) {
      pending.delete(id)
      requestsChanged = true
      postResult(id, 'no-response', outcome)
    }
  }
  if (requestsChanged) writeRequests()
  if (pending.size > 0 && ringDue) {
    for (const entry of pending.values()) entry.unanswered++
    ring()
  }
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
    seenAt: 0,
    unanswered: 0,
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
