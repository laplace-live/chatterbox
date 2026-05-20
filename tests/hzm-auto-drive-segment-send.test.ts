// Coverage for the segment-splitting send loop in `sendOne` (hzm-auto-drive.ts).
//
// Calls `_sendOneForTests` directly so each test exercises the segment loop
// deterministically without depending on the tick orchestration / picker /
// activity gate / rate limit. The mocks follow the same pattern as
// `hzm-auto-drive-lifecycle.test.ts`: per-file `mock.module` with `--isolate`
// so registries don't leak across test files.

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { LaplaceMemeWithSource } from '../src/lib/sbhzm-client'

const gmStore = new Map<string, unknown>()

mock.module('$', () => ({
  GM_addStyle: () => {},
  GM_deleteValue: (key: string) => {
    gmStore.delete(key)
  },
  GM_getValue: <T>(key: string, defaultValue: T): T => (gmStore.has(key) ? (gmStore.get(key) as T) : defaultValue),
  GM_info: { script: { version: 'test' } },
  GM_setValue: (key: string, value: unknown) => {
    gmStore.set(key, value)
  },
  GM_xmlhttpRequest: () => {},
  unsafeWindow: globalThis,
}))

let mockCsrfToken: string | null = 'csrf-fixture'

const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({
  ...realApi,
  ensureRoomId: async () => ROOM,
  getCsrfToken: () => mockCsrfToken,
}))

interface EnqueueCall {
  message: string
  roomId: number
  csrfToken: string
  priority: number
}

type EnqueueOutcome =
  | { kind: 'success' }
  | { kind: 'fail'; error: string }
  | { kind: 'cancelled'; error?: string }
  | { kind: 'throw'; err: Error }

const enqueueCalls: EnqueueCall[] = []
let scriptedOutcomes: EnqueueOutcome[] = []
let defaultOutcome: EnqueueOutcome = { kind: 'success' }

const realSendQueue = await import('../src/lib/send-queue')
mock.module('../src/lib/send-queue', () => ({
  ...realSendQueue,
  enqueueDanmaku: async (message: string, roomId: number, csrfToken: string, priority: number) => {
    enqueueCalls.push({ message, roomId, csrfToken, priority })
    const outcome: EnqueueOutcome = scriptedOutcomes.shift() ?? defaultOutcome
    if (outcome.kind === 'throw') throw outcome.err
    if (outcome.kind === 'success') {
      return { success: true, message, isEmoticon: false }
    }
    if (outcome.kind === 'cancelled') {
      return { success: false, message, isEmoticon: false, cancelled: true, error: outcome.error ?? 'preempted' }
    }
    return { success: false, message, isEmoticon: false, error: outcome.error }
  },
}))

const { _sendOneForTests } = await import('../src/lib/hzm-auto-drive')
const { logLines } = await import('../src/lib/log')
const { SendPriority } = await import('../src/lib/send-queue')
const { maxLength } = await import('../src/lib/store-send')
const { hzmDailyStatsByRoom, hzmDriveSendMode, hzmRecentSentByRoom } = await import('../src/lib/store-hzm')

// `appendLog` prepends a `HH:MM:SS ` timestamp to every line, so exact-string
// assertions need to ignore that prefix. These helpers strip it and compare
// only the message body.
const TS_RE = /^\d{2}:\d{2}:\d{2} /
function logBody(line: string | undefined): string | undefined {
  return line?.replace(TS_RE, '')
}
function findLogContaining(needle: string): string | undefined {
  return logLines.value.find(l => l.includes(needle))
}
function someLogBody(predicate: (body: string) => boolean): boolean {
  return logLines.value.some(l => predicate(l.replace(TS_RE, '')))
}

const ROOM = 1713546334

function meme(content: string): LaplaceMemeWithSource {
  return {
    id: -1,
    uid: 0,
    content,
    tags: [],
    copyCount: 0,
    lastCopiedAt: null,
    createdAt: '',
    updatedAt: '',
    username: null,
    avatar: null,
    room: null,
    _source: 'sbhzm',
  }
}

// 49 个字符；和生产里实际触发 "超出限制长度" 的那条一致。在 maxLength=38 下，
// splitTextSmart 会在第 36 位的逗号后切，得到 36+13 两段，都 ≤ 38。
const LONG_MEME = '灰泽满,我是中专老师,看你直播特别能理解你,我每次讲课就和你解说差不多,下面人各聊各的还经常开荒腔'

