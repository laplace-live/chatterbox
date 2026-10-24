/** Bump on any breaking wire change; peers on another version are refused. */
export const PROTOCOL_VERSION = 1

/** Default kakashi-server port; LAPLACE Event Bridge owns 9696. */
export const DEFAULT_PORT = 9697

/** Server URL the userscript starts with. Loopback IP rather than `localhost`, which may resolve to `::1` first. */
export const DEFAULT_SERVER_URL = `ws://127.0.0.1:${DEFAULT_PORT}`

/** App-level WebSocket close codes; the client stops reconnecting on UNAUTHORIZED and PROTOCOL_MISMATCH until its settings change. */
export const CloseCode = {
  UNAUTHORIZED: 4001,
  PROTOCOL_MISMATCH: 4002,
  BAD_HELLO: 4003,
} as const

/** Master send sources; each mirror picks which ones it copies. */
export const ACTION_SOURCES = ['manual', 'loop', 'repeat', 'emote', 'meme', 'blend', 'ai', 'stt'] as const

export type ActionSource = (typeof ACTION_SOURCES)[number]

const ROLES = ['master', 'mirror'] as const

/** Role a connection claims; the server lets one master uid act at a time. */
export type Role = (typeof ROLES)[number]

const MEMBER_ROLES = [...ROLES, 'standby'] as const

/** Effective roster role; `standby` = claimed master while another master uid is online. */
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** A danmaku the master's send succeeded with. */
export interface DanmakuAction {
  kind: 'danmaku'
  /** Real (long) room id. */
  roomId: number
  /** Final sent text, after replacements and AI polish, so mirrors never re-apply them. */
  text: string
  source: ActionSource
}

export type Action = DanmakuAction

const COPY_STATUSES = ['sent', 'failed', 'dropped', 'skipped'] as const

export type CopyStatus = (typeof COPY_STATUSES)[number]

/** Tab state carried by the hello and every presence update. */
export interface Presence {
  role: Role
  roomId: number | null
  visible: boolean
  /** Whether this tab moves to the master's room when told (following on and not paused). */
  follow: boolean
}

export interface HelloMessage extends Presence {
  type: 'hello'
  protocol: number
  /** Empty when the server runs without a token. */
  token: string
  clientVersion: string
  uid: string
  uname: string
}

export interface PresenceMessage extends Presence {
  type: 'presence'
}

export interface ActionMessage {
  type: 'action'
  action: Action
}

export interface ResultMessage {
  type: 'result'
  eventId: string
  status: CopyStatus
  detail?: string
}

export type ClientMessage = HelloMessage | PresenceMessage | ActionMessage | ResultMessage

export interface Member {
  uid: string
  uname: string
  role: MemberRole
  roomIds: number[]
  tabs: number
}

export interface WelcomeMessage {
  type: 'welcome'
  serverVersion: string
  protocol: number
}

export interface RosterMessage {
  type: 'roster'
  members: Member[]
  /** Room of the master's most recently active tab. */
  masterRoomId: number | null
}

export interface ActionDeliveryMessage {
  type: 'action'
  eventId: string
  from: { uid: string; uname: string }
  action: Action
}

export interface ResultDeliveryMessage extends ResultMessage {
  uid: string
  uname: string
}

/** Sent to one following tab per mirror uid whose tabs are all outside the master's room; repeats on every hub update. */
export interface FollowMessage {
  type: 'follow'
  roomId: number
}

export interface ErrorMessage {
  type: 'error'
  message: string
}

export type ServerMessage =
  | WelcomeMessage
  | RosterMessage
  | ActionDeliveryMessage
  | ResultDeliveryMessage
  | FollowMessage
  | ErrorMessage

/** Longest `detail` a result may carry; longer frames are rejected, so clients truncate. */
export const MAX_DETAIL_LENGTH = 200

const MAX_SHORT = 64
const MAX_TOKEN = 256
const MAX_TEXT = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isShortString(value: unknown, max = MAX_SHORT): value is string {
  return typeof value === 'string' && value.length <= max
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SHORT
}

function isUid(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value)
}

function isRoomId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNullableRoomId(value: unknown): value is number | null {
  return value === null || isRoomId(value)
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some(v => v === value)
}

