// Page protocol between a page using the SDK client and the bridge LAPLACE Chatterbox runs on that page.

/** Bump on breaking changes; each side treats a peer on another version as absent. */
export const PROTOCOL_VERSION = 1

/** Longest text one send may carry. */
export const MAX_SEND_TEXT = 500

/** `source` of every message the client posts. */
export const CLIENT_SOURCE = 'laplace-chat'

/** `source` of every message the bridge posts. */
export const BRIDGE_SOURCE = 'laplace-chatterbox'

export const SEND_STATUSES = [
  'sent',
  'partial',
  'failed',
  'disabled',
  'no-room-tab',
  'no-response',
  'not-logged-in',
  'busy',
  'invalid',
] as const

/**
 * How a send ended: `partial` = some segments rejected, `disabled` = the 允许控制台通过本脚本发送弹幕 setting is off,
 * `no-room-tab` = no open tab of that room, `no-response` = the tab went away or stopped answering.
 */
export type SendStatus = (typeof SEND_STATUSES)[number]

export interface PingMessage {
  source: typeof CLIENT_SOURCE
  type: 'ping'
}

export interface SendMessage {
  source: typeof CLIENT_SOURCE
  type: 'send'
  protocol: number
  id: string
  /** Real or short room id; the bridge matches either. */
  roomId: number
  text: string
  /** Wrap every split segment in 【】. */
  wrapBrackets: boolean
}

export type ClientMessage = PingMessage | SendMessage

export interface StatusMessage {
  source: typeof BRIDGE_SOURCE
  type: 'status'
  protocol: number
  /** Userscript version. */
  version: string
  /** The 允许控制台通过本脚本发送弹幕 setting. */
  enabled: boolean
}

export interface ProgressMessage {
  source: typeof BRIDGE_SOURCE
  type: 'progress'
  id: string
  sent: number
  /** 0 until the room tab has split the text. */
  total: number
}

export interface ResultMessage {
  source: typeof BRIDGE_SOURCE
  type: 'result'
  id: string
  status: SendStatus
  sent: number
  total: number
  /** Bilibili's reason for the first rejected segment. */
  error?: string
}

export type BridgeMessage = StatusMessage | ProgressMessage | ResultMessage

const MAX_ID = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether `value` is one of {@link SEND_STATUSES}. */
export function isSendStatus(value: unknown): value is SendStatus {
  return SEND_STATUSES.some(status => status === value)
}

/** Parse a message the client posted; null for anything else on the channel. Unknown fields are dropped. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw) || raw.source !== CLIENT_SOURCE) return null
  if (raw.type === 'ping') return { source: CLIENT_SOURCE, type: 'ping' }
  if (raw.type !== 'send') return null
  const { protocol, id, roomId, text, wrapBrackets } = raw
  if (typeof protocol !== 'number' || typeof id !== 'string' || !id || id.length > MAX_ID) return null
  if (typeof roomId !== 'number' || !Number.isSafeInteger(roomId) || roomId <= 0) return null
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SEND_TEXT || typeof wrapBrackets !== 'boolean')
    return null
  return { source: CLIENT_SOURCE, type: 'send', protocol, id, roomId, text, wrapBrackets }
}

/** Parse a message the bridge posted; null for anything else on the channel. Unknown fields are dropped. */
export function parseBridgeMessage(raw: unknown): BridgeMessage | null {
  if (!isRecord(raw) || raw.source !== BRIDGE_SOURCE) return null
  if (raw.type === 'status') {
    const { protocol, version, enabled } = raw
    if (typeof protocol !== 'number' || typeof version !== 'string' || typeof enabled !== 'boolean') return null
    return { source: BRIDGE_SOURCE, type: 'status', protocol, version, enabled }
  }
  const { id, sent, total } = raw
  if (typeof id !== 'string' || !isCount(sent) || !isCount(total)) return null
  if (raw.type === 'progress') return { source: BRIDGE_SOURCE, type: 'progress', id, sent, total }
  if (raw.type !== 'result') return null
  const { status, error } = raw
  if (!isSendStatus(status) || (error !== undefined && typeof error !== 'string')) return null
  return { source: BRIDGE_SOURCE, type: 'result', id, status, sent, total, error }
}
