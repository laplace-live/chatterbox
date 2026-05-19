/**
 * Multi-room observation agent: connects to the shared dashboard, fetches a
 * unified control profile (auto-blend preset, dry-run toggle, heartbeat
 * cadence, hot-room thresholds), syncs the watchlist of medal / follow
 * rooms. Built for the heavy-active viewer who runs chatterbox in several
 * tabs / devices and wants their settings + room state coordinated.
 *
 * (Was briefly marked @deprecated under the assumption it served guild
 * admins — that was a misreading; see guard-room-sync.ts header for the
 * full retrospective. Module is staying in chatterbox.)
 */

import { type FollowingRoom, fetchFollowingRooms, fetchMedalRooms, fetchRoomLiveStatus, type MedalRoom } from './api'
import { applyAutoBlendPreset } from './auto-blend-presets'
import {
  type GuardRoomWatchlistRoomState,
  guardRoomAgentConnected,
  guardRoomAgentLastSyncAt,
  guardRoomAgentLiveCount,
  guardRoomAgentStatusText,
  guardRoomAgentWatchlistCount,
  guardRoomAppliedProfile,
  guardRoomLiveDeskHeartbeatSec,
  guardRoomLiveDeskSessionId,
  guardRoomWatchlistRooms,
} from './guard-room-live-desk-state'
import {
  fetchGuardRoomControlProfile,
  type GuardRoomControlProfile,
  type GuardRoomWatchlistRoomInput,
  syncGuardRoomWatchlist,
} from './guard-room-sync'
import { appendLog } from './log'
import {
  autoBlendDryRun,
  guardRoomEndpoint,
  guardRoomHandoffActive,
  guardRoomSyncKey,
  guardRoomWebsiteControlEnabled,
} from './store'

const MIN_SYNC_INTERVAL_MS = 30_000
const FOLLOWING_PAGE_LIMIT = 4
const LIVE_STATUS_BATCH = 8

let timer: ReturnType<typeof setTimeout> | null = null
let running = false
let lastSessionId = ''
let lastFailure = ''

function setDisconnected(message: string): void {
  guardRoomAgentConnected.value = false
  guardRoomAgentStatusText.value = message
  guardRoomAgentLastSyncAt.value = null
  guardRoomAgentWatchlistCount.value = 0
  guardRoomAgentLiveCount.value = 0
  guardRoomLiveDeskSessionId.value = ''
  guardRoomWatchlistRooms.value = []
}

function mergeWatchlistRooms(
  medals: MedalRoom[],
  follows: FollowingRoom[]
): Array<Omit<GuardRoomWatchlistRoomInput, 'liveStatus'>> {
  const rooms = new Map<number, Omit<GuardRoomWatchlistRoomInput, 'liveStatus'>>()

  for (const room of medals) {
    rooms.set(room.roomId, {
      roomId: room.roomId,
      anchorName: room.anchorName,
      anchorUid: room.anchorUid,
      medalName: room.medalName,
      source: 'medal',
    })
  }

  for (const room of follows) {
    const existing = rooms.get(room.roomId)
    if (existing) {
      rooms.set(room.roomId, {
        ...existing,
        anchorName: existing.anchorName || room.anchorName,
        anchorUid: existing.anchorUid ?? room.anchorUid,
        source: existing.source === 'medal' ? 'both' : existing.source,
      })
      continue
    }

    rooms.set(room.roomId, {
      roomId: room.roomId,
      anchorName: room.anchorName,
      anchorUid: room.anchorUid,
      medalName: null,
      source: 'follow',
    })
  }

  return [...rooms.values()].sort((a, b) => a.anchorName.localeCompare(b.anchorName))
}

async function attachLiveStatus(
  rooms: Array<Omit<GuardRoomWatchlistRoomInput, 'liveStatus'>>
): Promise<GuardRoomWatchlistRoomInput[]> {
  const results: GuardRoomWatchlistRoomInput[] = []
  for (let index = 0; index < rooms.length; index += LIVE_STATUS_BATCH) {
    const batch = rooms.slice(index, index + LIVE_STATUS_BATCH)
    const resolved = await Promise.all(
      batch.map(async room => ({
        ...room,
        liveStatus: await fetchRoomLiveStatus(room.roomId).catch(() => 'unknown' as const),
      }))
    )
    results.push(...resolved)
  }
  return results
}

async function collectWatchlist(): Promise<GuardRoomWatchlistRoomInput[]> {
  const medals = await fetchMedalRooms()
  let follows: FollowingRoom[] = []

  try {
    follows = await fetchFollowingRooms(FOLLOWING_PAGE_LIMIT)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLog(`直播间保安室：拉关注列表失败，先只同步粉丝牌房。${message}`)
  }

  const merged = mergeWatchlistRooms(medals, follows)
  return attachLiveStatus(merged)
}

function applyControlProfile(profile: GuardRoomControlProfile): void {
  guardRoomAppliedProfile.value = profile
  guardRoomLiveDeskHeartbeatSec.value = profile.heartbeatSec
  if (!guardRoomWebsiteControlEnabled.value && !guardRoomHandoffActive.value) return
  autoBlendDryRun.value = profile.dryRunDefault
  applyAutoBlendPreset(profile.conservativeMode)
}

function markSuccess(watchlist: GuardRoomWatchlistRoomState[]): void {
  const now = Date.now()
  guardRoomAgentConnected.value = true
  guardRoomAgentStatusText.value = '监控室代理已连接'
  guardRoomAgentLastSyncAt.value = now
  guardRoomAgentWatchlistCount.value = watchlist.length
  guardRoomAgentLiveCount.value = watchlist.filter(room => room.liveStatus === 'live').length
  guardRoomWatchlistRooms.value = watchlist
  lastFailure = ''
}

async function syncOnce(): Promise<void> {
  const endpoint = guardRoomEndpoint.value.trim()
  const syncKey = guardRoomSyncKey.value.trim()
  if (!endpoint || !syncKey) {
    setDisconnected('未配置监控室地址或同步密钥')
    return
  }

  guardRoomAgentStatusText.value = '监控室代理同步中…'
  const watchlist = await collectWatchlist()
  await syncGuardRoomWatchlist(watchlist)

  const control = await fetchGuardRoomControlProfile()
  if (!control) {
    throw new Error('监控室没有返回统一配置')
  }

  applyControlProfile(control.profile)
  guardRoomLiveDeskSessionId.value = control.session?.status === 'active' ? control.session.id : ''

  if (control.session?.id && control.session.id !== lastSessionId) {
    appendLog(`直播间保安室：监控会话已切到 ${control.session.id}`)
  }
  lastSessionId = control.session?.id ?? ''

  markSuccess(
    watchlist.map(room => ({
      ...room,
      medalName: room.medalName ?? null,
    }))
  )
}

async function tick(): Promise<void> {
  try {
    await syncOnce()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    guardRoomAgentConnected.value = false
    guardRoomAgentStatusText.value = `监控室代理掉线：${message}`
    if (message !== lastFailure) {
      appendLog(`直播间保安室：监控室代理同步失败：${message}`)
      lastFailure = message
    }
  } finally {
    if (running) {
      const intervalMs = Math.max(MIN_SYNC_INTERVAL_MS, guardRoomLiveDeskHeartbeatSec.value * 1000)
      timer = setTimeout(() => {
        void tick()
      }, intervalMs)
    }
  }
}

export function startGuardRoomAgent(): void {
  if (running) return
  running = true
  void tick()
}

export function stopGuardRoomAgent(): void {
  running = false
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