function recentList(): string[] {
  return hzmRecentSentByRoom.value[String(ROOM)] ?? []
}

function dailySent(): number {
  return hzmDailyStatsByRoom.value[String(ROOM)]?.sent ?? 0
}

beforeEach(() => {
  enqueueCalls.length = 0
  scriptedOutcomes = []
  defaultOutcome = { kind: 'success' }
  mockCsrfToken = 'csrf-fixture'
  // 这些用例断言"live(直接发)"档行为;新 hzmDriveSendMode 默认 'dry' 会短路到
  // appendLog + return,enqueueDanmaku 永远不会被调用。每个 case 显式启用 'live'。
  hzmDriveSendMode.value = 'live'
  hzmRecentSentByRoom.value = {}
  hzmDailyStatsByRoom.value = {}
  maxLength.value = 38
  logLines.value = []
})

afterEach(() => {
  // 清掉这次测试可能堆进 hzmRecentSentByRoom / hzmDailyStatsByRoom 的状态，
  // beforeEach 已经覆盖；这里仅作显式收尾。
  hzmRecentSentByRoom.value = {}
  hzmDailyStatsByRoom.value = {}
  logLines.value = []
})

describe('sendOne — single segment (no split)', () => {
  test('short meme → 1 enqueue, log without [n/m] tag, daily +1, recent +1', async () => {
    const m = meme('短梗一条') // 4 chars
    await _sendOneForTests(ROOM, m)

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0].message).toBe('短梗一条')
    expect(enqueueCalls[0].roomId).toBe(ROOM)
    expect(enqueueCalls[0].csrfToken).toBe('csrf-fixture')
    expect(enqueueCalls[0].priority).toBe(SendPriority.AUTO)

    expect(dailySent()).toBe(1)
    expect(recentList()).toEqual(['短梗一条'])

    const successLog = findLogContaining('🚗 智驾：')
    expect(successLog).toBeDefined()
    expect(logBody(successLog)).toBe('🚗 智驾：短梗一条')
    expect(successLog).not.toContain('[1/')
  })

  test('exactly maxLength → still single segment, no tag', async () => {
    // 38 字符 = 边界 (splitTextSmart 在 graphemes.length <= maxLen 时直接返回 [text])
    const exact = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八'
    expect([...exact].length).toBe(38)
    await _sendOneForTests(ROOM, meme(exact))

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0].message).toBe(exact)
    expect(someLogBody(b => b === `🚗 智驾：${exact}`)).toBe(true)
  })
})

describe('sendOne — multi-segment split', () => {
  test('49-char meme with commas → 2 segments at 36+13, both succeed', async () => {
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(2)
    // splitTextSmart 在第 36 位逗号后切（最后一个标点窗口内）
    expect(enqueueCalls[0].message).toBe('灰泽满,我是中专老师,看你直播特别能理解你,我每次讲课就和你解说差不多,')
    expect(enqueueCalls[1].message).toBe('下面人各聊各的还经常开荒腔')
    // 每片都 ≤ maxLength
    expect([...enqueueCalls[0].message].length).toBeLessThanOrEqual(38)
    expect([...enqueueCalls[1].message].length).toBeLessThanOrEqual(38)

    expect(dailySent()).toBe(2)
    // recent 只记原始整段一次
    expect(recentList()).toEqual([LONG_MEME])

    expect(someLogBody(b => b.startsWith('🚗 智驾：') && b.endsWith(' [1/2]'))).toBe(true)
    expect(someLogBody(b => b.startsWith('🚗 智驾：') && b.endsWith(' [2/2]'))).toBe(true)
  })

  test('priority is AUTO on every segment', async () => {
    await _sendOneForTests(ROOM, meme(LONG_MEME))
    expect(enqueueCalls).toHaveLength(2)
    expect(enqueueCalls.every(c => c.priority === SendPriority.AUTO)).toBe(true)
    expect(enqueueCalls.every(c => c.csrfToken === 'csrf-fixture')).toBe(true)
    expect(enqueueCalls.every(c => c.roomId === ROOM)).toBe(true)
  })
})

