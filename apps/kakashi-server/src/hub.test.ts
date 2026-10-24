import { describe, expect, test } from 'bun:test'
import type { Action, Role, ServerMessage } from '@laplace.live/kakashi-protocol'

import { Hub } from './hub'

const ROOM = 100
const OTHER_ROOM = 200

function createHub(options: { masterGraceMs?: number } = {}) {
  let now = 1_000
  const hub = new Hub({ masterGraceMs: options.masterGraceMs ?? 0, now: () => now })
  const inbox = new Map<string, ServerMessage[]>()

  function join(id: string, uid: string, role: Role, roomId: number | null, visible = true, follow = true): void {
    const messages: ServerMessage[] = []
    inbox.set(id, messages)
    now += 1
    hub.join({ id, uid, uname: `user${uid}`, role, roomId, visible, follow, send: message => messages.push(message) })
  }

  function received(id: string, type: ServerMessage['type']): ServerMessage[] {
    return (inbox.get(id) ?? []).filter(message => message.type === type)
  }

  return {
    hub,
    join,
    received,
    advance: (ms: number) => {
      now += ms
    },
    clear: () => {
      for (const messages of inbox.values()) messages.splice(0)
    },
  }
}

const action: Action = { kind: 'danmaku', roomId: ROOM, text: '哈哈哈', source: 'manual' }

describe('master election', () => {
  test('first claimant leads and a second account waits on standby', () => {
    const { hub, join } = createHub()
    join('a', '1', 'master', ROOM)
    join('b', '2', 'master', ROOM)
    join('c', '3', 'mirror', ROOM)
    expect(hub.roster().members.map(m => [m.uid, m.role])).toEqual([
      ['1', 'master'],
      ['2', 'standby'],
      ['3', 'mirror'],
    ])
  })

  test('holds the seat through a reload, then promotes the standby after the grace period', async () => {
    const { hub, join } = createHub({ masterGraceMs: 30 })
    join('a', '1', 'master', ROOM)
    join('b', '2', 'master', ROOM)
    hub.leave('a')
    expect(hub.roster().members[0]).toMatchObject({ uid: '2', role: 'standby' })
    join('a2', '1', 'master', ROOM)
    await Bun.sleep(50)
    expect(hub.roster().members[0]).toMatchObject({ uid: '1', role: 'master' })

    hub.leave('a2')
    await Bun.sleep(50)
    expect(hub.roster().members[0]).toMatchObject({ uid: '2', role: 'master' })
    hub.stop()
  })

  test('releases the seat at once when the master switches itself to mirror', () => {
    const { hub, join } = createHub({ masterGraceMs: 60_000 })
    join('a', '1', 'master', ROOM)
    join('b', '2', 'master', ROOM)
    hub.update('a', { role: 'mirror', roomId: ROOM, visible: true, follow: true })
    expect(hub.roster().members[0]).toMatchObject({ uid: '2', role: 'master' })
    hub.stop()
  })
})

describe('action routing', () => {
  test('delivers to exactly one tab per mirror account, preferring a visible tab in the room', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x-hidden', '2', 'mirror', ROOM, false)
    join('x-visible', '2', 'mirror', ROOM, true)
    join('x-elsewhere', '2', 'mirror', OTHER_ROOM, true)
    hub.action('m', action)
    expect(received('x-visible', 'action')).toHaveLength(1)
    expect(received('x-hidden', 'action')).toHaveLength(0)
    expect(received('x-elsewhere', 'action')).toHaveLength(0)
  })

  test('reports a skipped copy for a mirror with no tab in the room', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('y', '3', 'mirror', OTHER_ROOM)
    hub.action('m', action)
    expect(received('m', 'result')).toEqual([
      expect.objectContaining({ uid: '3', status: 'skipped', detail: '不在同一直播间' }),
    ])
  })

  test('ignores actions from anyone but the master and never echoes to standby or master tabs', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('m2', '1', 'master', ROOM)
    join('s', '2', 'master', ROOM)
    hub.action('s', action)
    expect(received('s', 'error')).toHaveLength(1)
    hub.action('m', action)
    expect(received('m2', 'action')).toHaveLength(0)
    expect(received('s', 'action')).toHaveLength(0)
  })

  test('drops results that arrive after the pending entry expired', () => {
    const { hub, join, received, advance } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', ROOM)
    hub.action('m', action)
    const [delivery] = received('x', 'action')
    if (delivery?.type !== 'action') throw new Error('expected an action delivery')
    advance(5 * 60_000)
    hub.result('x', delivery.eventId, 'sent')
    expect(received('m', 'result')).toHaveLength(0)
  })

  test('forwards a mirror result back to the broadcasting tab', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', ROOM)
    hub.action('m', action)
    const [delivery] = received('x', 'action')
    if (delivery?.type !== 'action') throw new Error('expected an action delivery')
    hub.result('x', delivery.eventId, 'failed', '你被禁言啦')
    expect(received('m', 'result')).toEqual([
      { type: 'result', eventId: delivery.eventId, uid: '2', uname: 'user2', status: 'failed', detail: '你被禁言啦' },
    ])
  })
})

