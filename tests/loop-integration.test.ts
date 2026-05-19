/**
 * Integration coverage for `src/lib/loop.ts` — the auto-send (独轮车) main
 * loop. The function is a never-returning `while (true)` so we exercise it
 * by:
 *   1. Mocking all heavy dependencies (api, send-queue, send-verification,
 *      llm-polish, wbi, …) so each tick completes in ~ms.
 *   2. Starting `void loop()` and toggling `sendMsg.value` to drive specific
 *      branches.
 *   3. Calling `cancelLoop()` between scenarios so the inner abortable sleep
 *      yields control immediately.
 *   4. Bounding every wait with `setTimeout` so the test exits even though
 *      the underlying promise stays unresolved.
 *
 * Branches we lock down:
 *   - sendMsg=false → else branch (count reset, 1s sleep).
 *   - sendMsg=true + ensureRoomId throws → "获取房间ID失败" log + 5s sleep.
 *   - sendMsg=true + getCsrfToken=null → "未找到登录信息" + guardRoom risk
 *      event + sendMsg auto-stop.
 *   - sendMsg=true + empty template → "当前模板为空" + sendMsg auto-stop.
 *   - sendMsg=true + happy path → enqueueDanmaku is called, appendLog gets
 *      the message, verifyBroadcast is fired on success.
 *   - sendMsg=true + autoSendYolo on with config gap → "YOLO 配置不完整" stop.
 *   - sendMsg=true + autoSendYolo on with empty result → skip log + continue.
 *   - sendMsg=true + autoSendYolo throws → skip log + continue.
 *   - cancelLoop in idle state (currentAbort null) → no throw.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGm } = installGmStoreMock()

// ---------------------------------------------------------------------------
// Track-everything bookkeeping
// ---------------------------------------------------------------------------

const logged: unknown[][] = []
const enqueueCalls: Array<{ msg: string; roomId: number; csrfToken: string }> = []
const verifyCalls: Array<{ text: string; label: string }> = []
const guardRoomCalls: Array<{ kind: string; source: string }> = []
const cancelPendingCalls: number[] = []
let ensureRoomIdResult: number | Error = 1234
let csrfReturn: string | null = 'csrf-fixture'
let enqueueResult = {
  success: true,
  message: '',
  isEmoticon: false,
  startedAt: 1,
  cancelled: false,
  error: '',
  errorCode: 0,
  errorData: null as unknown,
}
let yoloOutcome: 'gap' | 'ok' | 'empty' | 'throw' = 'ok'
let yoloOut = '哥哥厉害'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({
  ...realApi,
  ensureRoomId: async () => {
    if (ensureRoomIdResult instanceof Error) throw ensureRoomIdResult
    return ensureRoomIdResult
  },
  getCsrfToken: () => csrfReturn,
  fetchEmoticons: async () => {},
  setDanmakuMode: async () => {},
  setRandomDanmakuColor: async () => {},
}))

const realWbi = await import('../src/lib/wbi')
let wbiCachedSeed: { img_key: string; sub_key: string } | null = null
mock.module('../src/lib/wbi', () => ({
  ...realWbi,
  // Apply the seed eagerly: `_setCachedWbiKeysForTests` writes the same
  // internal binding that `getCachedWbiKeys()` reads in production.
  waitForWbiKeys: async () => {
    if (wbiCachedSeed) realWbi._setCachedWbiKeysForTests(wbiCachedSeed)
    return realWbi.getCachedWbiKeys() !== null
  },
  encodeWbi: () => 'mock-wbi-query',
}))

const realSendQueue = await import('../src/lib/send-queue')
mock.module('../src/lib/send-queue', () => ({
  ...realSendQueue,
  enqueueDanmaku: async (msg: string, roomId: number, csrfToken: string) => {
    enqueueCalls.push({ msg, roomId, csrfToken })
    return { ...enqueueResult, message: msg }
  },
  cancelPendingAuto: () => {
    cancelPendingCalls.push(Date.now())
  },
}))

const realSendVerification = await import('../src/lib/send-verification')
mock.module('../src/lib/send-verification', () => ({
  ...realSendVerification,
  verifyBroadcast: async (args: { text: string; label: string }) => {
    verifyCalls.push({ text: args.text, label: args.label })
  },
}))

mock.module('../src/lib/log', () => ({
  appendLog: (...args: unknown[]) => {
    logged.push(args)
  },
  appendLogQuiet: () => {},
  notifyUser: () => {},
  isDebugLogging: () => false,
}))

const realGuardRoomSync = await import('../src/lib/guard-room-sync')
mock.module('../src/lib/guard-room-sync', () => ({
  ...realGuardRoomSync,
  classifyRiskEvent: () => ({ kind: 'login_missing', level: 'observe', advice: '' }),
  syncGuardRoomRiskEvent: async (ev: { kind: string; source: string }) => {
    guardRoomCalls.push(ev)
  },
}))

const realReplacement = await import('../src/lib/replacement')
mock.module('../src/lib/replacement', () => ({
  ...realReplacement,
  applyReplacements: (s: string) => s,
  buildReplacementMap: () => {},
}))

let lockedSet = new Set<string>()
let unavailableSet = new Set<string>()
const realEmoticon = await import('../src/lib/emoticon')
mock.module('../src/lib/emoticon', () => ({
  ...realEmoticon,
  isEmoticonUnique: () => false,
  isLockedEmoticon: (s: string) => lockedSet.has(s),
  isUnavailableEmoticon: (s: string) => unavailableSet.has(s),
  formatLockedEmoticonReject: (s: string, lbl: string) => `LOCKED:${lbl}:${s}`,
  formatUnavailableEmoticonReject: (s: string, lbl: string) => `UNAVAIL:${lbl}:${s}`,
}))

const realLlmPolish = await import('../src/lib/llm-polish')
mock.module('../src/lib/llm-polish', () => ({
  ...realLlmPolish,
  describeLlmGap: () => (yoloOutcome === 'gap' ? '未配置' : null),
  polishWithLlm: async () => {
    if (yoloOutcome === 'throw') throw new Error('yolo-broke')
    if (yoloOutcome === 'empty') return '   '
    return yoloOut
  },
}))

// Provide a minimal document for getSpmPrefix. By default querySelector
// returns null (the fallback '444.8' is used); a test that wants to exercise
// the meta-tag branch can swap `metaSpmContent`.
let metaSpmContent: string | null = null
const realDocument = (globalThis as { document?: unknown }).document
beforeAll(() => {
  ;(globalThis as { document: { querySelector: (s: string) => unknown } }).document = {
    querySelector: (sel: string) => {
      if (sel.includes('spm_prefix') && metaSpmContent !== null) {
        return { getAttribute: () => metaSpmContent }
      }
      return null
    },
  }
})
afterAll(() => {
  ;(globalThis as { document?: unknown }).document = realDocument
})

// fetch mock for the WBI-init config call.
let configFetchResp: unknown = {
  data: {
    group: [
      {
        color: [
          { status: 1, color_hex: 'aabbcc' },
          { status: 0, color_hex: '111111' }, // status 0 → excluded
          { status: 1, color_hex: 'ddeeff' },
        ],
      },
    ],
  },
}
let configFetchShouldThrow = false
const realFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = (async () => {
    if (configFetchShouldThrow) throw new Error('config-fetch-failed')
    return new Response(JSON.stringify(configFetchResp), { status: 200 }) as unknown as Response
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const { cancelLoop, loop } = await import('../src/lib/loop')
const store = await import('../src/lib/store')

// ---------------------------------------------------------------------------
// Helpers — single loop runner that yields after each event-loop turn.
// ---------------------------------------------------------------------------

let _loopStarted = false

/** Kick off the long-lived loop exactly once across the file. */
function ensureLoopRunning(): void {
  if (_loopStarted) return
  _loopStarted = true
  // Fire and forget — we never await the returned promise.
  void loop()
}