describe('sendOne — failure handling', () => {
  test('first segment of multi fails → stop loop, no recent/daily, fail log carries [1/2]', async () => {
    scriptedOutcomes = [{ kind: 'fail', error: '超出限制长度' }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    // 第一片失败就 break；不再发后续片
    expect(enqueueCalls).toHaveLength(1)
    expect(dailySent()).toBe(0)
    expect(recentList()).toEqual([])

    const failLog = findLogContaining('❌ 智驾发送失败：')
    expect(failLog).toBeDefined()
    expect(failLog).toContain('[1/2]')
    expect(failLog).toContain('原因：超出限制长度')
  })

  test('second segment fails → 1 success + 1 fail; recent +1, daily +1, fail log carries [2/2]', async () => {
    scriptedOutcomes = [{ kind: 'success' }, { kind: 'fail', error: 'k' }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(2)
    expect(dailySent()).toBe(1)
    expect(recentList()).toEqual([LONG_MEME])

    expect(someLogBody(b => b.startsWith('🚗 智驾：') && b.endsWith(' [1/2]'))).toBe(true)
    const failLog = findLogContaining('❌ 智驾发送失败：')
    expect(failLog).toBeDefined()
    expect(failLog).toContain('[2/2]')
    expect(failLog).toContain('原因：k')
  })

  test('single-segment failure → fail log has NO [n/m] tag', async () => {
    scriptedOutcomes = [{ kind: 'fail', error: 'f' }]
    await _sendOneForTests(ROOM, meme('短梗一条'))

    expect(enqueueCalls).toHaveLength(1)
    expect(dailySent()).toBe(0)
    expect(recentList()).toEqual([])

    const failLog = findLogContaining('❌ 智驾发送失败：')
    expect(failLog).toBeDefined()
    expect(failLog).not.toContain('[1/')
    expect(logBody(failLog)).toBe('❌ 智驾发送失败：短梗一条，原因：f')
  })

  test('failure with undefined error → falls back to "未知"', async () => {
    scriptedOutcomes = [{ kind: 'fail', error: undefined as unknown as string }]
    await _sendOneForTests(ROOM, meme('短梗一条'))

    const failLog = findLogContaining('❌ 智驾发送失败：')
    expect(logBody(failLog)).toBe('❌ 智驾发送失败：短梗一条，原因：未知')
  })
})

describe('sendOne — cancelled handling', () => {
  test('first segment cancelled → no recent, no daily, cancelled log carries [1/2]', async () => {
    scriptedOutcomes = [{ kind: 'cancelled' }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(1)
    expect(dailySent()).toBe(0)
    expect(recentList()).toEqual([])

    const cancelLog = findLogContaining('⏭ 智驾被打断：')
    expect(cancelLog).toBeDefined()
    expect(cancelLog).toContain('[1/2]')
  })

  test('second segment cancelled → 1 success + 1 cancelled; recent +1, daily +1', async () => {
    scriptedOutcomes = [{ kind: 'success' }, { kind: 'cancelled' }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(2)
    expect(dailySent()).toBe(1)
    expect(recentList()).toEqual([LONG_MEME])

    expect(someLogBody(b => b.startsWith('🚗 智驾：') && b.endsWith(' [1/2]'))).toBe(true)
    const cancelLog = findLogContaining('⏭ 智驾被打断：')
    expect(cancelLog).toBeDefined()
    expect(cancelLog).toContain('[2/2]')
  })

  test('single-segment cancelled → cancelled log has NO tag', async () => {
    scriptedOutcomes = [{ kind: 'cancelled' }]
    await _sendOneForTests(ROOM, meme('短梗一条'))

    const cancelLog = findLogContaining('⏭ 智驾被打断：')
    expect(logBody(cancelLog)).toBe('⏭ 智驾被打断：短梗一条')
  })
})

describe('sendOne — exception handling', () => {
  test('enqueue throws on first segment → outer catch logs 异常, no recent/daily', async () => {
    scriptedOutcomes = [{ kind: 'throw', err: new Error('network down') }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(1)
    expect(dailySent()).toBe(0)
    expect(recentList()).toEqual([])

    const exLog = findLogContaining('❌ 智驾发送异常：')
    expect(exLog).toBeDefined()
    expect(exLog).toContain('network down')
    // No success log; no segment fail log (path goes straight to catch)
    expect(findLogContaining('❌ 智驾发送失败：')).toBeUndefined()
  })

  test('enqueue throws on second segment → first segment side-effects committed, exception logged', async () => {
    scriptedOutcomes = [{ kind: 'success' }, { kind: 'throw', err: new Error('boom') }]
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(2)
    // First segment succeeded before the throw, so its side effects landed
    expect(dailySent()).toBe(1)
    expect(recentList()).toEqual([LONG_MEME])

    expect(someLogBody(b => b.startsWith('🚗 智驾：') && b.endsWith(' [1/2]'))).toBe(true)
    const exLog = findLogContaining('❌ 智驾发送异常：')
    expect(exLog).toBeDefined()
    expect(exLog).toContain('boom')
  })

  test('non-Error throw value → String(err) used in log', async () => {
    scriptedOutcomes = [{ kind: 'throw', err: 'plain-string-error' as unknown as Error }]
    await _sendOneForTests(ROOM, meme('短梗一条'))

    const exLog = findLogContaining('❌ 智驾发送异常：')
    expect(logBody(exLog)).toBe('❌ 智驾发送异常：plain-string-error')
  })
})

describe('sendOne — recent dedup behaviour', () => {
  test('sending same multi-segment meme twice → recent list still has only one entry', async () => {
    await _sendOneForTests(ROOM, meme(LONG_MEME))
    expect(recentList()).toEqual([LONG_MEME])
    // 配置默认 outcome 还是 success；再发一遍同条
    await _sendOneForTests(ROOM, meme(LONG_MEME))
    // pushRecentSent 会 filter 掉重复再 push，所以列表里仍只有一条原始内容
    expect(recentList()).toEqual([LONG_MEME])
    // 但每片都计入了 daily
    expect(dailySent()).toBe(4) // 2 段 × 2 次
    expect(enqueueCalls).toHaveLength(4)
  })

  test('two different memes → recent list keeps both, in send order', async () => {
    await _sendOneForTests(ROOM, meme('梗一'))
    await _sendOneForTests(ROOM, meme('梗二'))
    expect(recentList()).toEqual(['梗一', '梗二'])
  })
})

describe('sendOne — pre-existing branches still work after refactor', () => {
  test('sendMode=dry → no enqueue, recent +1, no daily bump (dry branch is before the loop)', async () => {
    hzmDriveSendMode.value = 'dry'
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(0)
    // dryRun pushes recent with original meme content
    expect(recentList()).toEqual([LONG_MEME])
    // dryRun does not bump daily
    expect(dailySent()).toBe(0)
    expect(findLogContaining('🚗[试运行] 智驾候选：')).toBeDefined()
  })

  test('no csrf token → no enqueue, no recent, no daily, pause notice logged', async () => {
    mockCsrfToken = null
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(0)
    expect(recentList()).toEqual([])
    expect(dailySent()).toBe(0)
    expect(findLogContaining('未找到登录信息')).toBeDefined()
  })
})

describe('sendOne — maxLength signal is read fresh', () => {
  test('reducing maxLength to 10 splits the same meme into more chunks', async () => {
    maxLength.value = 10
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    // 49 chars / 10 maxLen → at least 5 chunks
    expect(enqueueCalls.length).toBeGreaterThanOrEqual(5)
    // 每片仍 ≤ maxLength
    for (const call of enqueueCalls) {
      expect([...call.message].length).toBeLessThanOrEqual(10)
    }
    expect(dailySent()).toBe(enqueueCalls.length)
    expect(recentList()).toEqual([LONG_MEME])

    const total = enqueueCalls.length
    expect(someLogBody(b => b.endsWith(` [1/${total}]`))).toBe(true)
    expect(someLogBody(b => b.endsWith(` [${total}/${total}]`))).toBe(true)
  })

  test('raising maxLength above content length → single segment, no tag', async () => {
    maxLength.value = 100
    await _sendOneForTests(ROOM, meme(LONG_MEME))

    expect(enqueueCalls).toHaveLength(1)
    expect(enqueueCalls[0].message).toBe(LONG_MEME)
    const successLog = findLogContaining('🚗 智驾：')
    expect(logBody(successLog)).toBe(`🚗 智驾：${LONG_MEME}`)
    expect(successLog).not.toContain('[1/')
  })
})
