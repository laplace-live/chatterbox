import { describe, expect, mock, test } from 'bun:test'
import * as sdk from '@laplace.live/chatterbox-sdk'
import { effect, type Signal, signal } from '@preact/signals'

import type { SendDanmakuResult } from '../api'

import { loadWithMocks } from '../../testing/load-with-mocks'
import * as utils from '../utils'
import * as wrap from '../wrap'
import * as relayState from './relay-state'

const ORIGIN = 'https://chat.laplace.live'
const ROOM_ID = 1001

type ChangeCallback = (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void

/** GM storage shared by fake tabs; change events arrive async, and `coalesce` keeps only the newest per listener and key, as some managers do. */
function createGmBus({ coalesce = false } = {}) {
  const store = new Map<string, unknown>()
  const listeners = new Map<number, { key: string; tab: number; callback: ChangeCallback }>()
  const queued = new Map<string, { newValue: unknown; remote: boolean }>()
  let nextListener = 1
  let nextTab = 1

  function notify(key: string, oldValue: unknown, newValue: unknown, writer: number) {
    for (const [id, listener] of listeners) {
      if (listener.key !== key) continue
      const slot = `${id}:${key}`
      const remote = listener.tab !== writer
      if (coalesce && queued.has(slot)) {
        queued.set(slot, { newValue, remote })
        continue
      }
      queued.set(slot, { newValue, remote })
      setTimeout(() => {
        const delivery = queued.get(slot)
        queued.delete(slot)
        if (delivery && listeners.has(id)) listener.callback(key, oldValue, delivery.newValue, delivery.remote)
      }, 0)
    }
  }

  return {
    store,
    tab() {
      const tab = nextTab++
      return {
        GM_getValue: (key: string, defaultValue?: unknown) =>
          store.has(key) ? structuredClone(store.get(key)) : defaultValue,
        GM_setValue: (key: string, value: unknown) => {
          const oldValue = store.get(key)
          store.set(key, structuredClone(value))
          notify(key, oldValue, value, tab)
        },
        GM_deleteValue: (key: string) => {
          const oldValue = store.get(key)
          store.delete(key)
          notify(key, oldValue, undefined, tab)
        },
        GM_listValues: () => [...store.keys()],
        GM_addValueChangeListener: (key: string, callback: ChangeCallback) => {
          const id = nextListener++
          listeners.set(id, { key, tab, callback })
          return id
        },
        GM_removeValueChangeListener: (id: number) => listeners.delete(id),
      }
    },
  }
}

type GmBus = ReturnType<typeof createGmBus>

async function waitFor<T>(read: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The dashboard tab: Chatterbox's bridge on a fake page, driven by the SDK client the dashboard uses. */
async function startDashboard(bus: GmBus, enabled: Signal<boolean>) {
  type Listener = (event: { source: unknown; origin: string; data: unknown }) => void
  const listeners = new Set<Listener>()
  // Only `message` listeners hear page messages, so the bridge's `pagehide` cleanup stays out of the way.
  const page = {
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.delete(listener)
    },
    postMessage: (data: unknown) => {
      const copy = structuredClone(data)
      setTimeout(() => {
        for (const listener of listeners) listener({ source: page, origin: ORIGIN, data: copy })
      }, 0)
    },
    location: { origin: ORIGIN },
  }
  const bridge = await loadWithMocks<typeof import('./page-bridge')>(
    new URL('./page-bridge.ts', import.meta.url),
    {
      '@laplace.live/chatterbox-sdk': sdk,
      '@preact/signals': { effect },
      $: { ...bus.tab(), unsafeWindow: page },
      '../store': { laplaceChatRelayEnabled: enabled },
      '../utils': utils,
      '../version': { VERSION: '9.9.9' },
      './relay-state': relayState,
    },
    { window: page, location: { origin: ORIGIN } }
  )
  bridge.startLaplaceChatBridge()
  const client = new sdk.ChatterboxClient({ target: page })
  client.connect()
  await waitFor(() => client.status ?? undefined)
  return {
    client,
    send: (text: string, roomId = ROOM_ID) => client.send(roomId, text, { wrapBrackets: true }),
  }
}

interface RoomOptions {
  hidden?: boolean
  maxUnits?: number
  send?: (message: string) => SendDanmakuResult
  /** How long each stubbed send takes. */
  sendMs?: number
}

/** A live-room tab running the relay, with the send queue stubbed out. */
async function startRoom(bus: GmBus, enabled: Signal<boolean>, options: RoomOptions = {}) {
  const enqueue = mock(async (message: string, _roomId: number, _csrf: string, _priority: number, _source: string) => {
    if (options.sendMs) await new Promise(resolve => setTimeout(resolve, options.sendMs))
    return options.send?.(message) ?? { success: true, message, isEmoticon: false }
  })
  const relay = await loadWithMocks<typeof import('./room-relay')>(
    new URL('./room-relay.ts', import.meta.url),
    {
      $: bus.tab(),
      '../ai-evasion': { tryAiEvasion: async () => ({ success: false }) },
      '../api': { ensureRoomId: async () => ROOM_ID, getCsrfToken: () => 'csrf' },
      '../log': { appendLog: () => {} },
      '../page-visibility': { isTabHidden: () => options.hidden ?? false },
      '../replacement': { applyReplacements: (text: string) => text },
      '../send-queue': { enqueueDanmaku: enqueue, SendPriority: { MANUAL: 2 } },
      '../store': {
        cachedRoomId: signal(ROOM_ID),
        danmakuMaxUnits: signal(options.maxUnits ?? 80),
        laplaceChatRelayEnabled: enabled,
      },
      '../utils': utils,
      '../wrap': wrap,
      './relay-state': relayState,
    },
    {
      window: { addEventListener: () => {}, removeEventListener: () => {} },
      location: { href: `https://live.bilibili.com/${ROOM_ID}` },
    }
  )
  relay.startLaplaceChatRelay()
  return { enqueue, stop: relay.stopLaplaceChatRelay }
}

describe('readRoomTabState', () => {
  test('keeps a tab whose outcomes are partly malformed, minus those outcomes', () => {
    const ok = { status: 'sent', sent: 1, total: 1, at: 5 } satisfies relayState.RelayOutcome
    const state = relayState.readRoomTabState({
      roomIds: [1],
      visible: true,
      seenAt: 1,
      outcomes: { ok, bad: { status: 'exploded', sent: 0, total: 0, at: 1 } },
    })
    expect(state?.outcomes).toEqual({ ok })
  })
})

describe('LAPLACE Chat relay', () => {
  test('announces itself to the client and re-announces when the setting flips', async () => {
    const enabled = signal(false)
    const { client } = await startDashboard(createGmBus(), enabled)
    expect(client.status).toEqual({ version: '9.9.9', enabled: false })
    enabled.value = true
    await waitFor(() => (client.status?.enabled ? true : undefined))
  })

  test('sends a superchat through the room tab as one bracketed manual danmaku', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled)
    expect(await dashboard.send('主播晚上好')).toMatchObject({ status: 'sent', sent: 1, total: 1 })
    expect(room.enqueue.mock.calls.map(([message, , , priority, source]) => [message, priority, source])).toEqual([
      ['【主播晚上好】', 2, 'laplace-chat'],
    ])
    // Accepted requests leave the bridge's request list.
    expect([...bus.store.keys()].some(key => key.startsWith(relayState.REQUESTS_KEY_PREFIX))).toBe(false)
  })

  test('splits long text at the room cap with every segment bracketed', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled, { maxUnits: 40 })
    const text = '一二三四五六七八九十'.repeat(3)
    expect(await dashboard.send(text)).toMatchObject({ status: 'sent', sent: 2, total: 2 })
    // 40 units minus the 4 the brackets take leaves 18 CJK characters per segment.
    const segments = room.enqueue.mock.calls.map(([message]) => message)
    expect(segments).toEqual([`【${text.slice(0, 18)}】`, `【${text.slice(18)}】`])
    for (const segment of segments) expect(utils.getDanmakuUnits(segment)).toBeLessThanOrEqual(40)
  })

  test('reports a partial send with Bilibili’s reason', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    await startRoom(bus, enabled, {
      maxUnits: 8,
      send: message =>
        message.includes('四')
          ? { success: false, message, isEmoticon: false, error: 'k', rejected: true }
          : { success: true, message, isEmoticon: false },
    })
    expect(await dashboard.send('一二三四')).toMatchObject({
      status: 'partial',
      sent: 1,
      total: 2,
      error: 'k - 包含房间屏蔽词',
    })
  })

  test('relays one superchat at a time so split segments never interleave', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled, { maxUnits: 8, sendMs: 30 })
    const results = await Promise.all([dashboard.send('甲甲乙乙'), dashboard.send('丙丙丁丁')])
    expect(results).toMatchObject([
      { status: 'sent', total: 2 },
      { status: 'sent', total: 2 },
    ])
    expect(room.enqueue.mock.calls.map(([message]) => message)).toEqual([
      '【甲甲】',
      '【乙乙】',
      '【丙丙】',
      '【丁丁】',
    ])
  })

  test('only the visible tab sends when two tabs show the room', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const hidden = await startRoom(bus, enabled, { hidden: true })
    const visible = await startRoom(bus, enabled)
    expect(await dashboard.send('晚上好')).toMatchObject({ status: 'sent' })
    expect(visible.enqueue).toHaveBeenCalledTimes(1)
    expect(hidden.enqueue).not.toHaveBeenCalled()
  })

  test('survives a manager that coalesces change events', async () => {
    const bus = createGmBus({ coalesce: true })
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled)
    const results = await Promise.all([dashboard.send('第一条'), dashboard.send('第二条')])
    expect(results).toMatchObject([{ status: 'sent' }, { status: 'sent' }])
    expect(room.enqueue).toHaveBeenCalledTimes(2)
  })

  test('answers a malformed send instead of leaving it hanging', async () => {
    const dashboard = await startDashboard(createGmBus(), signal(true))
    expect(await dashboard.send('   ')).toMatchObject({ status: 'invalid' })
  })

  test('refuses while the setting is off', async () => {
    const bus = createGmBus()
    const enabled = signal(false)
    const dashboard = await startDashboard(bus, enabled)
    expect(await dashboard.send('晚上好')).toMatchObject({ status: 'disabled' })
    expect(bus.store.size).toBe(0)
  })

  test('reports no room tab when none shows the room', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled)
    expect(await dashboard.send('晚上好', 2002)).toMatchObject({ status: 'no-room-tab' })
    expect(room.enqueue).not.toHaveBeenCalled()
  })

  test('a stopped tab drops out of discovery', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    const room = await startRoom(bus, enabled)
    room.stop()
    expect(await dashboard.send('晚上好')).toMatchObject({ status: 'no-room-tab' })
    expect([...bus.store.keys()].some(key => key.startsWith(relayState.TAB_KEY_PREFIX))).toBe(false)
  })

  test('relays a request once even when rings keep re-reading it', async () => {
    const bus = createGmBus()
    const room = await startRoom(bus, signal(true), { sendMs: 30 })
    const tabKey = [...bus.store.keys()].find(key => key.startsWith(relayState.TAB_KEY_PREFIX)) ?? ''
    const other = bus.tab()
    other.GM_setValue(`${relayState.REQUESTS_KEY_PREFIX}b1`, {
      updatedAt: Date.now(),
      requests: [
        {
          id: 'r1',
          tabId: tabKey.slice(relayState.TAB_KEY_PREFIX.length),
          roomId: ROOM_ID,
          text: '晚上好',
          wrapBrackets: true,
          expiresAt: Date.now() + 5000,
        },
      ],
    })
    for (const n of [1, 2, 3]) {
      other.GM_setValue(relayState.RING_KEY, `ring ${n}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(room.enqueue).toHaveBeenCalledTimes(1)
  })

  test('forwards per-segment progress before the result', async () => {
    const bus = createGmBus()
    const enabled = signal(true)
    const dashboard = await startDashboard(bus, enabled)
    await startRoom(bus, enabled, { maxUnits: 8, sendMs: 300 })
    const progress: number[] = []
    const result = await dashboard.client.send(ROOM_ID, '甲甲乙乙丙丙', {
      wrapBrackets: true,
      onProgress: ({ sent }) => progress.push(sent),
    })
    expect(result).toMatchObject({ status: 'sent', sent: 3, total: 3 })
    expect(progress).toEqual([0, 1, 2])
  })
})
