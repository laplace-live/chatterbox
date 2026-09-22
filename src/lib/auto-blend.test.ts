import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { DanmakuEvent, DanmakuSubscription } from './danmaku-stream'

import * as blacklist from './message-blacklist'
import * as utils from './utils'

interface Decision {
  send: boolean
  reason: string
}

const source = await Bun.file(new URL('./auto-blend.ts', import.meta.url)).text()
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const cleanups: (() => void)[] = []
let moduleId = 0

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

async function createHarness() {
  const { signal } = signals
  const settings = {
    autoBlendAvoidRepeat: signal(true),
    autoBlendAvoidRepeatCount: signal(5),
    autoBlendCooldownAuto: signal(false),
    autoBlendCooldownSec: signal(2),
    autoBlendEnabled: signal(true),
    autoBlendMessageBlacklist: signal<Record<string, string>>({}),
    autoBlendMinOccurrences: signal(3),
    autoBlendRandomDrop: signal(false),
    autoBlendRandomDropPercent: signal(100),
    autoBlendUniqueUsers: signal(2),
    autoBlendUseReplacements: signal(false),
    autoBlendUserBlacklist: signal<Record<string, string>>({}),
    autoBlendWindowSec: signal(30),
    autoBlendYolo: signal(false),
    invisibleChar: signal('\u200b'),
    maxLength: signal(100),
    randomChar: signal(false),
    randomColor: signal(false),
  }
  const decisionSettings = { autoBlendDecisionEnabled: signal(true) }
  const decide = mock(async (_text: string, _context: string[], _signal?: AbortSignal): Promise<Decision> => {
    return { send: true, reason: '符合当前判断规则' }
  })
  const polish = mock(async (_slot: string, text: string, _options?: { signal?: AbortSignal }) => `${text}！`)
  const enqueue = mock(async (_text: string, _room: string, _csrf: string, _priority: number) => ({
    isEmoticon: false,
    code: 0,
  }))
  const log = mock((..._args: unknown[]) => {})
  const emotes = new Map<string, string>()
  const locked = new Set<string>()
  const unavailable = new Set<string>()
  let subscriber: DanmakuSubscription | undefined
  let tick: (() => void) | undefined
  let now = 10_000
  const dependencies = {
    '@preact/signals': signals,
    './api': {
      ensureRoomId: async () => '42',
      getCsrfToken: () => 'csrf',
      getDedeUid: () => 'self',
      setRandomDanmakuColor: async () => {},
    },
    './danmaku-stream': {
      subscribeDanmaku: (subscription: DanmakuSubscription) => {
        subscriber = subscription
        return () => {
          subscriber = undefined
        }
      },
    },
    './decision-settings': decisionSettings,
    './decision-tasks': { decideAutoBlendCandidate: decide },
    './emoticon': {
      findEmoticon: (text: string) => (emotes.has(text) ? { emoji: emotes.get(text) } : null),
      isLockedEmoticon: (text: string) => locked.has(text),
      isUnavailableEmoticon: (text: string) => unavailable.has(text),
      formatLockedEmoticonReject: (text: string) => `locked: ${text}`,
      formatUnavailableEmoticonReject: (text: string) => `unavailable: ${text}`,
    },
    './llm-tasks': { isLlmReady: () => true, polishWithLlm: polish },
    './log': { appendLog: log },
    './message-blacklist': blacklist,
    './replacement': { applyReplacements: (text: string) => text },
    './send-queue': { enqueueDanmaku: enqueue, SendPriority: { AUTO: 1 } },
    './store': settings,
    './utils': utils,
    clock: {
      Date: { now: () => now },
      setInterval: (callback: () => void) => {
        tick = callback
        return 1
      },
      clearInterval: () => {
        tick = undefined
      },
    },
  }
  const key = `__autoBlendTest${++moduleId}`
  const globals = globalThis as unknown as Record<string, unknown>
  globals[key] = dependencies
  // Each module gets isolated imports without changing Bun's shared module cache.
  const injected = source.replace(/import\s+\{([^}]+)\}\s+from\s+'([^']+)'/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}][${JSON.stringify(path)}]`
  })
  const clock = `const { Date, setInterval, clearInterval } = globalThis[${JSON.stringify(key)}].clock\n`
  let engine: typeof import('./auto-blend')
  try {
    const code = transpiler.transformSync(clock + injected)
    engine = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  } finally {
    delete globals[key]
  }
  cleanups.push(() => engine.stopAutoBlend())
  engine.startAutoBlend()

  function message(text: string, uid: string | null = 'viewer-1', extra: Partial<DanmakuEvent> = {}) {
    subscriber?.onMessage?.({
      node: {} as HTMLElement,
      text,
      uid,
      uname: 'private-viewer-name',
      isReply: false,
      hasLargeEmote: false,
      ...extra,
    })
  }

  function qualify(text = '好耶') {
    message(text, 'viewer-1')
    message(text, 'viewer-1')
    message(text, 'viewer-2')
  }

  return {
    engine,
    settings,
    decisionSettings,
    decide,
    polish,
    enqueue,
    log,
    emotes,
    locked,
    unavailable,
    message,
    qualify,
    advance: (ms: number) => {
      now += ms
      tick?.()
    },
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('automatic blend decision gate', () => {
  test('waits for both occurrence and distinct-user thresholds', async () => {
    const h = await createHarness()
    h.message('好耶')
    h.message('好耶')
    h.message('好耶')
    await flush()
    expect(h.decide).not.toHaveBeenCalled()
    h.message('好耶', 'viewer-2')
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.enqueue).toHaveBeenCalledTimes(1)
  })

  test('makes one decision for a qualified burst and sends only after approval', async () => {
    const h = await createHarness()
    const pending = Promise.withResolvers<Decision>()
    h.decide.mockImplementation(() => pending.promise)
    h.settings.autoBlendCooldownSec.value = 0
    h.qualify()
    await flush()
    for (let i = 0; i < 10; i++) h.qualify()
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.decisionPending.value).toBe(true)
    pending.resolve({ send: true, reason: '可以发送' })
    await flush()
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('好耶')
    expect(h.engine.decisionPending.value).toBe(false)
  })

  test('disabled decision gate keeps the existing send path', async () => {
    const h = await createHarness()
    h.decisionSettings.autoBlendDecisionEnabled.value = false
    h.qualify()
    await flush()
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.enqueue).toHaveBeenCalledTimes(1)
  })

  test('rejection blocks both polishing and sending, with cooldown and trend deduplication', async () => {
    const h = await createHarness()
    h.settings.autoBlendYolo.value = true
    h.decide.mockResolvedValue({ send: false, reason: '不符合判断规则' })
    h.qualify()
    await flush()
    h.qualify('另一个趋势')
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.polish).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
    h.advance(2001)
    h.qualify()
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(1)
    h.qualify('另一个趋势')
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(2)
  })

  test('a failed decision never bypasses the gate', async () => {
    const h = await createHarness()
    h.settings.autoBlendYolo.value = true
    h.decide.mockRejectedValue(new Error('请求超时'))
    h.qualify()
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(1)
    expect(h.polish).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.decisionPending.value).toBe(false)
  })

  test('polishes the approved original candidate before queueing', async () => {
    const h = await createHarness()
    const pending = Promise.withResolvers<Decision>()
    h.settings.autoBlendYolo.value = true
    h.decide.mockImplementation(() => pending.promise)
    h.qualify()
    await flush()
    expect(h.polish).not.toHaveBeenCalled()
    expect(h.decide.mock.calls[0]?.[0]).toBe('好耶')
    pending.resolve({ send: true, reason: '可以发送' })
    await flush()
    expect(h.polish).toHaveBeenCalledWith('autoBlend', '好耶', { signal: h.decide.mock.calls[0]?.[2] })
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('好耶！')
  })

  test('existing filters and random drops run before any model request', async () => {
    const h = await createHarness()
    h.settings.autoBlendMessageBlacklist.value = { 屏蔽文本: '' }
    h.settings.autoBlendUserBlacklist.value = { 'blocked-user': '' }
    h.locked.add('locked-emote')
    h.unavailable.add('unavailable-emote')
    for (const text of ['屏蔽文本', 'locked-emote', 'unavailable-emote']) h.qualify(text)
    for (let i = 0; i < 5; i++) {
      h.message('自己的消息', 'self')
      h.message('用户黑名单', 'blocked-user')
      h.message('回复消息', `viewer-${i}`, { isReply: true })
      h.message('大表情', `viewer-${i}`, { hasLargeEmote: true })
    }
    h.settings.autoBlendRandomDrop.value = true
    h.qualify('随机丢弃')
    await flush()
    expect(h.decide).not.toHaveBeenCalled()
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  test('provides bounded text context without sender metadata', async () => {
    const h = await createHarness()
    for (let i = 0; i < 80; i++) h.message(`上下文 ${i}`, `private-uid-${i}`)
    h.qualify()
    await flush()
    const context = h.decide.mock.calls[0]?.[1]
    expect(context).toBeDefined()
    expect(context?.length).toBeGreaterThan(0)
    expect(context?.length).toBeLessThanOrEqual(50)
    expect(context?.every(text => typeof text === 'string')).toBe(true)
    expect(JSON.stringify(context)).not.toContain('private-uid')
    expect(JSON.stringify(context)).not.toContain('private-viewer-name')
  })

  test('evaluates an emote display name while preserving its sendable ID', async () => {
    const h = await createHarness()
    h.settings.autoBlendYolo.value = true
    h.emotes.set('room_42_7', '好耶')
    h.qualify('room_42_7')
    await flush()
    expect(h.decide.mock.calls[0]?.[0]).toBe('好耶')
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('room_42_7')
    expect(h.polish).not.toHaveBeenCalled()
  })

  test('stopping aborts a pending decision and ignores late approval', async () => {
    const h = await createHarness()
    const pending = Promise.withResolvers<Decision>()
    h.decide.mockImplementation(() => pending.promise)
    h.qualify()
    await flush()
    const signal = h.decide.mock.calls[0]?.[2]
    h.engine.stopAutoBlend()
    expect(signal?.aborted).toBe(true)
    expect(h.engine.decisionPending.value).toBe(false)
    pending.resolve({ send: true, reason: '过期结果' })
    await flush()
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  test('stopping during polishing cannot send an already approved candidate', async () => {
    const h = await createHarness()
    const pending = Promise.withResolvers<string>()
    h.settings.autoBlendYolo.value = true
    h.polish.mockImplementation(() => pending.promise)
    h.qualify()
    await flush()
    expect(h.polish).toHaveBeenCalledTimes(1)
    const signal = h.polish.mock.calls[0]?.[2]?.signal
    h.engine.stopAutoBlend()
    expect(signal?.aborted).toBe(true)
    pending.resolve('停止之后的润色结果')
    await flush()
    expect(h.enqueue).not.toHaveBeenCalled()
  })

  test('an old request cannot clear or send during a restarted pending request', async () => {
    const h = await createHarness()
    const oldDecision = Promise.withResolvers<Decision>()
    const newDecision = Promise.withResolvers<Decision>()
    h.settings.autoBlendCooldownSec.value = 0
    h.decide.mockImplementationOnce(() => oldDecision.promise).mockImplementationOnce(() => newDecision.promise)
    h.qualify('旧趋势')
    await flush()
    h.engine.stopAutoBlend()
    h.engine.startAutoBlend()
    h.qualify('新趋势')
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(2)
    oldDecision.resolve({ send: true, reason: '过期结果' })
    await flush()
    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.decisionPending.value).toBe(true)
    h.qualify('第三个趋势')
    await flush()
    expect(h.decide).toHaveBeenCalledTimes(2)
    newDecision.resolve({ send: true, reason: '当前结果' })
    await flush()
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.enqueue.mock.calls[0]?.[0]).toBe('新趋势')
    expect(h.engine.decisionPending.value).toBe(false)
  })
})
