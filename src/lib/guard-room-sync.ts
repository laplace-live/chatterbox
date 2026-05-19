/**
 * Low-level sync client for the multi-room observation dashboard
 * (`bilibili-guard-room.vercel.app`). Posts inspection summaries, shadow
 * rule shares, and live-desk heartbeats. HTTPS-only except loopback.
 *
 * **HISTORICAL NOTE (2026-05-18, reversed)**: a previous Jobs-style audit
 * (#9) and the corresponding `docs/guard-room-spinoff-plan.md` mis-framed
 * this module as a "guild administrator tool" and queued it for spin-off
 * to a separate userscript. That was wrong: the actual target user is a
 * heavy-active viewer who watches multiple live rooms simultaneously and
 * hops between them — the SAME core user chatterbox is built for. The
 * spin-off has been reverted; see the DECISION REVERSED banner at the top
 * of the spinoff-plan doc for details. **This module stays.**
 *
 * The user-facing terminology ("保安室" / "监控室代理") is **deliberately**
 * a concrete metaphor (an old guy sitting in a security guard's room
 * watching multiple monitors and switching attention between them — which
 * is exactly what a multi-room viewer does). Don't flatten these to a
 * generic "multi-room dashboard" — vivid wins over functional, see the
 * Apple-style precedent (Finder vs File Manager etc.) noted in CLAUDE.md.
 */

import { VERSION } from './const'
import { guardRoomCurrentRiskLevel } from './guard-room-live-desk-state'
import { notifyUser } from './log'
import { describeRestrictionDuration, isAccountRestrictedError, isMutedError, isRateLimitError } from './moderation'
import { guardRoomEndpoint, guardRoomSyncKey } from './store'

/**
 * Per-session set of `${endpoint}::${kind}` pairs that have already surfaced
 * a warning toast. Heartbeats and risk events fire frequently — without
 * dedup, a single network outage would spam the user.
 */
const warnedSyncFailures = new Set<string>()

function warnGuardRoomSyncFailureOnce(endpoint: string, kind: string, detail: string): void {
  const key = `${endpoint}::${kind}`
  if (warnedSyncFailures.has(key)) return
  warnedSyncFailures.add(key)
  notifyUser('warning', `Guard Room ${kind} 同步失败`, detail)
}

/** Test-only: reset the per-session dedup set. */
export function _resetGuardRoomSyncWarnings(): void {
  warnedSyncFailures.clear()
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 默认 8 秒超时:Guard Room 端点是用户自配的,可能指向任意主机。任何 sync
 * 路径(risk-event / heartbeat / shadow-rule / watchlist / control-profile)
 * 都不应阻塞调用方更久,否则:
 *   - 心跳循环会把后续心跳堆在 microtask 队列,看起来"卡死"
 *   - shadow-learn 一次性 fire N 个 POST,一旦端点慢就拖垮整批
 *   - guard-room-agent 的 tick 路径会被外面延后调度
 * 已设默认即可,业务侧无需感知。
 */
const GUARD_ROOM_FETCH_TIMEOUT_MS = 8000

async function fetchGuardRoom(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), GUARD_ROOM_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(t)
  }
}

type RiskEventKind =
  | 'send_failed'
  | 'rate_limited'
  | 'muted'
  | 'account_restricted'
  | 'login_missing'
  | 'queue_cancelled'
  | 'unknown'

type RiskEventSource = 'manual' | 'auto-send' | 'auto-blend' | 'stt' | 'ai-evasion' | 'system'
type RiskEventLevel = 'stop' | 'observe' | 'pass'
type WatchlistSource = 'medal' | 'follow' | 'both'

export interface GuardRoomWatchlistRoomInput {
  roomId: number
  anchorName: string
  anchorUid?: number | null
  medalName?: string | null
  source: WatchlistSource
  liveStatus: 'live' | 'offline' | 'unknown'
}

export interface GuardRoomControlProfile {
  dryRunDefault: boolean
  autoBlendEnabled: boolean
  heartbeatSec: number
  dwellSec: number
  hotMessageThreshold: number
  hotActiveUsersThreshold: number
  recommendationThreshold: number
  conservativeMode: 'safe' | 'normal' | 'hot'
  updatedAt?: string
}

export interface GuardRoomControlProfileResponse {
  profile: GuardRoomControlProfile
  session: { id: string; status: 'active' | 'closed'; updatedAt: string } | null
  watchlist: GuardRoomWatchlistRoomInput[]
}

interface RiskEventInput {
  kind: RiskEventKind
  source: RiskEventSource
  level: RiskEventLevel
  roomId?: number | null
  errorCode?: number | null
  reason?: string
  advice?: string
}

export interface LiveDeskHeartbeatInput {
  sessionId: string
  roomId: number
  anchorName: string
  medalName: string
  liveStatus: 'live' | 'offline' | 'unknown'
  sampledAt: string
  messageCount: number
  activeUsersEstimate: number
  candidateText?: string
  riskLevel: RiskEventLevel
}

/**
 * Returns a normalized endpoint (trailing slashes stripped) only if it's a
 * usable URL. Rejects:
 *  - non-http(s) schemes (e.g. `javascript:`, `file:`, `data:`)
 *  - `http://` for any host other than localhost / loopback
 *
 * The watchlist payload includes the user's medal/follow list and the sync
 * key, so we don't want a typo in settings to send those to a plaintext or
 * unexpected origin.
 */
export function normalizeGuardRoomEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname
    // IPv6 hostnames come back wrapped in `[…]`, e.g. "[::1]" — strip
    // brackets before comparison.
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    const isLoopback = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
    if (!isLoopback) return ''
  }
  return trimmed
}

