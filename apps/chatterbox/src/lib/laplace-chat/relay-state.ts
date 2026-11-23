// What the dashboard bridge and live-room tabs share through GM storage, the only channel across their origins.

import { isSendStatus, type SendStatus } from '@laplace.live/chatterbox-sdk'

import { isRecord } from '../utils'

/** GM keys under this prefix are transient relay state and stay out of settings backups. */
export const RELAY_KEY_PREFIX = 'laplaceChatRelay:'

/** Doorbell: any write tells every relay party to re-read the state keys, so a coalesced or reordered change event loses nothing. */
export const RING_KEY = `${RELAY_KEY_PREFIX}ring`

/** `+ tabId`: a room tab's {@link RoomTabState}, written only by that tab. */
export const TAB_KEY_PREFIX = `${RELAY_KEY_PREFIX}tab:`

/** `+ bridgeId`: a dashboard bridge's pending {@link RelayRequest}s, written only by that bridge. */
export const REQUESTS_KEY_PREFIX = `${RELAY_KEY_PREFIX}requests:`

/** State keys untouched for this long belong to tabs that died without cleaning up. */
export const STALE_STATE_MS = 60 * 60_000

export interface RelayRequest {
  id: string
  /** The one room tab that may act on it, so two tabs on the same room never both send. */
  tabId: string
  roomId: number
  text: string
  wrapBrackets: boolean
  /** Epoch ms after which the tab must not pick the request up. */
  expiresAt: number
}

export interface RelayOutcome {
  /** `accepted` while queued or sending; `sent` / `total` carry progress until a final status lands. */
  status: SendStatus | 'accepted'
  sent: number
  total: number
  error?: string
  /** Epoch ms of the last update. */
  at: number
}

export interface RoomTabState {
  /** Real room id and the URL's room number (short id), deduped. */
  roomIds: number[]
  visible: boolean
  /** Epoch ms of the last write; tabs rewrite on every ring, so a fresh one proves the tab is alive. */
  seenAt: number
  outcomes: Record<string, RelayOutcome>
}

export function isRoomId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseOutcome(raw: unknown): RelayOutcome | null {
  if (!isRecord(raw)) return null
  const { status, sent, total, error, at } = raw
  if (status !== 'accepted' && !isSendStatus(status)) return null
  if (!isCount(sent) || !isCount(total) || !isCount(at)) return null
  if (error !== undefined && typeof error !== 'string') return null
  return { status, sent, total, error, at }
}

/** Read a room tab's GM state; null when missing or malformed (e.g. written by an incompatible version). */
export function readRoomTabState(raw: unknown): RoomTabState | null {
  if (!isRecord(raw)) return null
  const { roomIds, visible, seenAt, outcomes } = raw
  if (!Array.isArray(roomIds) || !roomIds.every(isRoomId)) return null
  if (typeof visible !== 'boolean' || !isCount(seenAt) || !isRecord(outcomes)) return null
  const parsed: Record<string, RelayOutcome> = {}
  for (const [id, value] of Object.entries(outcomes)) {
    const outcome = parseOutcome(value)
    if (outcome) parsed[id] = outcome
  }
  return { roomIds, visible, seenAt, outcomes: parsed }
}

function parseRequest(raw: unknown): RelayRequest | null {
  if (!isRecord(raw)) return null
  const { id, tabId, roomId, text, wrapBrackets, expiresAt } = raw
  if (typeof id !== 'string' || typeof tabId !== 'string' || !isRoomId(roomId) || !isCount(expiresAt)) return null
  if (typeof text !== 'string' || typeof wrapBrackets !== 'boolean') return null
  return { id, tabId, roomId, text, wrapBrackets, expiresAt }
}

/** Read a bridge's pending requests; null when missing or malformed. */
export function readRelayRequests(raw: unknown): RelayRequest[] | null {
  if (!Array.isArray(raw)) return null
  const requests: RelayRequest[] = []
  for (const value of raw) {
    const request = parseRequest(value)
    if (request) requests.push(request)
  }
  return requests
}
