import type { ActionSource, Member, MemberRole, ResultMessage, Role } from '@laplace.live/kakashi-protocol'
import { DEFAULT_SERVER_URL } from '@laplace.live/kakashi-protocol'
import { computed, signal } from '@preact/signals'

import { gmSignal } from '../gm-signal'

/** Display names for master send sources (copy toggles, logs). */
export const SOURCE_LABELS: Record<ActionSource, string> = {
  manual: '常规发送',
  loop: '独轮车',
  repeat: '+1',
  emote: '表情',
  meme: '烂梗',
  blend: '自动融入',
  ai: 'AI 融入',
  stt: '转录',
}

// All synced across tabs: one account's tabs must agree, or a stale tab keeps claiming master or copies with old settings.
const SYNC = { syncTabs: true }

export const copyNinjaEnabled = gmSignal('copyNinjaEnabled', false, SYNC)
export const copyNinjaServerUrl = gmSignal('copyNinjaServerUrl', DEFAULT_SERVER_URL, SYNC)
export const copyNinjaToken = gmSignal('copyNinjaToken', '', SYNC)
// Keyed by uid so importing one profile's settings into another account can't clone a master; unset = mirror.
export const copyNinjaRoles = gmSignal<Record<string, Role>>('copyNinjaRoles', {}, SYNC)
// Mirror-side: which master sources this account copies (unset = copy).
export const copyNinjaSources = gmSignal<Partial<Record<ActionSource, boolean>>>('copyNinjaSources', {}, SYNC)
// Mirror-side decay: % of master actions to ignore, plus a random delay so copies don't land together.
export const copyNinjaDropPercent = gmSignal('copyNinjaDropPercent', 0, SYNC)
export const copyNinjaDelayMinSec = gmSignal('copyNinjaDelayMinSec', 1, SYNC)
export const copyNinjaDelayMaxSec = gmSignal('copyNinjaDelayMaxSec', 4, SYNC)
export const copyNinjaFollowRoom = gmSignal('copyNinjaFollowRoom', false, SYNC)
/** 感知忍術: rewrite each master action through the LLM (`kanchi` prompt) instead of copying it verbatim. */
export const copyNinjaKanchi = gmSignal('copyNinjaKanchi', false, SYNC)
/** Set after repeated copy failures (mute / risk control); persisted so a reload or room follow can't resume copying. */
export const copyNinjaPaused = gmSignal('copyNinjaPaused', false, SYNC)

export type CopyNinjaStatus = 'off' | 'connecting' | 'connected' | 'error'

export const copyNinjaStatus = signal<CopyNinjaStatus>('off')
/** Why the last connection attempt failed; shown while retrying or stopped. */
export const copyNinjaStatusDetail = signal('')
export const copyNinjaServerVersion = signal('')
export const copyNinjaSelfUid = signal<string | null>(null)
export const copyNinjaRoster = signal<Member[]>([])
/** Room of the master's active tab, from the latest roster. */
export const copyNinjaMasterRoomId = signal<number | null>(null)
/** Every uid seen in a roster this session; kept through reconnects so in-flight copies stay filtered. */
export const copyNinjaKnownUids = signal<ReadonlySet<string>>(new Set())

/** Master-side: latest copy result per mirror uid. */
export const copyNinjaResults = signal<Record<string, Pick<ResultMessage, 'status' | 'detail'>>>({})

/** Role this account claims; mirrors by default. */
export const copyNinjaClaimedRole = computed<Role>(() => {
  const uid = copyNinjaSelfUid.value
  return (uid && copyNinjaRoles.value[uid]) || 'mirror'
})

/** Claim `role` for this account; mirror is stored as no entry. */
export function setClaimedRole(role: Role): void {
  const uid = copyNinjaSelfUid.value
  if (!uid) return
  const { [uid]: _, ...rest } = copyNinjaRoles.value
  copyNinjaRoles.value = role === 'master' ? { ...rest, [uid]: role } : rest
}

/** Role the server granted this account, once it appears in the roster. */
export const copyNinjaEffectiveRole = computed<MemberRole | null>(() => {
  const uid = copyNinjaSelfUid.value
  return copyNinjaRoster.value.find(member => member.uid === uid)?.role ?? null
})

/** Whether `uid` belongs to this Copy Ninja group, so trend/AI features can ignore its copies. */
export function isCopyNinjaMember(uid: string): boolean {
  return copyNinjaKnownUids.value.has(uid)
}

/** Add roster uids to {@link copyNinjaKnownUids}; no-op when nothing is new. */
export function rememberMembers(members: readonly Member[]): void {
  const known = copyNinjaKnownUids.value
  if (members.every(member => known.has(member.uid))) return
  copyNinjaKnownUids.value = new Set([...known, ...members.map(member => member.uid)])
}

/** Whether this mirror copies `source`. */
export function isCopySourceEnabled(source: ActionSource): boolean {
  return copyNinjaSources.value[source] ?? true
}