/** Sleep N ms via real setTimeout (bypasses any module-level fakery). */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(() => {
  logged.length = 0
  enqueueCalls.length = 0
  verifyCalls.length = 0
  guardRoomCalls.length = 0
  cancelPendingCalls.length = 0
  ensureRoomIdResult = 1234
  csrfReturn = 'csrf-fixture'
  enqueueResult = {
    success: true,
    message: '',
    isEmoticon: false,
    startedAt: 1,
    cancelled: false,
    error: '',
    errorCode: 0,
    errorData: null,
  }
  yoloOutcome = 'ok'
  yoloOut = '哥哥厉害'
  lockedSet = new Set<string>()
  unavailableSet = new Set<string>()
  wbiCachedSeed = null
  realWbi._resetCachedWbiKeysForTests()
  metaSpmContent = null
  configFetchShouldThrow = false
  resetGm()
  store.sendMsg.value = false
  store.msgSendInterval.value = 0.1
  store.maxLength.value = 100
  store.activeTemplateIndex.value = 0
  store.randomColor.value = false
  store.randomInterval.value = false
  store.randomChar.value = false
  store.autoSendYolo.value = false
  store.forceScrollDanmaku.value = false
  store.msgTemplates.value = ['你好世界']
  store.availableDanmakuColors.value = null
})

