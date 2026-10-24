import type {
  Action,
  ActionDeliveryMessage,
  CopyStatus,
  Member,
  MemberRole,
  Presence,
  RosterMessage,
  ServerMessage,
} from '@laplace.live/kakashi-protocol'

/** One authenticated tab. */
export interface Peer extends Presence {
  id: string
  uid: string
  uname: string
  /** Last hello, hidden→visible transition or room change; breaks ties when picking which tab of an account acts. */
  activeAt: number
  connectedAt: number
  send: (message: ServerMessage) => void
}

export interface HubOptions {
  /** How long a departed master's uid stays reserved, so a page reload doesn't hand control to a standby. */
  masterGraceMs?: number
  now?: () => number
  log?: (line: string) => void
  debug?: (line: string) => void
}

/** Results arriving later than this (mirror delay + queue) are no longer forwarded. */
const PENDING_TTL_MS = 5 * 60_000
const DEFAULT_MASTER_GRACE_MS = 15_000
const ROLE_RANK: Record<MemberRole, number> = { master: 0, standby: 1, mirror: 2 }

const noop = () => {}

function label(peer: Pick<Peer, 'uid' | 'uname'>): string {
  return `${peer.uname} (${peer.uid})`
}

function truncate(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Prefer a visible tab, then the most recently active one. */
function pickTab(peers: Peer[]): Peer | undefined {
  return [...peers].sort((a, b) => Number(b.visible) - Number(a.visible) || b.activeAt - a.activeAt)[0]
}

/** Roster, master election and action routing; transport-agnostic so it can be tested without sockets. */
export class Hub {
  private readonly peers = new Map<string, Peer>()
  private readonly pending = new Map<string, { originId: string; expiresAt: number }>()
  /** Last roster broadcast as JSON, so a presence change that leaves it as is (e.g. a visibility flip) sends nothing. */
  private lastRoster = ''
  private masterUid: string | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly masterGraceMs: number
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly debug: (line: string) => void

  constructor(options: HubOptions = {}) {
    this.masterGraceMs = options.masterGraceMs ?? DEFAULT_MASTER_GRACE_MS
    this.now = options.now ?? Date.now
    this.log = options.log ?? noop
    this.debug = options.debug ?? noop
  }

  join(tab: Omit<Peer, 'activeAt' | 'connectedAt'>): void {
    const now = this.now()
    const peer: Peer = { ...tab, activeAt: now, connectedAt: now }
    this.peers.set(peer.id, peer)
    this.log(`+ ${label(peer)} as ${peer.role}${peer.roomId === null ? '' : ` · room ${peer.roomId}`} · ${peer.id}`)
    this.refresh()
  }

  update(id: string, presence: Presence): void {
    const peer = this.peers.get(id)
    if (!peer) return
    // A tab that just became visible or moved is the active one.
    if ((presence.visible && !peer.visible) || presence.roomId !== peer.roomId) peer.activeAt = this.now()
    peer.role = presence.role
    peer.roomId = presence.roomId
    peer.visible = presence.visible
    peer.follow = presence.follow
    this.refresh()
  }

  leave(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id)
    this.log(`- ${label(peer)} · ${peer.id}`)
    this.refresh()
  }

  /** Fan a master action out to one tab per mirror uid in the action's room. */
  action(id: string, action: Action): void {
    const sender = this.peers.get(id)
    if (!sender) return
    if (sender.uid !== this.masterUid) {
      sender.send({ type: 'error', message: '只有主控账号可以广播' })
      return
    }
    this.sweep()
    const eventId = crypto.randomUUID()
    this.pending.set(eventId, { originId: id, expiresAt: this.now() + PENDING_TTL_MS })
    const delivery: ActionDeliveryMessage = {
      type: 'action',
      eventId,
      from: { uid: sender.uid, uname: sender.uname },
      action,
    }
    let delivered = 0
    for (const [uid, peers] of this.groups()) {
      if (this.memberRole(uid, peers) !== 'mirror') continue
      const target = pickTab(peers.filter(p => p.roomId === action.roomId))
      if (target) {
        target.send(delivery)
        delivered++
      } else {
        const uname = pickTab(peers)?.uname ?? uid
        sender.send({ type: 'result', eventId, uid, uname, status: 'skipped', detail: '不在同一直播间' })
      }
    }
    this.log(`📣 ${label(sender)} [${action.source}] ${truncate(action.text)} → ${delivered} mirror(s)`)
  }

  /** Forward a mirror's copy result to the tab that broadcast the action. */
  result(id: string, eventId: string, status: CopyStatus, detail?: string): void {
    const sender = this.peers.get(id)
    const entry = this.pending.get(eventId)
    if (!sender || !entry) return
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(eventId)
      return
    }
    const line = `${status === 'failed' ? '✗' : '·'} ${label(sender)} ${status}${detail ? `: ${detail}` : ''}`
    if (status === 'failed') this.log(line)
    else this.debug(line)
    const origin = this.peers.get(entry.originId)
    if (!origin) return
    origin.send({ type: 'result', eventId, uid: sender.uid, uname: sender.uname, status, detail })
  }

  roster(): RosterMessage {
    const members: Member[] = []
    for (const [uid, peers] of this.groups()) {
      const roomIds = [...new Set(peers.flatMap(p => (p.roomId === null ? [] : [p.roomId])))]
      const uname = pickTab(peers)?.uname ?? uid
      members.push({ uid, uname, role: this.memberRole(uid, peers), roomIds, tabs: peers.length })
    }
    members.sort((a, b) => ROLE_RANK[a.role] - ROLE_RANK[b.role])
    return { type: 'roster', members, masterRoomId: this.masterRoomId() }
  }

  stop(): void {
    this.clearGrace()
  }

  private refresh(): void {
    this.elect()
    const roster = this.roster()
    const json = JSON.stringify(roster)
    if (json !== this.lastRoster) {
      this.lastRoster = json
      for (const peer of this.peers.values()) peer.send(roster)
    }
    this.sendFollows(roster.masterRoomId)
  }

  private elect(): void {
    const claimants = [...this.peers.values()].filter(p => p.role === 'master')
    if (this.masterUid !== null) {
      if (claimants.some(p => p.uid === this.masterUid)) {
        this.clearGrace()
        return
      }
      // Fully disconnected (e.g. reloading): hold the seat. Still connected but switched role: release now.
      if (!this.peersOf(this.masterUid).length && this.masterGraceMs > 0) {
        this.graceTimer ??= setTimeout(() => {
          this.graceTimer = null
          this.masterUid = null
          this.refresh()
        }, this.masterGraceMs)
        return
      }
      this.clearGrace()
      this.masterUid = null
    }
    const next = claimants.sort((a, b) => a.connectedAt - b.connectedAt)[0]
    if (!next) return
    this.masterUid = next.uid
    this.log(`👑 master: ${label(next)}`)
  }

  /** Re-sent on every refresh (tabs ignore a repeat), so a tab that dropped its pending move always gets it back. */
  private sendFollows(masterRoomId: number | null): void {
    if (masterRoomId === null) return
    for (const [uid, peers] of this.groups()) {
      if (this.memberRole(uid, peers) !== 'mirror' || peers.some(p => p.roomId === masterRoomId)) continue
      // Only following tabs with a resolved room qualify.
      const target = pickTab(peers.filter(p => p.follow && p.roomId !== null))
      if (!target) continue
      target.send({ type: 'follow', roomId: masterRoomId })
      this.debug(`→ follow ${label(target)} to room ${masterRoomId}`)
    }
  }

  private memberRole(uid: string, peers: Peer[]): MemberRole {
    if (uid === this.masterUid) return 'master'
    return peers.some(p => p.role === 'master') ? 'standby' : 'mirror'
  }

  private masterRoomId(): number | null {
    if (this.masterUid === null) return null
    return pickTab(this.peersOf(this.masterUid).filter(p => p.roomId !== null))?.roomId ?? null
  }

  private peersOf(uid: string): Peer[] {
    return [...this.peers.values()].filter(p => p.uid === uid)
  }

  private groups(): Map<string, Peer[]> {
    const groups = new Map<string, Peer[]>()
    for (const peer of this.peers.values()) {
      const group = groups.get(peer.uid)
      if (group) group.push(peer)
      else groups.set(peer.uid, [peer])
    }
    return groups
  }

  private sweep(): void {
    const now = this.now()
    for (const [eventId, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(eventId)
    }
  }

  private clearGrace(): void {
    if (this.graceTimer === null) return
    clearTimeout(this.graceTimer)
    this.graceTimer = null
  }
}
