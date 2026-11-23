import { describe, expect, test } from 'bun:test'

import type { ChatterboxStatus, ChatterboxWindow } from './client.ts'

import { ChatterboxClient } from './client.ts'

const ORIGIN = 'https://chat.laplace.live'

type Message = Record<string, unknown>
type Reply = (data: Message) => void

/** A page window with a scripted bridge on it; `answer` sees every message the client posts. */
function createPage(answer: (message: Message, reply: Reply) => void = () => {}) {
  const listeners = new Set<(event: { source: unknown; origin: string; data: unknown }) => void>()
  const posted: Message[] = []
  const page: ChatterboxWindow = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    postMessage: data => {
      const copy = structuredClone(data)
      setTimeout(() => {
        for (const listener of listeners) listener({ source: page, origin: ORIGIN, data: copy })
      }, 0)
    },
    location: { origin: ORIGIN },
  }
  const reply: Reply = data => page.postMessage({ source: 'laplace-chatterbox', ...data }, ORIGIN)
  listeners.add(({ data }) => {
    if (typeof data !== 'object' || data === null || !('source' in data) || data.source !== 'laplace-chat') return
    const message: Message = { ...data }
    posted.push(message)
    answer(message, reply)
  })
  return { page, posted }
}

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms))

function announcing(status: Message, onSend?: (message: Message, reply: Reply) => void) {
  return (message: Message, reply: Reply) => {
    if (message.type === 'ping') reply({ type: 'status', ...status })
    else onSend?.(message, reply)
  }
}

describe('ChatterboxClient', () => {
  test('reports unavailable while no bridge has announced itself', async () => {
    const { page, posted } = createPage()
    const client = new ChatterboxClient({ target: page })
    client.connect()
    await tick()
    expect(client.status).toBeNull()
    expect(await client.send(1, 'hi')).toEqual({ status: 'unavailable', sent: 0, total: 0 })
    expect(posted.map(message => message.type)).toEqual(['ping'])
  })

  test('treats a bridge on another protocol as absent', async () => {
    const { page } = createPage(announcing({ protocol: 2, version: '9.0.0', enabled: true }))
    const client = new ChatterboxClient({ target: page })
    client.connect()
    await tick()
    expect(client.status).toBeNull()
  })

  test('notifies status changes only, keeping the status object stable between them', async () => {
    let enabled = false
    const { page } = createPage((message, reply) => {
      if (message.type === 'ping') reply({ type: 'status', protocol: 1, version: '5.1.0', enabled })
    })
    const client = new ChatterboxClient({ target: page })
    const seen: (ChatterboxStatus | null)[] = []
    const unsubscribe = client.onStatusChange(status => seen.push(status))
    client.connect()
    await tick()
    const first = client.status
    client.connect()
    await tick()
    expect(client.status).toBe(first)
    enabled = true
    client.connect()
    await tick()
    unsubscribe()
    enabled = false
    client.connect()
    await tick()
    expect(seen).toEqual([
      { version: '5.1.0', enabled: false },
      { version: '5.1.0', enabled: true },
    ])
  })

  test('sends and resolves with the result, reporting progress', async () => {
    const { page, posted } = createPage(
      announcing({ protocol: 1, version: '5.1.0', enabled: true }, (message, reply) => {
        reply({ type: 'progress', id: message.id, sent: 1, total: 2 })
        reply({ type: 'result', id: message.id, status: 'partial', sent: 1, total: 2, error: 'k - 包含房间屏蔽词' })
      })
    )
    const client = new ChatterboxClient({ target: page })
    client.connect()
    await tick()
    const progress: unknown[] = []
    const result = await client.send(21452505, '主播晚上好', { wrapBrackets: true, onProgress: p => progress.push(p) })
    expect(result).toEqual({ status: 'partial', sent: 1, total: 2, error: 'k - 包含房间屏蔽词' })
    expect(progress).toEqual([{ sent: 1, total: 2 }])
    expect(posted.filter(message => message.type === 'send')).toEqual([
      expect.objectContaining({ protocol: 1, roomId: 21452505, text: '主播晚上好', wrapBrackets: true }),
    ])
  })

  test('a repeated progress message keeps the send alive without notifying again', async () => {
    const { page } = createPage(
      announcing({ protocol: 1, version: '5.1.0', enabled: true }, (message, reply) => {
        for (const delay of [0, 30, 60, 90])
          setTimeout(() => reply({ type: 'progress', id: message.id, sent: 0, total: 2 }), delay)
        setTimeout(() => reply({ type: 'result', id: message.id, status: 'sent', sent: 2, total: 2 }), 120)
      })
    )
    const client = new ChatterboxClient({ target: page, timeoutMs: 50 })
    client.connect()
    await tick()
    const progress: unknown[] = []
    expect(await client.send(1, 'hi', { onProgress: p => progress.push(p) })).toEqual({
      status: 'sent',
      sent: 2,
      total: 2,
      error: undefined,
    })
    expect(progress).toEqual([{ sent: 0, total: 2 }])
  })

  test('gives up on a bridge that goes silent, keeping the last progress', async () => {
    const { page } = createPage(
      announcing({ protocol: 1, version: '5.1.0', enabled: true }, (message, reply) => {
        reply({ type: 'progress', id: message.id, sent: 1, total: 3 })
      })
    )
    const client = new ChatterboxClient({ target: page, timeoutMs: 50 })
    client.connect()
    await tick()
    expect(await client.send(1, 'hi')).toEqual({ status: 'no-response', sent: 1, total: 3 })
  })

  test('disconnecting settles sends in flight and forgets the bridge', async () => {
    const { page } = createPage(announcing({ protocol: 1, version: '5.1.0', enabled: true }))
    const client = new ChatterboxClient({ target: page })
    client.connect()
    await tick()
    const pending = client.send(1, 'hi')
    client.disconnect()
    expect(await pending).toEqual({ status: 'unavailable', sent: 0, total: 0 })
    expect(client.status).toBeNull()
  })
})