describe('room following', () => {
  test('keeps sending the follow to a mirror outside the master room until it arrives', () => {
    const { hub, join, received, clear } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', OTHER_ROOM)
    expect(received('x', 'follow')).toEqual([{ type: 'follow', roomId: ROOM }])
    join('y', '3', 'mirror', ROOM)
    expect(received('x', 'follow')).toHaveLength(2)
    expect(received('y', 'follow')).toHaveLength(0)
    clear()
    hub.update('x', { role: 'mirror', roomId: ROOM, visible: true, follow: true })
    join('z', '4', 'mirror', ROOM)
    expect(received('x', 'follow')).toHaveLength(0)
  })

  test('follows the master tab that became visible most recently', () => {
    const { hub, join, received, clear } = createHub()
    join('m1', '1', 'master', ROOM, true)
    join('m2', '1', 'master', OTHER_ROOM, false)
    join('x', '2', 'mirror', ROOM)
    expect(received('x', 'follow')).toHaveLength(0)
    clear()
    hub.update('m1', { role: 'master', roomId: ROOM, visible: false, follow: true })
    hub.update('m2', { role: 'master', roomId: OTHER_ROOM, visible: true, follow: true })
    expect(received('x', 'follow').at(-1)).toEqual({ type: 'follow', roomId: OTHER_ROOM })
  })

  test('waits for a tab to resolve its room before following', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', null)
    expect(received('x', 'follow')).toHaveLength(0)
    hub.update('x', { role: 'mirror', roomId: OTHER_ROOM, visible: true, follow: true })
    expect(received('x', 'follow')).toEqual([{ type: 'follow', roomId: ROOM }])
  })

  test('re-sends a follow after a tab moves to yet another room', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', OTHER_ROOM)
    hub.update('x', { role: 'mirror', roomId: 300, visible: true, follow: true })
    expect(received('x', 'follow')).toEqual([
      { type: 'follow', roomId: ROOM },
      { type: 'follow', roomId: ROOM },
    ])
  })

  test('follows a master tab that changed rooms even while another master tab is visible', () => {
    const { hub, join, received, advance } = createHub()
    join('m1', '1', 'master', ROOM)
    join('m2', '1', 'master', ROOM)
    join('x', '2', 'mirror', ROOM)
    advance(10)
    hub.update('m1', { role: 'master', roomId: OTHER_ROOM, visible: true, follow: true })
    expect(hub.roster().masterRoomId).toBe(OTHER_ROOM)
    expect(received('x', 'follow')).toEqual([{ type: 'follow', roomId: OTHER_ROOM }])
  })

  test('only a following tab of the account is sent the follow', () => {
    const { join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x-visible', '2', 'mirror', OTHER_ROOM, true, false)
    join('x-following', '2', 'mirror', OTHER_ROOM, false, true)
    expect(received('x-visible', 'follow')).toHaveLength(0)
    expect(received('x-following', 'follow')).toEqual([{ type: 'follow', roomId: ROOM }])
  })

  test('turning following off and on again re-sends the follow', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', OTHER_ROOM)
    hub.update('x', { role: 'mirror', roomId: OTHER_ROOM, visible: true, follow: false })
    hub.update('x', { role: 'mirror', roomId: OTHER_ROOM, visible: true, follow: true })
    expect(received('x', 'follow')).toHaveLength(2)
  })

  test('re-sends the follow when the master comes back after a reload', () => {
    const { hub, join, received } = createHub()
    join('m', '1', 'master', ROOM)
    join('x', '2', 'mirror', OTHER_ROOM)
    hub.leave('m')
    expect(hub.roster().masterRoomId).toBeNull()
    join('m-reloaded', '1', 'master', ROOM)
    expect(received('x', 'follow')).toEqual([
      { type: 'follow', roomId: ROOM },
      { type: 'follow', roomId: ROOM },
    ])
  })
})
