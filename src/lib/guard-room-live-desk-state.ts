/**
 * Live-desk runtime signals: session id, heartbeat cadence, current
 * risk level, watchlist of rooms being observed. Drives the multi-room
 * observation agent's heartbeat loop.
 *
 * (Briefly slated for spinoff under the wrong premise; staying. See
 * guard-room-sync.ts header for the retrospective.)
 */

import { signal } from '@preact/signals'

import { gmSignal } from './gm-signal'

export const guardRoomLiveDeskSessionId = gmSignal('guardRoomLiveDeskSessionId', '')
export const guardRoomLiveDeskHeartbeatSec = gmSignal('guardRoomLiveDeskHeartbeatSec', 30)
export const guardRoomCurrentRiskLevel = signal<'stop' | 'observe' | 'pass'>('pass')

export interface GuardRoomWatchlistRoomState {
  roomId: number
  anchorName: string
  anchorUid?: number | null
  medalName?: string | null
  source: 'medal' | 'follow' | 'both'
  liveStatus: 'live' | 'offline' | 'unknown'
}

export interface GuardRoomAppliedProfileState {
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

export const guardRoomAgentConnected = signal(false)
export const guardRoomAgentStatusText = signal('未连接')
export const guardRoomAgentLastSyncAt = signal<number | null>(null)
export const guardRoomAgentWatchlistCount = signal(0)
export const guardRoomAgentLiveCount = signal(0)
export const guardRoomWatchlistRooms = signal<GuardRoomWatchlistRoomState[]>([])
export const guardRoomAppliedProfile = signal<GuardRoomAppliedProfileState | null>(null)