/** Whether `value` is one of {@link ACTION_SOURCES}. */
export function isActionSource(value: unknown): value is ActionSource {
  return isOneOf(ACTION_SOURCES, value)
}

function parseAction(value: unknown): Action | null {
  if (!isRecord(value) || value.kind !== 'danmaku') return null
  const { roomId, text, source } = value
  if (!isRoomId(roomId) || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) return null
  if (!isActionSource(source)) return null
  return { kind: 'danmaku', roomId, text, source }
}

function parseMember(value: unknown): Member | null {
  if (!isRecord(value)) return null
  const { uid, uname, role, roomIds, tabs } = value
  if (!isUid(uid) || !isShortString(uname) || !isOneOf(MEMBER_ROLES, role)) return null
  if (!Array.isArray(roomIds) || !roomIds.every(isRoomId)) return null
  if (typeof tabs !== 'number' || !Number.isSafeInteger(tabs) || tabs < 0) return null
  return { uid, uname, role, roomIds, tabs }
}

function parsePresence(raw: Record<string, unknown>): Presence | null {
  const { role, roomId, visible, follow } = raw
  if (!isOneOf(ROLES, role) || !isNullableRoomId(roomId)) return null
  if (typeof visible !== 'boolean' || typeof follow !== 'boolean') return null
  return { role, roomId, visible, follow }
}

function parseResult(raw: Record<string, unknown>): ResultMessage | null {
  const { eventId, status, detail } = raw
  if (!isId(eventId) || !isOneOf(COPY_STATUSES, status)) return null
  if (detail !== undefined && !isShortString(detail, MAX_DETAIL_LENGTH)) return null
  return { type: 'result', eventId, status, detail }
}

/** The `protocol` a hello frame claims, read before full validation so a newer client gets a version error, not a parse error. */
export function readHelloProtocol(raw: unknown): number | null {
  if (!isRecord(raw) || raw.type !== 'hello' || typeof raw.protocol !== 'number') return null
  return raw.protocol
}

/** Parse a client→server frame; null when malformed. Unknown fields are dropped. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'hello': {
      const { protocol, token, clientVersion, uid, uname } = raw
      if (typeof protocol !== 'number' || !isShortString(token, MAX_TOKEN) || !isShortString(clientVersion)) return null
      if (!isUid(uid) || !isShortString(uname)) return null
      const presence = parsePresence(raw)
      return presence ? { type: 'hello', protocol, token, clientVersion, uid, uname, ...presence } : null
    }
    case 'presence': {
      const presence = parsePresence(raw)
      return presence ? { type: 'presence', ...presence } : null
    }
    case 'action': {
      const action = parseAction(raw.action)
      return action ? { type: 'action', action } : null
    }
    case 'result':
      return parseResult(raw)
    default:
      return null
  }
}

/** Parse a server→client frame; null when malformed. Unknown fields are dropped. */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (!isRecord(raw)) return null
  switch (raw.type) {
    case 'welcome': {
      const { serverVersion, protocol } = raw
      if (!isShortString(serverVersion) || typeof protocol !== 'number') return null
      return { type: 'welcome', serverVersion, protocol }
    }
    case 'roster': {
      const { members, masterRoomId } = raw
      if (!Array.isArray(members) || !isNullableRoomId(masterRoomId)) return null
      const parsed: Member[] = []
      for (const member of members) {
        const m = parseMember(member)
        if (!m) return null
        parsed.push(m)
      }
      return { type: 'roster', members: parsed, masterRoomId }
    }
    case 'action': {
      const { eventId, from } = raw
      const action = parseAction(raw.action)
      if (!isId(eventId) || !action || !isRecord(from) || !isUid(from.uid) || !isShortString(from.uname)) return null
      return { type: 'action', eventId, from: { uid: from.uid, uname: from.uname }, action }
    }
    case 'result': {
      const result = parseResult(raw)
      const { uid, uname } = raw
      return result && isUid(uid) && isShortString(uname) ? { ...result, uid, uname } : null
    }
    case 'follow': {
      const { roomId } = raw
      return isRoomId(roomId) ? { type: 'follow', roomId } : null
    }
    case 'error': {
      const { message } = raw
      return isShortString(message, MAX_DETAIL_LENGTH) ? { type: 'error', message } : null
    }
    default:
      return null
  }
}
