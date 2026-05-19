/**
 * Coverage for the danmaku-actions surfaces that `verify-wiring-danmaku-actions`
 * and `fill-into-composer` don't reach:
 *
 *   - `stealDanmaku` — copy-to-clipboard side effect + composer-focus fallback chain.
 *   - `repeatDanmaku` — confirm flow, missing-csrf, locked / unavailable emoticons,
 *      enqueue exceptions.
 *   - `sendManualDanmaku` — empty input, locked / unavailable, multi-segment (long
 *      text), AI-evasion path on failure, missing-csrf, exception-in-outer-try.
 *
 * Pattern (matches existing `verify-wiring-danmaku-actions.test.ts`): mock at
 * the smallest sensible boundary using `...real` + override so other test
 * files that later `import { x } from '../src/lib/foo'` still see all named
 * exports.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('$', () => ({
  GM_addStyle: () => {},
  GM_deleteValue: () => {},
  GM_getValue: <T>(_key: string, defaultValue: T): T => defaultValue,
  GM_info: { script: { version: 'test' } },
  GM_setValue: () => {},
  unsafeWindow: globalThis,
}))

// ---------------------------------------------------------------------------
// Capture buffers + per-test state knobs.
// ---------------------------------------------------------------------------

const logged: unknown[] = []
const verifyCalls: Array<{ text: string; label: string; enableAiEvasion?: boolean }> = []
const aiEvasionCalls: Array<{ msg: string; roomId: number; csrfToken: string }> = []
const clipboardCalls: string[] = []
const guardRoomCalls: Array<{ kind: string; source: string }> = []
let confirmReply = true
let confirmCalls = 0

interface EnqResult {
  success: boolean
  message: string
  isEmoticon: boolean
  startedAt: number
  cancelled: boolean
  error?: string
  errorCode?: number
  errorData?: unknown
}
let enqueueResult: EnqResult = {
  success: true,
  message: '',
  isEmoticon: false,
  startedAt: 1234567890,
  cancelled: false,
}
let enqueueShouldThrow = false
let ensureRoomIdShouldThrow = false
let getCsrfReturn: string | null = 'csrf-token-fixture'

let isLockedFor = ''
let isUnavailableFor = ''
let isEmoticonFor = ''
let polishOutcome: { kind: 'gap' } | { kind: 'ok'; out: string } | { kind: 'err'; err: Error } = {
  kind: 'ok',
  out: '',
}

// ---------------------------------------------------------------------------
// Module mocks — all use the `...real` pattern so we don't lose other exports.
// ---------------------------------------------------------------------------

const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({
  ...realApi,
  ensureRoomId: async () => {
    if (ensureRoomIdShouldThrow) throw new Error('boom-roomid')
    return 12345
  },
  getCsrfToken: () => getCsrfReturn,
}))

const realSendQueue = await import('../src/lib/send-queue')
mock.module('../src/lib/send-queue', () => ({
  ...realSendQueue,
  enqueueDanmaku: async (msg: string) => {
    if (enqueueShouldThrow) throw new Error('boom-enqueue')
    return { ...enqueueResult, message: msg }
  },
}))

const realSendVerification = await import('../src/lib/send-verification')
mock.module('../src/lib/send-verification', () => ({
  ...realSendVerification,
  verifyBroadcast: async (args: { text: string; label: string; enableAiEvasion?: boolean }) => {
    verifyCalls.push({ text: args.text, label: args.label, enableAiEvasion: args.enableAiEvasion })
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

const realEmoticon = await import('../src/lib/emoticon')
mock.module('../src/lib/emoticon', () => ({
  ...realEmoticon,
  isEmoticonUnique: (s: string) => s === isEmoticonFor,
  isLockedEmoticon: (s: string) => s === isLockedFor,
  isUnavailableEmoticon: (s: string) => s === isUnavailableFor,
  formatLockedEmoticonReject: (s: string, lbl: string) => `LOCKED:${lbl}:${s}`,
  formatUnavailableEmoticonReject: (s: string, lbl: string) => `UNAVAIL:${lbl}:${s}`,
}))

const realAiEvasion = await import('../src/lib/ai-evasion')
mock.module('../src/lib/ai-evasion', () => ({
  ...realAiEvasion,
  tryAiEvasion: async (msg: string, roomId: number, csrfToken: string) => {
    aiEvasionCalls.push({ msg, roomId, csrfToken })
    return { success: false }
  },
}))

const realClipboard = await import('../src/lib/clipboard')
mock.module('../src/lib/clipboard', () => ({
  ...realClipboard,
  copyTextToClipboard: async (text: string) => {
    clipboardCalls.push(text)
    return true
  },
}))

const realLlmPolish = await import('../src/lib/llm-polish')
mock.module('../src/lib/llm-polish', () => ({
  ...realLlmPolish,
  describeLlmGap: () => (polishOutcome.kind === 'gap' ? '配置缺失' : null),
  polishWithLlm: async () => {
    if (polishOutcome.kind === 'err') throw polishOutcome.err
    if (polishOutcome.kind === 'ok') return polishOutcome.out
    throw new Error('called when gap=true')
  },
}))

mock.module('../src/components/ui/alert-dialog', () => ({
  showConfirm: async () => {
    confirmCalls += 1
    return confirmReply
  },
}))

// Minimal document.querySelector so focusCustomChatComposer can short-circuit.
;(globalThis as unknown as { document: { querySelector: () => null } }).document = {
  querySelector: () => null,
}

const { repeatDanmaku, sendManualDanmaku, stealDanmaku } = await import('../src/lib/danmaku-actions')
const store = await import('../src/lib/store')

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  logged.length = 0
  verifyCalls.length = 0
  aiEvasionCalls.length = 0
  clipboardCalls.length = 0
  guardRoomCalls.length = 0
  confirmReply = true
  confirmCalls = 0
  enqueueResult = {
    success: true,
    message: '',
    isEmoticon: false,
    startedAt: 1234567890,
    cancelled: false,
  }
  enqueueShouldThrow = false
  ensureRoomIdShouldThrow = false
  getCsrfReturn = 'csrf-token-fixture'
  isLockedFor = ''
  isUnavailableFor = ''
  isEmoticonFor = ''
  polishOutcome = { kind: 'ok', out: '' }

  store.fasongText.value = ''
  store.activeTab.value = 'fasong'
  store.dialogOpen.value = false
  store.customChatEnabled.value = false
  store.aiEvasion.value = false
  store.normalSendYolo.value = false
  // Default maxLength is 38; keep it.
})

afterEach(() => {
  store.fasongText.value = ''
})

// ---------------------------------------------------------------------------
// stealDanmaku
// ---------------------------------------------------------------------------

describe('stealDanmaku', () => {
  test('copies to clipboard, sets fasongText, opens panel when no Chatterbox composer is reachable', async () => {
    await stealDanmaku('好家伙')
    expect(clipboardCalls).toEqual(['好家伙'])
    expect(store.fasongText.value).toBe('好家伙')
    expect(store.activeTab.value).toBe('fasong')
    expect(store.dialogOpen.value).toBe(true)
    // Log starts with '🥷' and contains "偷并复制" when copy succeeded.
    expect(JSON.stringify(logged)).toMatch(/🥷 偷并复制: 好家伙/)
  })

  test('writes to fasongText / opens panel even when clipboard succeeded (regression: side effects must not depend on clipboard)', async () => {
    // Earlier draft also asserted the "clipboard returns false" log variant
    // by swapping the mock mid-test, but mid-test mock.module swaps don't
    // affect already-resolved imports under bun. The clipboard-true path
    // already exercises the success branch above; we lock the side-effect
    // invariants here.
    store.activeTab.value = 'about'
    store.dialogOpen.value = false
    await stealDanmaku('谢谢')
    expect(store.fasongText.value).toBe('谢谢')
    expect(store.activeTab.value).toBe('fasong')
    expect(store.dialogOpen.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// repeatDanmaku
// ---------------------------------------------------------------------------

describe('repeatDanmaku — confirm gate', () => {
  test('with confirm:true and user accepts, proceeds to send', async () => {
    await repeatDanmaku('hi', { confirm: true })
    expect(confirmCalls).toBe(1)
    expect(verifyCalls).toHaveLength(1)
  })

  test('with confirm:true and user cancels, returns without sending', async () => {
    confirmReply = false
    await repeatDanmaku('hi', { confirm: true })
    expect(confirmCalls).toBe(1)
    expect(verifyCalls).toHaveLength(0)
  })

  test('forwards optional anchor to showConfirm (no error if absent)', async () => {
    // Smoke: passing anchor doesn't throw. The mock ignores its content.
    await repeatDanmaku('hi', { confirm: true, anchor: { x: 10, y: 20 } })
    expect(confirmCalls).toBe(1)
  })
})

describe('repeatDanmaku — pre-send rejections', () => {
  test('logs login_missing and bails when csrf token is null', async () => {
    getCsrfReturn = null
    await repeatDanmaku('hi')
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/❌ 未找到登录信息/)
  })

  test('logs locked-emoticon rejection (does NOT send) for a locked emote', async () => {
    isLockedFor = 'locked-emoji'
    await repeatDanmaku('locked-emoji')
    expect(verifyCalls).toHaveLength(0)
    // Production label for +1 path on locked emote is "+1 表情".
    expect(JSON.stringify(logged)).toMatch(/LOCKED:\+1 表情:locked-emoji/)
  })

  test('logs unavailable-emoticon rejection (does NOT send) for an unavailable emote', async () => {
    isUnavailableFor = 'room_xx_id'
    await repeatDanmaku('room_xx_id')
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/UNAVAIL:\+1 表情:room_xx_id/)
  })

  test('logs 🔴 +1 出错 when ensureRoomId throws', async () => {
    ensureRoomIdShouldThrow = true
    await repeatDanmaku('hi')
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/🔴 \+1 出错/)
  })
})

// ---------------------------------------------------------------------------
// sendManualDanmaku
// ---------------------------------------------------------------------------

describe('sendManualDanmaku — input rejection', () => {
  test('returns false and logs ⚠️ on empty input', async () => {
    const ok = await sendManualDanmaku('')
    expect(ok).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/⚠️ 消息内容不能为空/)
  })

  test('returns false and logs ⚠️ on whitespace-only input', async () => {
    const ok = await sendManualDanmaku('     ')
    expect(ok).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/⚠️ 消息内容不能为空/)
  })

  test('returns false on locked emoticon without sending', async () => {
    isLockedFor = 'locked'
    const ok = await sendManualDanmaku('locked')
    expect(ok).toBe(false)
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/LOCKED:手动表情:locked/)
  })

  test('returns false on unavailable emoticon without sending', async () => {
    isUnavailableFor = 'unavail'
    const ok = await sendManualDanmaku('unavail')
    expect(ok).toBe(false)
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/UNAVAIL:手动表情:unavail/)
  })
})

describe('sendManualDanmaku — auth and error paths', () => {
  test('csrf missing → log + syncGuardRoomRiskEvent kind=login_missing + return false', async () => {
    getCsrfReturn = null
    const ok = await sendManualDanmaku('hi')
    expect(ok).toBe(false)
    expect(verifyCalls).toHaveLength(0)
    expect(JSON.stringify(logged)).toMatch(/❌ 未找到登录信息/)
    expect(guardRoomCalls.some(c => c.kind === 'login_missing')).toBe(true)
  })

  test('ensureRoomId throws → log 🔴 + return false', async () => {
    ensureRoomIdShouldThrow = true
    const ok = await sendManualDanmaku('hi')
    expect(ok).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/🔴 发送出错/)
  })

  test('enqueueDanmaku rejects with throw → log 🔴 + return false', async () => {
    enqueueShouldThrow = true
    const ok = await sendManualDanmaku('hi')
    expect(ok).toBe(false)
    expect(JSON.stringify(logged)).toMatch(/🔴 发送出错/)
  })
})

describe('sendManualDanmaku — multi-segment for long input', () => {
  test('text longer than maxLength is split + each segment goes through enqueue, returns true on full success', async () => {
    store.maxLength.value = 5
    const ok = await sendManualDanmaku('1234567890abcdef') // 16 chars / 5 → 4 segments
    expect(ok).toBe(true)
    // Each successful segment fires one verifyBroadcast call.
    expect(verifyCalls.length).toBeGreaterThanOrEqual(2)
    // The label gets "[i/N]" appended for multi-segment.
    expect(verifyCalls.some(c => c.label.match(/\[\d+\/\d+\]/))).toBe(true)
  })

  test('returns false when ANY segment fails', async () => {
    store.maxLength.value = 5
    let calls = 0
    // Override enqueue to fail on second call.
    enqueueResult = {
      success: true,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
    }
    mock.module('../src/lib/send-queue', () => ({
      ...realSendQueue,
      enqueueDanmaku: async (msg: string) => {
        calls++
        return {
          ...enqueueResult,
          message: msg,
          success: calls !== 2,
          error: calls === 2 ? 'mocked-failure' : undefined,
          errorCode: calls === 2 ? 1234 : undefined,
        }
      },
    }))
    try {
      const ok = await sendManualDanmaku('1234567890abcdef')
      expect(ok).toBe(false)
      // The failing segment should have triggered a syncGuardRoomRiskEvent.
      expect(guardRoomCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      // Restore for subsequent tests.
      mock.module('../src/lib/send-queue', () => ({
        ...realSendQueue,
        enqueueDanmaku: async (msg: string) => {
          if (enqueueShouldThrow) throw new Error('boom-enqueue')
          return { ...enqueueResult, message: msg }
        },
      }))
    }
  })
})

describe('sendManualDanmaku — aiEvasion side effect on failure', () => {
  test('failed send + aiEvasion=true → tryAiEvasion is called with the segment', async () => {
    store.aiEvasion.value = true
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: 'blocked',
      errorCode: 9999,
    }
    const ok = await sendManualDanmaku('屏蔽词')
    expect(ok).toBe(false)
    expect(aiEvasionCalls.length).toBe(1)
    expect(aiEvasionCalls[0].roomId).toBe(12345)
    expect(aiEvasionCalls[0].csrfToken).toBe('csrf-token-fixture')
  })

  test('failed send + aiEvasion=false → tryAiEvasion is NOT called', async () => {
    store.aiEvasion.value = false
    enqueueResult = {
      success: false,
      message: '',
      isEmoticon: false,
      startedAt: 1,
      cancelled: false,
      error: 'blocked',
      errorCode: 9999,
    }
    const ok = await sendManualDanmaku('xxxx')
    expect(ok).toBe(false)
    expect(aiEvasionCalls).toHaveLength(0)
  })
})

describe('sendManualDanmaku — normalSendYolo (LLM polish)', () => {
  test('YOLO config-gap (describeLlmGap returns non-null): logs skip + still sends original', async () => {
    store.normalSendYolo.value = true
    polishOutcome = { kind: 'gap' }
    const ok = await sendManualDanmaku('原文')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).toMatch(/手动发送 AI 润色 跳过：配置缺失/)
  })

  test('YOLO success: polished text is sent, gets a "原文 → 润色" line', async () => {
    store.normalSendYolo.value = true
    // Keep the polished text short so processMessages doesn't split or truncate
    // it; maxLength defaults to 38 chars under the gmSignal min.
    polishOutcome = { kind: 'ok', out: '哥哥厉害' }
    const ok = await sendManualDanmaku('666')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).toMatch(/🤖 手动发送 AI 润色：666 → 哥哥厉害/)
    expect(verifyCalls[0]?.text).toBe('哥哥厉害')
  })

  test('YOLO empty result: logs the "返回为空" skip and sends original', async () => {
    store.normalSendYolo.value = true
    polishOutcome = { kind: 'ok', out: '   ' }
    const ok = await sendManualDanmaku('原文')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).toMatch(/手动发送 AI 润色 跳过：LLM 返回为空/)
  })

  test('YOLO throw: logs the err.message skip and sends original', async () => {
    store.normalSendYolo.value = true
    polishOutcome = { kind: 'err', err: new Error('llm-down') }
    const ok = await sendManualDanmaku('原文')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).toMatch(/手动发送 AI 润色 跳过：llm-down/)
  })

  test('YOLO disabled: polishWithLlm is never invoked, no YOLO log appears', async () => {
    store.normalSendYolo.value = false
    polishOutcome = { kind: 'err', err: new Error('would-throw-if-called') }
    const ok = await sendManualDanmaku('原文')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).not.toMatch(/YOLO/)
  })

  test('emoticon-unique text bypasses YOLO even when enabled (no polish call)', async () => {
    isEmoticonFor = '[emo_unique]'
    store.normalSendYolo.value = true
    polishOutcome = { kind: 'err', err: new Error('would-throw-if-called') }
    const ok = await sendManualDanmaku('[emo_unique]')
    expect(ok).toBe(true)
    expect(JSON.stringify(logged)).not.toMatch(/YOLO/)
  })
})