afterEach(async () => {
  // Stop whatever the loop is doing, drain a tick.
  store.sendMsg.value = false
  cancelLoop()
  await wait(20)
})

// ---------------------------------------------------------------------------
// cancelLoop without an active loop
// ---------------------------------------------------------------------------

describe('cancelLoop (idle)', () => {
  test('does not throw when called before any loop is running', () => {
    // Important: cancelLoop should be safe to invoke even when currentAbort is
    // null. The 停车 button might be clicked before the loop's first round.
    expect(() => cancelLoop()).not.toThrow()
    // It still drains the queue.
    expect(cancelPendingCalls.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Happy path — first iteration also exercises the init block (WBI keys +
// config fetch + emoticon prefetch + scroll-mode). Placed FIRST because the
// loop module's `initialized` flag is one-shot: subsequent tests can't re-run
// the init code path. We set everything the init exercises here.
// ---------------------------------------------------------------------------

describe('loop() — happy path with full init', () => {
  test('first iteration runs init (WBI config, scroll mode, emoticons) then sends', async () => {
    wbiCachedSeed = { img_key: 'a'.repeat(32), sub_key: 'b'.repeat(32) }
    metaSpmContent = 'custom.spm.prefix'
    store.forceScrollDanmaku.value = true
    configFetchResp = {
      data: {
        group: [
          {
            color: [
              { status: 1, color_hex: 'ff0000' },
              { status: 0, color_hex: 'ignored' },
              { status: 1, color_hex: '00ff00' },
            ],
          },
        ],
      },
    }
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1600)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)

    // Init populated colors from the WBI-signed /xlive/web-room-interface/v1/index/getDanmuConfig response.
    expect(store.availableDanmakuColors.value).toEqual(['0xff0000', '0x00ff00'])
    // Send happened.
    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1)
    expect(enqueueCalls[0].msg).toBe('你好世界')
    expect(enqueueCalls[0].roomId).toBe(1234)
    expect(enqueueCalls[0].csrfToken).toBe('csrf-fixture')
    expect(verifyCalls.length).toBeGreaterThanOrEqual(1)
    expect(verifyCalls[0].text).toBe('你好世界')
  })
})

// ---------------------------------------------------------------------------
// CSRF missing
// ---------------------------------------------------------------------------

describe('loop() — login missing', () => {
  test('logs "❌ 未找到登录信息" + risk event + auto-stops sendMsg', async () => {
    csrfReturn = null
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    cancelLoop()
    await wait(40)

    expect(enqueueCalls).toHaveLength(0)
    // sendMsg should be auto-toggled off.
    expect(store.sendMsg.value).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/❌ 未找到登录信息/)
    expect(guardRoomCalls.some(c => c.kind === 'login_missing')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Empty template
// ---------------------------------------------------------------------------

describe('loop() — empty template', () => {
  test('logs "⚠️ 当前模板为空" and auto-stops', async () => {
    store.msgTemplates.value = ['']
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    cancelLoop()
    await wait(40)

    expect(enqueueCalls).toHaveLength(0)
    expect(store.sendMsg.value).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/⚠️ 当前模板为空/)
  })
})

// ---------------------------------------------------------------------------
// YOLO branches
// ---------------------------------------------------------------------------

describe('loop() — YOLO gap (config incomplete)', () => {
  test('logs "🤖 独轮车 AI 润色 已开启但配置不完整" and stops', async () => {
    store.autoSendYolo.value = true
    yoloOutcome = 'gap'
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    cancelLoop()
    await wait(40)

    expect(enqueueCalls).toHaveLength(0)
    expect(store.sendMsg.value).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/独轮车 AI 润色 已开启但配置不完整/)
  })
})

describe('loop() — YOLO empty result', () => {
  test('logs the skip line; sendMsg stays on', async () => {
    store.autoSendYolo.value = true
    yoloOutcome = 'empty'
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1600)
    store.sendMsg.value = false
    cancelLoop()
    await wait(40)

    // No enqueue happened (the skip path continues to next iteration).
    expect(enqueueCalls.length).toBe(0)
    expect(JSON.stringify(logged)).toMatch(/独轮车 AI 润色 跳过本条/)
  })
})

describe('loop() — YOLO throw', () => {
  test('logs the err.message skip; continues loop', async () => {
    store.autoSendYolo.value = true
    yoloOutcome = 'throw'
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1600)
    store.sendMsg.value = false
    cancelLoop()
    await wait(40)

    expect(enqueueCalls.length).toBe(0)
    expect(JSON.stringify(logged)).toMatch(/独轮车 AI 润色 跳过本条.*yolo-broke/)
  })
})

describe('loop() — YOLO success polishes text before send', () => {
  test('enqueueDanmaku receives the polished string, log shows 原文 → 润色', async () => {
    store.autoSendYolo.value = true
    yoloOutcome = 'ok'
    yoloOut = '哥哥厉害'
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1700)
    store.sendMsg.value = false
    cancelLoop()
    await wait(40)

    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1)
    expect(enqueueCalls[0].msg).toBe('哥哥厉害')
    expect(JSON.stringify(logged)).toMatch(/独轮车 AI 润色：你好世界 → 哥哥厉害/)
  })
})

// ---------------------------------------------------------------------------
// Send failure → risk event
// ---------------------------------------------------------------------------

describe('loop() — failed send fires guard-room risk event', () => {
  test('failed enqueue → syncGuardRoomRiskEvent, no verifyBroadcast', async () => {
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: 'mocked-failure',
      errorCode: 9999,
      errorData: null,
    }
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1600)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)

    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1)
    expect(verifyCalls.length).toBe(0)
    expect(guardRoomCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Locked / unavailable emoticon skip branches
// ---------------------------------------------------------------------------

describe('loop() — emoticon rejection branches inside the send loop', () => {
  test('locked emoticon: log + sleep + skip (no enqueue for that template line)', async () => {
    store.msgTemplates.value = ['locked-emote']
    lockedSet.add('locked-emote')
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)
    expect(enqueueCalls.length).toBe(0)
    expect(JSON.stringify(logged)).toMatch(/LOCKED:自动表情:locked-emote/)
  })

  test('unavailable emoticon: log + sleep + skip', async () => {
    store.msgTemplates.value = ['unavail-emote']
    unavailableSet.add('unavail-emote')
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)
    expect(enqueueCalls.length).toBe(0)
    expect(JSON.stringify(logged)).toMatch(/UNAVAIL:自动表情:unavail-emote/)
  })
})

// ---------------------------------------------------------------------------
// randomColor branch
// ---------------------------------------------------------------------------

describe('loop() — randomColor branch', () => {
  test('with randomColor on, send still completes (setRandomDanmakuColor mocked)', async () => {
    store.randomColor.value = true
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    await wait(1500)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)
    expect(enqueueCalls.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// ensureRoomId throws — placed LAST because its 5s recovery sleep would
// otherwise delay every subsequent test's "loop wakes from else" tick.
// ---------------------------------------------------------------------------

describe('loop() — ensureRoomId failure (last; loop sleeps 5s on recovery)', () => {
  test('logs "获取房间ID失败" and does NOT send', async () => {
    ensureRoomIdResult = new Error('cannot-resolve-room')
    ensureLoopRunning()
    await wait(5)
    store.sendMsg.value = true
    // Production sleeps 5s on the error recovery path before looping. Wait
    // past the wake-up so we know the log was written.
    await wait(2000)
    store.sendMsg.value = false
    cancelLoop()
    await wait(50)

    expect(enqueueCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/❌ 获取房间ID失败.*cannot-resolve-room/)
  })
})
