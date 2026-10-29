import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { SendDanmakuResult } from './api'
import type { DanmakuEvent } from './danmaku-stream'

import { isRecord } from './utils'

type HarnessEvent = Omit<DanmakuEvent, 'node'>
type HarnessSubscription = { onMessage?: (event: HarnessEvent) => void }

const source = await Bun.file(new URL('./ai-chat.ts', import.meta.url)).text()
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const cleanups: (() => void)[] = []
let moduleId = 0

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

async function createHarness() {
  const { signal } = signals
  const settings = {
    activeLlmProvider: signal('test'),
    aiChatAutoSend: signal(false),
    aiChatContextMaxChars: signal(2000),
    aiChatMaxMessageLength: signal(100),
    aiChatTemperature: signal(1),
    aiChatViewerInterval: signal(1),
    aiChatViewerWindow: signal(10),
    sttEndpointReached: signal(false),
    sttTranscriptBuffer: signal(''),
  }
  const enqueue = mock(
    async (
      message: string,
      _roomId: number,
      _csrf: string,
      _priority: number,
      _source: string,
      guard?: () => boolean
    ): Promise<SendDanmakuResult> =>
      guard && !guard()
        ? { success: false, cancelled: true, message, isEmoticon: false }
        : { success: true, message, isEmoticon: false }
  )
  let subscriber: HarnessSubscription | undefined
  let now = 10_000
  const schedule = mock((_callback: () => void, _delay: number) => 1)
  const dependencies = {
    '@preact/signals': signals,
    './api': { ensureRoomId: async () => 42, getCsrfToken: () => 'csrf' },
    './copy-ninja/settings': { isCopyNinjaMember: () => false },
    './danmaku-stream': {
      subscribeDanmaku: (subscription: HarnessSubscription) => {
        subscriber = subscription
        return () => {
          subscriber = undefined
        }
      },
    },
    './llm': { chatCompletion: async () => '{}' },
    './llm-tasks': { isLlmReady: () => true },
    './log': { appendLog: () => {} },
    './prompts': { getActiveLlmPrompt: () => '' },
    './send-queue': { enqueueDanmaku: enqueue, SendPriority: { AUTO: 0 } },
    './store': settings,
    './utils': { isRecord },
    clock: { Date: { now: () => now }, setTimeout: schedule, clearTimeout: () => {} },
  }
  const key = `__aiChatTest${++moduleId}`
  Reflect.set(globalThis, key, dependencies)
  const js = transpiler.transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}];`
  })
  const clock = `const { Date, setTimeout, clearTimeout } = globalThis[${JSON.stringify(key)}].clock;\n`
  let engine: typeof import('./ai-chat')
  try {
    engine = await import(`data:text/javascript;base64,${Buffer.from(clock + injected).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
  cleanups.push(() => engine.stopAiChatEngine())
  engine.startAiChatEngine()

  async function send(text = '好耶') {
    engine.pendingCandidates.value = [
      { id: 1, transcript: '', decision: { send: true, message: text, reason: '' }, createdAt: now },
    ]
    engine.acceptCandidate(1)
    await flush()
  }

  function message(text = '好耶') {
    subscriber?.onMessage?.({ text, uid: 'viewer', uname: '观众', isReply: false, hasLargeEmote: false })
  }

  function restart() {
    engine.stopAiChatEngine()
    engine.startAiChatEngine()
  }

  function deferSend(dispatchImmediately = true) {
    const pending = Promise.withResolvers<SendDanmakuResult>()
    let allowed: boolean | undefined
    let dispatch = (): boolean => {
      throw new Error('Send has not been queued')
    }
    enqueue.mockImplementationOnce((message, _room, _csrf, _priority, _source, guard) => {
      dispatch = () => {
        if (allowed !== undefined) throw new Error('Send already dispatched')
        allowed = guard?.() ?? true
        if (!allowed) pending.resolve({ success: false, cancelled: true, message, isEmoticon: false })
        return allowed
      }
      if (dispatchImmediately) dispatch()
      return pending.promise
    })
    return { resolve: pending.resolve, dispatch: () => dispatch(), wasAllowed: () => allowed }
  }

  return { engine, enqueue, schedule, send, message, restart, deferSend, advance: (ms: number) => (now += ms) }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('AI chat echo markers across restarts', () => {
  test('ignores an in-flight send echo before and after the send completes', async () => {
    const h = await createHarness()
    const pending = h.deferSend()
    await h.send()
    expect(pending.wasAllowed()).toBe(true)

    h.restart()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)
    expect(h.schedule).not.toHaveBeenCalled()

    pending.resolve({ success: true, message: '好耶', isEmoticon: false })
    await flush()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)
    expect(h.engine.aiChatHistory.value).toEqual([])
    h.message('另一条观众弹幕')
    expect(h.engine.aiChatViewerCount.value).toBe(1)
    expect(h.schedule).toHaveBeenCalledTimes(1)
  })

  test('keeps completed send markers until their original expiry without refreshing on restart', async () => {
    const h = await createHarness()
    await h.send()
    h.advance(20_000)
    h.restart()
    h.advance(10_000)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)

    h.advance(1)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)
  })

  test('accepts viewer text after its matching send expired while stopped', async () => {
    const h = await createHarness()
    await h.send()
    h.engine.stopAiChatEngine()
    h.advance(30_001)
    h.engine.startAiChatEngine()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)
  })

  test('keeps markers after a send completes with an unknown outcome', async () => {
    const h = await createHarness()
    const pending = h.deferSend()
    await h.send()
    h.restart()
    pending.resolve({ success: false, message: '好耶', isEmoticon: false, error: 'network error' })
    await flush()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)
  })

  for (const outcome of ['cancelled', 'rejected'] as const) {
    test(`removes a ${outcome} send marker after restart`, async () => {
      const h = await createHarness()
      const pending = h.deferSend()
      await h.send()
      h.restart()
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(0)

      pending.resolve({ success: false, message: '好耶', isEmoticon: false, [outcome]: true })
      await flush()
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(1)
    })

    test(`a ${outcome} old send cannot remove a newer marker for the same text`, async () => {
      const h = await createHarness()
      const pending = h.deferSend()
      await h.send()
      h.restart()
      await h.send()

      pending.resolve({ success: false, message: '好耶', isEmoticon: false, [outcome]: true })
      await flush()
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(0)
      expect(h.schedule).not.toHaveBeenCalled()
    })
  }

  test('a queued send cancelled by restart never filters viewer text', async () => {
    const h = await createHarness()
    const pending = h.deferSend(false)
    await h.send()
    expect(pending.wasAllowed()).toBeUndefined()
    h.restart()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)

    expect(pending.dispatch()).toBe(false)
    await flush()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(2)
  })

  test('starts the echo expiry at dispatch after a long queue wait', async () => {
    const h = await createHarness()
    const pending = h.deferSend(false)
    await h.send()
    h.advance(30_001)
    expect(pending.dispatch()).toBe(true)
    h.restart()
    h.advance(30_000)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)

    h.advance(1)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)
    pending.resolve({ success: true, message: '好耶', isEmoticon: false })
    await flush()
  })

  for (const outcome of ['cancelled', 'rejected'] as const) {
    test(`a ${outcome} newer send preserves the older same-text send until its original expiry`, async () => {
      const h = await createHarness()
      await h.send()
      h.advance(20_000)
      h.restart()
      const pending = h.deferSend()
      await h.send()
      pending.resolve({ success: false, message: '好耶', isEmoticon: false, [outcome]: true })
      await flush()
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(0)

      h.advance(10_000)
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(0)
      h.advance(1)
      h.message()
      expect(h.engine.aiChatViewerCount.value).toBe(1)
    })
  }

  test('identical sends expire independently and rejecting the newer one does not revive the older one', async () => {
    const h = await createHarness()
    await h.send()
    h.advance(20_000)
    const pending = h.deferSend()
    await h.send()
    h.restart()
    h.advance(10_001)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(0)

    pending.resolve({ success: false, message: '好耶', isEmoticon: false, rejected: true })
    await flush()
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)
  })

  test('caps retained sends even when their texts are identical', async () => {
    const h = await createHarness()
    await h.send('最早的弹幕')
    for (let i = 0; i < 64; i++) await h.send()
    h.restart()
    h.message('最早的弹幕')
    expect(h.engine.aiChatViewerCount.value).toBe(1)
    h.message()
    expect(h.engine.aiChatViewerCount.value).toBe(1)
  })
})