export function classifyRiskEvent(
  error?: string,
  errorData?: unknown
): Pick<RiskEventInput, 'kind' | 'level' | 'advice'> {
  if (isMutedError(error)) {
    return {
      kind: 'muted',
      level: 'stop',
      advice: `检测到房间禁言，先停车。禁言时长：${describeRestrictionDuration(error, errorData)}。`,
    }
  }
  if (isAccountRestrictedError(error)) {
    return {
      kind: 'account_restricted',
      level: 'stop',
      advice: `检测到账号级风控，先停发。限制时长：${describeRestrictionDuration(error, errorData)}。`,
    }
  }
  if (isRateLimitError(error)) {
    return { kind: 'rate_limited', level: 'observe', advice: '发送频率过快，先降频或暂停自动跟车。' }
  }
  return { kind: 'send_failed', level: 'observe', advice: '发送失败，建议看一眼房间状态和替换词。' }
}

export async function syncGuardRoomRiskEvent(input: RiskEventInput): Promise<void> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return
  guardRoomCurrentRiskLevel.value = input.level

  const payload = {
    eventId: `risk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scriptVersion: VERSION,
    occurredAt: new Date().toISOString(),
    ...input,
    reason: input.reason?.slice(0, 500),
    advice: input.advice?.slice(0, 500),
  }

  try {
    const response = await fetchGuardRoom(`${endpoint}/api/risk-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': syncKey,
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) warnGuardRoomSyncFailureOnce(endpoint, 'risk-events', `HTTP ${response.status}`)
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'risk-events', describeFetchError(err))
  }
}

export async function createGuardRoomLiveDeskSession(name = '老大爷值班台'): Promise<{ id: string } | null> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return null

  let response: Response | null = null
  try {
    response = await fetchGuardRoom(`${endpoint}/api/live-desk/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': syncKey,
      },
      body: JSON.stringify({ name }),
    })
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'live-desk-session', describeFetchError(err))
    return null
  }

  if (!response.ok) {
    warnGuardRoomSyncFailureOnce(endpoint, 'live-desk-session', `HTTP ${response.status}`)
    return null
  }
  return (await response.json()) as { id: string }
}

export async function syncGuardRoomLiveDeskHeartbeat(input: LiveDeskHeartbeatInput): Promise<void> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return

  try {
    const response = await fetchGuardRoom(`${endpoint}/api/live-desk/heartbeats`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': syncKey,
      },
      body: JSON.stringify({
        ...input,
        scriptVersion: VERSION,
        candidateText: input.candidateText?.slice(0, 120),
      }),
    })
    if (!response.ok) warnGuardRoomSyncFailureOnce(endpoint, 'heartbeat', `HTTP ${response.status}`)
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'heartbeat', describeFetchError(err))
  }
}

export interface ShadowRuleSyncInput {
  roomId: number
  from: string
  to: string
  /** The full original message that triggered the shadow-ban learning. Truncated to 200 chars on the wire. */
  sourceText: string
}

/** Reports an auto-learned shadow-ban replacement rule to the user-configured guard-room endpoint. */
export async function syncGuardRoomShadowRule(input: ShadowRuleSyncInput): Promise<void> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return

  try {
    const response = await fetchGuardRoom(`${endpoint}/api/shadow-rules`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': syncKey,
      },
      body: JSON.stringify({
        kind: 'shadow_rule_learned',
        roomId: input.roomId,
        from: input.from,
        to: input.to,
        sourceText: input.sourceText.slice(0, 200),
        occurredAt: new Date().toISOString(),
        scriptVersion: VERSION,
      }),
    })
    if (!response.ok) warnGuardRoomSyncFailureOnce(endpoint, 'shadow-rule', `HTTP ${response.status}`)
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'shadow-rule', describeFetchError(err))
  }
}

export async function syncGuardRoomWatchlist(rooms: GuardRoomWatchlistRoomInput[]): Promise<void> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return

  // 与其他 sync 路径对称的 try/catch:之前这个函数会让 network/HTTP 异常一路
  // 冒到 guard-room-agent 调用方,触发未捕获的 unhandledrejection 噪声(没人
  // 真去处理它)。失败时改成 dedup 一次的 warning toast,行为与 risk-events /
  // heartbeat / shadow-rule 等保持一致。
  try {
    const response = await fetchGuardRoom(`${endpoint}/api/watchlists/sync`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sync-key': syncKey,
      },
      body: JSON.stringify({ rooms }),
    })
    if (!response.ok) warnGuardRoomSyncFailureOnce(endpoint, 'watchlist', `HTTP ${response.status}`)
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'watchlist', describeFetchError(err))
  }
}

export async function fetchGuardRoomControlProfile(): Promise<GuardRoomControlProfileResponse | null> {
  const endpoint = normalizeGuardRoomEndpoint(guardRoomEndpoint.value)
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) return null

  let response: Response | null = null
  try {
    response = await fetchGuardRoom(`${endpoint}/api/control-profile/current`, {
      method: 'GET',
      headers: {
        'x-sync-key': syncKey,
      },
    })
  } catch (err) {
    warnGuardRoomSyncFailureOnce(endpoint, 'control-profile', describeFetchError(err))
    return null
  }

  if (!response.ok) {
    warnGuardRoomSyncFailureOnce(endpoint, 'control-profile', `HTTP ${response.status}`)
    return null
  }
  return (await response.json()) as GuardRoomControlProfileResponse
}

export function buildGuardRoomLiveDeskUrl(roomId: number, sessionId: string): string {
  const url = new URL(`https://live.bilibili.com/${roomId}`)
  url.searchParams.set('guard_room_source', 'guard-room')
  url.searchParams.set('guard_room_mode', 'dry-run')
  url.searchParams.set('guard_room_autostart', '1')
  url.searchParams.set('guard_room_session', sessionId)
  return url.toString()
}
