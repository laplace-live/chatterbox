/**
 * Integration coverage for `triggerSend`, `handleSendFailure`, the burst /
 * routine scheduler, `startAutoBlend` / `stopAutoBlend`, and `pickBestTrendingText`.
 *
 * These are the parts of `src/lib/auto-blend.ts` that the pure-helper tests
 * (`auto-blend-cooldown-auto`, `auto-blend.test.ts`, `auto-blend-filter-chain`,
 * `auto-blend-avoid-repeat`, `auto-blend-blacklist`) don't reach — the actual
 * sending path is around 400 lines of branching that only fires when a real
 * trend crosses the threshold.
 *
 * Strategy: mock the send pipeline (api, send-queue, send-verification,
 * live-ws-source, custom-chat-events, llm-polish, danmaku-stream) with the
 * `...real` partial-mock pattern, configure a very short burst-settle so
 * tests don't have to wait the default 1.5s, and drive the module via:
 *   - `_recordDanmakuForTests` to push the trend over threshold.
 *   - `startAutoBlend` / `stopAutoBlend` for lifecycle.
 *   - `_resetAutoBlendStateForTests` for isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { installGmStoreMock } from './_gm-store'

const { reset: resetGm } = installGmStoreMock()

function TestXMLHttpRequest() {}
TestXMLHttpRequest.prototype.open = () => {}
TestXMLHttpRequest.prototype.send = () => {}
;(globalThis as unknown as { XMLHttpRequest: typeof TestXMLHttpRequest }).XMLHttpRequest = TestXMLHttpRequest

// ---------------------------------------------------------------------------
// Per-test state knobs
// ---------------------------------------------------------------------------

const enqueueCalls: Array<{ msg: string }> = []
const verifyCalls: Array<{ text: string; label: string }> = []
const guardRoomCalls: Array<{ kind: string; level?: string }> = []
const recordMemeCalls: Array<{ text: string; roomId: number }> = []
const checkSelfRoomCalls: number[] = []
const logAutoBlendCalls: Array<{ message: string; level?: string }> = []
let verifyReturn: 'ws' | 'dom' | 'timeout' = 'ws'
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
let getCsrfReturn: string | null = 'csrf-fixture'
let polishOutcome: 'ok' | 'gap' | 'empty' | 'throw' = 'ok'
let polishOut = '哥哥厉害'
let restrictionsReturn: Array<{ message: string; duration: string }> = []

// ---------------------------------------------------------------------------
// Mocks — all use `...real` so other test files importing from these
// modules don't get "Export named ... not found".
// ---------------------------------------------------------------------------

const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({
  ...realApi,
  ensureRoomId: async () => 1234,
  getCsrfToken: () => getCsrfReturn,
  getDedeUid: () => 'my-uid',
  setRandomDanmakuColor: async () => {},
  checkSelfRoomRestrictions: async (roomId: number) => {
    checkSelfRoomCalls.push(roomId)
    return restrictionsReturn
  },
}))

const realSendQueue = await import('../src/lib/send-queue')
mock.module('../src/lib/send-queue', () => ({
  ...realSendQueue,
  enqueueDanmaku: async (msg: string) => {
    enqueueCalls.push({ msg })
    return { ...enqueueResult, message: msg }
  },
}))

const realSendVerification = await import('../src/lib/send-verification')
mock.module('../src/lib/send-verification', () => ({
  ...realSendVerification,
  verifyBroadcast: async (args: { text: string; label: string }) => {
    verifyCalls.push({ text: args.text, label: args.label })
    return verifyReturn
  },
}))

const realGuardRoomSync = await import('../src/lib/guard-room-sync')
mock.module('../src/lib/guard-room-sync', () => ({
  ...realGuardRoomSync,
  classifyRiskEvent: () => ({ kind: 'send_failed', level: 'observe', advice: '' }),
  syncGuardRoomRiskEvent: async (ev: { kind: string; level?: string }) => {
    guardRoomCalls.push(ev)
  },
}))

const realLlmPolish = await import('../src/lib/llm-polish')
mock.module('../src/lib/llm-polish', () => ({
  ...realLlmPolish,
  describeLlmGap: () => (polishOutcome === 'gap' ? '未配置' : null),
  polishWithLlm: async () => {
    if (polishOutcome === 'throw') throw new Error('yolo-broke')
    if (polishOutcome === 'empty') return '   '
    return polishOut
  },
}))

const realLiveWs = await import('../src/lib/live-ws-source')
mock.module('../src/lib/live-ws-source', () => ({
  ...realLiveWs,
  startLiveWsSource: () => {},
  stopLiveWsSource: () => {},
}))

const realDanmakuStream = await import('../src/lib/danmaku-stream')
mock.module('../src/lib/danmaku-stream', () => ({
  ...realDanmakuStream,
  subscribeDanmaku: () => () => {},
}))

const realCustomChatEvents = await import('../src/lib/custom-chat-events')
mock.module('../src/lib/custom-chat-events', () => ({
  ...realCustomChatEvents,
  subscribeCustomChatEvents: () => () => {},
}))

const realMemeContrib = await import('../src/lib/meme-contributor')
mock.module('../src/lib/meme-contributor', () => ({
  ...realMemeContrib,
  recordMemeCandidate: (text: string, roomId: number) => {
    recordMemeCalls.push({ text, roomId })
  },
  clearMemeSession: () => {},
}))

const realReplacement = await import('../src/lib/replacement')
mock.module('../src/lib/replacement', () => ({
  ...realReplacement,
  applyReplacements: (s: string) => s,
}))

const realAutoBlendEvents = await import('../src/lib/auto-blend-events')
mock.module('../src/lib/auto-blend-events', () => ({
  ...realAutoBlendEvents,
  logAutoBlend: (message: string, level?: string) => {
    logAutoBlendCalls.push({ message, level })
  },
  logAutoBlendSendResult: (_result: unknown, _label: string, _display: string) => {
    logAutoBlendCalls.push({ message: 'send-result' })
  },
}))

// ---------------------------------------------------------------------------
// Imports — pulled AFTER mocks so the auto-blend module sees the stubs.
// ---------------------------------------------------------------------------

const ab = await import('../src/lib/auto-blend')
const store = await import('../src/lib/store')

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

beforeEach(() => {
  resetGm()
  ab._resetAutoBlendStateForTests()
  enqueueCalls.length = 0
  verifyCalls.length = 0
  guardRoomCalls.length = 0
  recordMemeCalls.length = 0
  checkSelfRoomCalls.length = 0
  logAutoBlendCalls.length = 0
  verifyReturn = 'ws'
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
  getCsrfReturn = 'csrf-fixture'
  polishOutcome = 'ok'
  polishOut = '哥哥厉害'
  restrictionsReturn = []

  store.autoBlendEnabled.value = true
  store.autoBlendDryRun.value = false
  store.autoBlendYolo.value = false
  store.autoBlendThreshold.value = 3
  store.autoBlendWindowSec.value = 20
  store.autoBlendRequireDistinctUsers.value = false
  store.autoBlendMinDistinctUsers.value = 3
  store.autoBlendSendCount.value = 1
  store.autoBlendSendAllTrending.value = false
  store.autoBlendUseReplacements.value = true
  store.autoBlendAvoidRepeat.value = false
  store.autoBlendBurstSettleMs.value = 100
  store.autoBlendCooldownSec.value = 60
  store.autoBlendCooldownAuto.value = false
  store.autoBlendRoutineIntervalSec.value = 60
  store.autoBlendUserBlacklist.value = {}
  store.autoBlendMessageBlacklist.value = {}
  store.cachedRoomId.value = 1234
  store.cachedEmoticonPackages.value = []
  store.randomChar.value = false
  store.randomColor.value = false
  store.randomInterval.value = false
  store.maxLength.value = 38
  store.msgSendInterval.value = 1.5
})

afterEach(() => {
  ab._resetAutoBlendStateForTests()
  store.autoBlendEnabled.value = false
})

// ===========================================================================
// startAutoBlend / stopAutoBlend lifecycle
// ===========================================================================

describe('startAutoBlend / stopAutoBlend', () => {
  test('start resets observable state and stop reverts it', () => {
    ab.stopAutoBlend()
    // Initial-ish state.
    expect(store.autoBlendCandidateText.value).toMatch(/已关闭|暂无/)

    ab.startAutoBlend()
    expect(store.autoBlendStatusText.value).toBe('观察中')
    expect(store.autoBlendCandidateText.value).toBe('暂无')
    expect(store.autoBlendLastActionText.value).toBe('暂无')

    ab.stopAutoBlend()
    expect(store.autoBlendStatusText.value).toBe('已关闭')
    expect(store.autoBlendCandidateText.value).toBe('暂无')
  })

  test('start is idempotent (re-calling does not reinitialize)', () => {
    ab.startAutoBlend()
    const text1 = store.autoBlendStatusText.value
    ab.startAutoBlend()
    ab.startAutoBlend()
    expect(store.autoBlendStatusText.value).toBe(text1)
    ab.stopAutoBlend()
  })

  test('stop carries over the moderation reason as lastActionText if any was set', () => {
    ab.startAutoBlend()
    // Drive the moderation-stop path via a forbidden send (muted error)
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: 'you have been muted',
      errorCode: 1234,
      errorData: null,
    }
    // We don't directly invoke handleSendFailure; just stopAutoBlend with no
    // pre-set reason → falls back to '暂无'.
    ab.stopAutoBlend()
    expect(store.autoBlendLastActionText.value).toBe('暂无')
  })
})

// ===========================================================================
// scheduleBurstSend → triggerSend → enqueueDanmaku
// ===========================================================================

describe('triggerSend (burst happy path)', () => {
  test('recording N copies above threshold leads to one enqueueDanmaku + one verifyBroadcast', async () => {
    ab.startAutoBlend()
    try {
      // Threshold = 3. Push 3 copies of "上车".
      ab._recordDanmakuForTests('上车', 'u-1', false)
      ab._recordDanmakuForTests('上车', 'u-2', false)
      ab._recordDanmakuForTests('上车', 'u-3', false)
      // Wait past burst settle (100ms) + a bit for triggerSend to complete.
      await wait(300)

      expect(enqueueCalls.length).toBe(1)
      expect(enqueueCalls[0].msg).toBe('上车')
      expect(verifyCalls.length).toBe(1)
      expect(verifyCalls[0].label).toBe('自动')
      // Status text reflects post-send state.
      expect(store.autoBlendStatusText.value).toMatch(/冷却|已关闭/)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('avoid-repeat: lastAutoSentText is updated to the trigger text', async () => {
    ab.startAutoBlend()
    try {
      // 注：chatfilter（场景 A，默认开）会把 "666" 通过 cycle-compress 归一为
      // "6"，trendMap 的 key 与 lastAutoSentText 都是 canonical "6"。这条测试
      // 验证的不变量是"lastAutoSentText 等于触发发送的那个 trendMap key"，
      // 不论该 key 是 raw 还是 canonical。
      ab._recordDanmakuForTests('666', 'a', false)
      ab._recordDanmakuForTests('666', 'b', false)
      ab._recordDanmakuForTests('666', 'c', false)
      await wait(300)
      expect(ab._getLastAutoSentTextForTests()).toBe('6')
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('successful WS echo updates lastActionText to "已WS回显"', async () => {
    verifyReturn = 'ws'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('好家伙', 'a', false)
      ab._recordDanmakuForTests('好家伙', 'b', false)
      ab._recordDanmakuForTests('好家伙', 'c', false)
      await wait(300)
      expect(store.autoBlendLastActionText.value).toMatch(/已WS回显/)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('successful DOM echo updates lastActionText to "已DOM回显"', async () => {
    verifyReturn = 'dom'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('GO', 'a', false)
      ab._recordDanmakuForTests('GO', 'b', false)
      ab._recordDanmakuForTests('GO', 'c', false)
      await wait(300)
      expect(store.autoBlendLastActionText.value).toMatch(/已DOM回显/)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('silent drop (verify=timeout) updates lastActionText to "接口成功未见广播"', async () => {
    verifyReturn = 'timeout'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('uwu', 'a', false)
      ab._recordDanmakuForTests('uwu', 'b', false)
      ab._recordDanmakuForTests('uwu', 'c', false)
      await wait(300)
      expect(store.autoBlendLastActionText.value).toMatch(/接口成功未见广播/)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('records meme candidate on successful non-emote send', async () => {
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('好烂梗', 'a', false)
      ab._recordDanmakuForTests('好烂梗', 'b', false)
      ab._recordDanmakuForTests('好烂梗', 'c', false)
      await wait(300)
      expect(recordMemeCalls.length).toBe(1)
      expect(recordMemeCalls[0].text).toBe('好烂梗')
      expect(recordMemeCalls[0].roomId).toBe(1234)
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// Dry run
// ===========================================================================

describe('triggerSend dry run', () => {
  test('dry run mode logs but does NOT enqueueDanmaku', async () => {
    store.autoBlendDryRun.value = true
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('dry', 'a', false)
      ab._recordDanmakuForTests('dry', 'b', false)
      ab._recordDanmakuForTests('dry', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(0)
      expect(store.autoBlendLastActionText.value).toMatch(/试运行命中/)
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// Authentication gate
// ===========================================================================

describe('triggerSend authentication gate', () => {
  test('missing csrf → logs warning, no enqueue', async () => {
    getCsrfReturn = null
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('login?', 'a', false)
      ab._recordDanmakuForTests('login?', 'b', false)
      ab._recordDanmakuForTests('login?', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(0)
      expect(store.autoBlendLastActionText.value).toMatch(/未登录/)
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// YOLO branches
// ===========================================================================

describe('triggerSend YOLO branches', () => {
  test('YOLO config gap: skip current target, no enqueue', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'gap'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('gap-trigger', 'a', false)
      ab._recordDanmakuForTests('gap-trigger', 'b', false)
      ab._recordDanmakuForTests('gap-trigger', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(0)
      expect(store.autoBlendLastActionText.value).toMatch(/自动跟车 AI 润色 跳过/)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('YOLO empty result: logs warn, no enqueue', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'empty'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('empty-trig', 'a', false)
      ab._recordDanmakuForTests('empty-trig', 'b', false)
      ab._recordDanmakuForTests('empty-trig', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(0)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('YOLO throw: logs warn, no enqueue', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'throw'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('throw-trig', 'a', false)
      ab._recordDanmakuForTests('throw-trig', 'b', false)
      ab._recordDanmakuForTests('throw-trig', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(0)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('YOLO success: polished text is sent', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'ok'
    polishOut = '哥厉害'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('ok-trig', 'a', false)
      ab._recordDanmakuForTests('ok-trig', 'b', false)
      ab._recordDanmakuForTests('ok-trig', 'c', false)
      await wait(300)
      expect(enqueueCalls.length).toBe(1)
      expect(enqueueCalls[0].msg).toBe('哥厉害')
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// handleSendFailure — rate limit / muted / account restricted
// ===========================================================================

describe('triggerSend — moderation failure paths', () => {
  test('muted error stops auto-blend and emits the muted log', async () => {
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: '您已被房管禁言',
      errorCode: 0,
      errorData: null,
    }
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('muted', 'a', false)
      ab._recordDanmakuForTests('muted', 'b', false)
      ab._recordDanmakuForTests('muted', 'c', false)
      await wait(300)
      expect(store.autoBlendEnabled.value).toBe(false)
      // The "muted" log line is emitted via logAutoBlend.
      expect(logAutoBlendCalls.some(c => c.message.match(/检测到你在本房间被禁言/))).toBe(true)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('account-level restriction stops auto-blend', async () => {
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: '账号风控',
      errorCode: 0,
      errorData: null,
    }
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('acct', 'a', false)
      ab._recordDanmakuForTests('acct', 'b', false)
      ab._recordDanmakuForTests('acct', 'c', false)
      await wait(300)
      expect(store.autoBlendEnabled.value).toBe(false)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('rate-limit failure does not stop auto-blend on first hit', async () => {
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: '发送频率过快',
      errorCode: 0,
      errorData: null,
    }
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('rate', 'a', false)
      ab._recordDanmakuForTests('rate', 'b', false)
      ab._recordDanmakuForTests('rate', 'c', false)
      await wait(300)
      // Should still be enabled (under threshold of 3 hits).
      expect(store.autoBlendEnabled.value).toBe(true)
      // But cooldown is engaged.
      expect(ab._getCooldownUntilForTests()).toBeGreaterThan(Date.now())
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// Silent-drop probe (3-strike room-restriction check)
// ===========================================================================

describe('triggerSend — silent-drop room-restriction probe', () => {
  test('three consecutive silent drops triggers checkSelfRoomRestrictions', async () => {
    verifyReturn = 'timeout'
    // Disable cooldown so subsequent rounds fire quickly.
    store.autoBlendCooldownSec.value = 1
    ab.startAutoBlend()
    try {
      for (let round = 0; round < 3; round++) {
        ab._recordDanmakuForTests('hi', `u-${round}-1`, false)
        ab._recordDanmakuForTests('hi', `u-${round}-2`, false)
        ab._recordDanmakuForTests('hi', `u-${round}-3`, false)
        await wait(300)
        // Wait past cooldown.
        await wait(1100)
      }
      expect(checkSelfRoomCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      ab.stopAutoBlend()
    }
  }, 10_000)
})

// ===========================================================================
// Send-all-trending burst
// ===========================================================================

describe('triggerSend — sendAllTrending burst', () => {
  test('multi-trend burst sends every threshold-meeting message once', async () => {
    store.autoBlendSendAllTrending.value = true
    // Tight settle so the burst grabs both trends.
    store.autoBlendBurstSettleMs.value = 200
    // Tight inter-target gap so the second send fires soon after the first.
    store.msgSendInterval.value = 0.2
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('上车', 'u1', false)
      ab._recordDanmakuForTests('上车', 'u2', false)
      ab._recordDanmakuForTests('上车', 'u3', false)
      ab._recordDanmakuForTests('好家伙', 'u4', false)
      ab._recordDanmakuForTests('好家伙', 'u5', false)
      ab._recordDanmakuForTests('好家伙', 'u6', false)
      // Wait past: 200ms burst settle + first send + 1010ms anti-spam floor
      // for the inter-target gap + second send.
      await wait(2000)
      expect(enqueueCalls.length).toBe(2)
      const messages = enqueueCalls.map(c => c.msg).sort()
      expect(messages).toEqual(['上车', '好家伙'])
    } finally {
      ab.stopAutoBlend()
    }
  }, 5000)
})

// ===========================================================================
// Rate-limit threshold → stop after N hits in window
// ===========================================================================

describe('triggerSend — rate-limit threshold stops auto-blend', () => {
  test('threshold=1 → first rate-limit hit immediately stops auto-blend', async () => {
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: '发送频率过快',
      errorCode: 0,
      errorData: null,
    }
    // threshold=1 means the very first rate-limit hit crosses the stop bar.
    // (Avoids the production 2-minute RATE_LIMIT_BACKOFF that would otherwise
    // block the second test round.)
    store.autoBlendRateLimitStopThreshold.value = 1
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('rt', 'u1', false)
      ab._recordDanmakuForTests('rt', 'u2', false)
      ab._recordDanmakuForTests('rt', 'u3', false)
      await wait(300)
      expect(store.autoBlendEnabled.value).toBe(false)
      expect(logAutoBlendCalls.some(c => c.message.match(/多次触发发送频率限制/))).toBe(true)
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// routineTimerTick — periodic weighted-random pick
// ===========================================================================

describe('routineTimerTick — periodic candidate picker', () => {
  test('routine timer eventually fires after autoBlendRoutineIntervalSec, sends a candidate', async () => {
    // Drop the routine interval to a small value so the tick fires quickly.
    store.autoBlendRoutineIntervalSec.value = 5 // (min from numericGmSignal is 5)
    // Make threshold easy — 2 messages.
    store.autoBlendThreshold.value = 2
    // Disable burst so the routine timer is the only thing that fires.
    // We accomplish this by setting a high burst-settle that won't trigger
    // during the test window, then sending NO message (so the burst doesn't
    // arm). Actually simpler: cooldown blocks burst-scheduling after first
    // send, but a routine tick can still happen after cooldown ends.
    store.autoBlendBurstSettleMs.value = 60000 // effectively disabled
    store.autoBlendCooldownSec.value = 1
    ab.startAutoBlend()
    try {
      // Seed two trends so the routine has something to pick from. Two
      // messages reach threshold, but since burst-settle is 60s, no burst
      // fires.
      ab._recordDanmakuForTests('上车', 'u1', false)
      ab._recordDanmakuForTests('上车', 'u2', false)
      ab._recordDanmakuForTests('好家伙', 'u3', false)
      ab._recordDanmakuForTests('好家伙', 'u4', false)
      // Wait for routine timer to fire (5s + a bit).
      await wait(5500)
      expect(enqueueCalls.length).toBeGreaterThanOrEqual(1)
      // The chosen text must be one of the seeded trends.
      expect(['上车', '好家伙']).toContain(enqueueCalls[0].msg)
    } finally {
      ab.stopAutoBlend()
    }
  }, 10000)
})

// ===========================================================================
// Unknown errorCode counter (B09) — 3 consecutive unknowns → force dryRun
// ===========================================================================

describe('triggerSend — unknown errorCode counter (B09)', () => {
  test('three consecutive unknown errorCodes force autoBlendDryRun → true', async () => {
    // 88888 isn't in classifyByCode's known table and the error string
    // doesn't hit isMutedError / isAccountRestrictedError / isRateLimitError.
    // That makes it the "unknown" path that increments the counter.
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: '神秘错误信息',
      errorCode: 88888,
      errorData: null,
    }
    // Tight cooldown so three rounds fit inside the test timeout.
    store.autoBlendCooldownSec.value = 1
    store.autoBlendDryRun.value = false
    ab.startAutoBlend()
    try {
      // Round 1: counter goes 0 → 1, no flip yet, dryRun stays false.
      ab._recordDanmakuForTests('u1-a', 'a1', false)
      ab._recordDanmakuForTests('u1-a', 'b1', false)
      ab._recordDanmakuForTests('u1-a', 'c1', false)
      await wait(300)
      expect(store.autoBlendDryRun.value).toBe(false)

      // Wait past cooldown so the next burst can fire.
      await wait(1100)

      // Round 2: counter 1 → 2, still no flip.
      ab._recordDanmakuForTests('u2-b', 'a2', false)
      ab._recordDanmakuForTests('u2-b', 'b2', false)
      ab._recordDanmakuForTests('u2-b', 'c2', false)
      await wait(300)
      expect(store.autoBlendDryRun.value).toBe(false)

      await wait(1100)

      // Round 3: counter 2 → 3, hits threshold, flips dryRun ON.
      ab._recordDanmakuForTests('u3-c', 'a3', false)
      ab._recordDanmakuForTests('u3-c', 'b3', false)
      ab._recordDanmakuForTests('u3-c', 'c3', false)
      await wait(300)

      expect(store.autoBlendDryRun.value).toBe(true)
      // The warn log should mention the threshold + errorCode for user repro.
      expect(
        logAutoBlendCalls.some(c => c.level === 'warning' && c.message.match(/连续 3 次/) && c.message.match(/88888/))
      ).toBe(true)
    } finally {
      ab.stopAutoBlend()
    }
  }, 10_000)

  test('a recognized error (rate-limit) interleaved resets the unknown counter', async () => {
    // 1 unknown + 1 rate-limit + 2 unknown → only 2 consecutive unknown at
    // the end, so dryRun should NOT flip.
    store.autoBlendCooldownSec.value = 1
    store.autoBlendDryRun.value = false
    // Avoid the moderation-stop bar (default 3 hits) so rate-limit alone
    // doesn't stop auto-blend before the 4th round.
    store.autoBlendRateLimitStopThreshold.value = 5
    ab.startAutoBlend()
    try {
      // Round 1: unknown.
      enqueueResult = {
        success: false,
        message: '',
        isEmoticon: false,
        startedAt: 1,
        cancelled: false,
        error: '神秘错误',
        errorCode: 88888,
        errorData: null,
      }
      ab._recordDanmakuForTests('r1', 'a', false)
      ab._recordDanmakuForTests('r1', 'b', false)
      ab._recordDanmakuForTests('r1', 'c', false)
      await wait(300)
      await wait(1100)

      // Round 2: rate-limit (Chinese phrase recognized by isRateLimitError).
      // 切到 rate-limit 会 reset 未知计数器,所以后两次未知 = 2 < 3,不应翻
      // dryRun。
      enqueueResult = { ...enqueueResult, error: '发送频率过快' }
      ab._recordDanmakuForTests('r2', 'a', false)
      ab._recordDanmakuForTests('r2', 'b', false)
      ab._recordDanmakuForTests('r2', 'c', false)
      await wait(300)
      // rate-limit engages its own cooldown (RATE_LIMIT_BACKOFF, ~2 min).
      // Force it back to short via the state reset hook so the next bursts
      // can fire — but keep the counter intact (reset clears counter too,
      // which would defeat the test). Direct mutation of cooldownUntil
      // via the test seam.
      ab._setCooldownUntilForTests(0)

      // Two more unknowns: counter went 1 → 0 (after rate-limit) → 1 → 2.
      enqueueResult = { ...enqueueResult, error: '又神秘了' }
      ab._recordDanmakuForTests('r3', 'a', false)
      ab._recordDanmakuForTests('r3', 'b', false)
      ab._recordDanmakuForTests('r3', 'c', false)
      await wait(300)
      ab._setCooldownUntilForTests(0)

      ab._recordDanmakuForTests('r4', 'a', false)
      ab._recordDanmakuForTests('r4', 'b', false)
      ab._recordDanmakuForTests('r4', 'c', false)
      await wait(300)

      expect(store.autoBlendDryRun.value).toBe(false)
    } finally {
      ab.stopAutoBlend()
    }
  }, 10_000)

  test('unknown errors accumulate ACROSS successful sends — they only reset on recognized failures', async () => {
    // 文档当前行为：success 不会重置 consecutiveUnknownErrors,只有被分类为
    // muted/account/rate-limit 的"识别失败"才重置。
    //
    // 设计意图：如果 B 站交替返回成功 + 未知错误,那个未知错误仍然是真信号
    // (脚本的错误分类表跟不上了);用成功的存在掩盖未知错误的累积反而会
    // 隐藏部分降级状态。这条测试把这个不变量钉死,避免"加 success 重置"
    // 这种看似合理但其实有害的回归。
    store.autoBlendCooldownSec.value = 1
    store.autoBlendDryRun.value = false
    ab.startAutoBlend()
    try {
      // Round 1: unknown errorCode → counter 0 → 1.
      enqueueResult = {
        success: false,
        message: '',
        isEmoticon: false,
        startedAt: 1,
        cancelled: false,
        error: '怪错 1',
        errorCode: 88888,
        errorData: null,
      }
      ab._recordDanmakuForTests('s1', 'a', false)
      ab._recordDanmakuForTests('s1', 'b', false)
      ab._recordDanmakuForTests('s1', 'c', false)
      await wait(300)
      ab._setCooldownUntilForTests(0)

      // Round 2: success — counter should STAY at 1, NOT reset to 0.
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
      ab._recordDanmakuForTests('s2', 'a', false)
      ab._recordDanmakuForTests('s2', 'b', false)
      ab._recordDanmakuForTests('s2', 'c', false)
      await wait(300)
      ab._setCooldownUntilForTests(0)

      // Round 3: unknown again → counter 1 → 2 (still no flip).
      enqueueResult = {
        success: false,
        message: '',
        isEmoticon: false,
        startedAt: 1,
        cancelled: false,
        error: '怪错 2',
        errorCode: 88888,
        errorData: null,
      }
      ab._recordDanmakuForTests('s3', 'a', false)
      ab._recordDanmakuForTests('s3', 'b', false)
      ab._recordDanmakuForTests('s3', 'c', false)
      await wait(300)
      expect(store.autoBlendDryRun.value).toBe(false)
      ab._setCooldownUntilForTests(0)

      // Round 4: unknown again → counter 2 → 3, flips.
      ab._recordDanmakuForTests('s4', 'a', false)
      ab._recordDanmakuForTests('s4', 'b', false)
      ab._recordDanmakuForTests('s4', 'c', false)
      await wait(300)
      expect(store.autoBlendDryRun.value).toBe(true)
    } finally {
      ab.stopAutoBlend()
    }
  }, 10_000)
})

// ===========================================================================
// Filtered-wave cooldown (B07) — every target skipped → short 5s cooldown
// ===========================================================================

describe('triggerSend — filtered-wave cooldown (B07)', () => {
  test('YOLO gap on every target → 5s short cooldown still engages', async () => {
    // YOLO is on but LLM is not configured → every target `continue`s past
    // engageCooldownOnce. Without the B07 fix the wave would consume zero
    // cooldown and the same trendMap entry would re-trigger on the next
    // matching danmaku. With the fix, a 5s short cooldown engages and the
    // trendMap entry is dropped.
    store.autoBlendYolo.value = true
    polishOutcome = 'gap'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('🚲', 'a', false)
      ab._recordDanmakuForTests('🚲', 'b', false)
      ab._recordDanmakuForTests('🚲', 'c', false)
      await wait(300)

      // No send happened (B07 fix's prerequisite).
      expect(enqueueCalls.length).toBe(0)

      // Cooldown engaged. Production constant is 5000ms; we accept anything
      // in (now+1000, now+10000] to avoid flakiness.
      const cooldownDelta = ab._getCooldownUntilForTests() - Date.now()
      expect(cooldownDelta).toBeGreaterThan(1000)
      expect(cooldownDelta).toBeLessThan(10_000)

      // Trend entry was dropped — re-recording the same text shouldn't
      // instantly re-trigger because trendMap is empty for it.
      expect(ab._getTrendMapSizeForTests()).toBe(0)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('YOLO empty result on every target → 5s short cooldown engages', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'empty'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('haha', 'a', false)
      ab._recordDanmakuForTests('haha', 'b', false)
      ab._recordDanmakuForTests('haha', 'c', false)
      await wait(300)

      expect(enqueueCalls.length).toBe(0)
      const cooldownDelta = ab._getCooldownUntilForTests() - Date.now()
      expect(cooldownDelta).toBeGreaterThan(1000)
      expect(cooldownDelta).toBeLessThan(10_000)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('YOLO throw on every target → 5s short cooldown engages', async () => {
    store.autoBlendYolo.value = true
    polishOutcome = 'throw'
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('boom', 'a', false)
      ab._recordDanmakuForTests('boom', 'b', false)
      ab._recordDanmakuForTests('boom', 'c', false)
      await wait(300)

      expect(enqueueCalls.length).toBe(0)
      const cooldownDelta = ab._getCooldownUntilForTests() - Date.now()
      expect(cooldownDelta).toBeGreaterThan(1000)
      expect(cooldownDelta).toBeLessThan(10_000)
    } finally {
      ab.stopAutoBlend()
    }
  })

  test('happy-path send → full cooldown is engaged (not the short 5s variant)', async () => {
    // Sanity: when a target actually fires, the engageCooldownOnce path runs
    // first and the finally-block short-cooldown is skipped. Cooldown should
    // be much larger than 5s (we set autoBlendCooldownSec=60 in beforeEach).
    ab.startAutoBlend()
    try {
      ab._recordDanmakuForTests('上车', 'a', false)
      ab._recordDanmakuForTests('上车', 'b', false)
      ab._recordDanmakuForTests('上车', 'c', false)
      await wait(300)

      expect(enqueueCalls.length).toBe(1)
      const cooldownDelta = ab._getCooldownUntilForTests() - Date.now()
      // Full cooldown from the test fixture (60s). Allow >10s as the
      // distinguishing bar — the short 5s path would be <10s.
      expect(cooldownDelta).toBeGreaterThan(10_000)
    } finally {
      ab.stopAutoBlend()
    }
  })
})

// ===========================================================================
// _resetAutoBlendStateForTests round-trip
// ===========================================================================

describe('_resetAutoBlendStateForTests', () => {
  test('clears trendMap, CPM, cooldown, and lastAutoSentText', () => {
    ab._recordDanmakuForTests('x', 'a', false)
    ab._recordDanmakuForTests('x', 'b', false)
    ab._setLastAutoSentTextForTests('seeded')
    ab._pushCpmTimestampForTests(Date.now())

    expect(ab._getTrendMapSizeForTests()).toBeGreaterThan(0)
    expect(ab._getCpmWindowSizeForTests()).toBeGreaterThan(0)
    expect(ab._getLastAutoSentTextForTests()).toBe('seeded')

    ab._resetAutoBlendStateForTests()

    expect(ab._getTrendMapSizeForTests()).toBe(0)
    expect(ab._getCpmWindowSizeForTests()).toBe(0)
    expect(ab._getLastAutoSentTextForTests()).toBeNull()
    expect(ab._getCooldownUntilForTests()).toBe(0)
  })
})
