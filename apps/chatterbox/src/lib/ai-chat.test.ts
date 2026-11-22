import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { SendDanmakuResult } from './api'
import type { DanmakuEvent } from './danmaku-stream'
import type { ChatCompletionOptions, LlmContentPart } from './llm'
import type { LlmProviderProfile, VisionMode } from './store'
import type { LumaSample, RecentClip, SceneCutEvent, SceneNote, VisionAvailability, VisionFrame } from './vision/types'

import { loadWithFakeGm } from '../testing/fake-gm'
import { loadWithMocks } from '../testing/load-with-mocks'
import { isRecord, parseEmbeddedJson } from './utils'
import { describeAvailability } from './vision/availability'
import { clampVisionFrames, resolveVisionEdge } from './vision/config'
import { LUMA_HEIGHT, LUMA_WIDTH, lumaDiff, SAME_SCENE_DIFF, SCENE_CUT_DIFF } from './vision/luma'
import { selectFrames } from './vision/select-frames'

type HarnessEvent = Omit<DanmakuEvent, 'node'>
type HarnessSubscription = { onMessage?: (event: HarnessEvent) => void }

// Real media-rejection and modality helpers; llm.ts needs the fake GM only to load.
const llm = await loadWithFakeGm<typeof import('./llm')>(new URL('./llm.ts', import.meta.url))
const cleanups: (() => void)[] = []

const PROMPT = '你是直播间里的热心观众'
const VISION_RULES = '你能看到直播画面（按时间先后排列，最后一张或视频结尾是当前画面）。'
const SCENE_TEXT_HINT = '上下文中的 [当前画面] / [画面] 是直播画面的文字描述，仅供理解语境，不要复述。'
const VIEWER_ONLY = '主播刚刚说："（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）"'
const FRAMES_HEADER: LlmContentPart = { type: 'text', text: '直播画面截图（按时间先后，最后一张为当前画面）：' }
const IMAGE_REJECTION = 'HTTP 400 Bad Request: {"error":{"message":"This model does not support image input"}}'

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

/** Solid-shade frame; the luma diff between two frames is their shade difference. */
function frame(at: number, shade: number): VisionFrame {
  return {
    at,
    luma: new Uint8Array(LUMA_WIDTH * LUMA_HEIGHT).fill(shade),
    dataUrl: `data:image/jpeg;base64,frame${at}`,
    thumbUrl: `data:image/jpeg;base64,thumb${at}`,
  }
}

function image(at: number): LlmContentPart {
  return { type: 'image_url', image_url: { url: `data:image/jpeg;base64,frame${at}` } }
}

function reply(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ send: true, message: '好耶', reason: '想说', ...fields })
}

function systemText(options: ChatCompletionOptions): string {
  const content = options.messages[0]?.content
  if (typeof content !== 'string') throw new Error('System content is not text')
  return content
}

function userParts(options: ChatCompletionOptions): LlmContentPart[] {
  const content = options.messages[1]?.content
  return Array.isArray(content) ? content : []
}

function userText(options: ChatCompletionOptions): string {
  const content = options.messages[1]?.content
  if (typeof content === 'string') return content
  const first = content?.[0]
  return first?.type === 'text' ? first.text : ''
}

function frameLabels(options: ChatCompletionOptions): string[] {
  return userParts(options).flatMap(part => (part.type === 'text' && part.text.startsWith('【') ? [part.text] : []))
}

interface VisionFakes {
  kept: VisionFrame[]
  current: VisionFrame | null
  latestSample: LumaSample | null
  clip: RecentClip | null
  scenes: SceneNote[]
  freshScene: SceneNote | null
}

async function createHarness() {
  const { signal } = signals
  const provider: LlmProviderProfile = {
    id: 'p1',
    name: '测试服务商',
    apiBase: 'https://llm.test/v1',
    apiKey: 'key',
    model: 'vision-model',
    models: [],
  }
  const settings = {
    activeLlmProvider: signal<LlmProviderProfile | null>(provider),
    aiChatAutoSend: signal(false),
    aiChatContextMaxChars: signal(2000),
    aiChatMaxMessageLength: signal(100),
    aiChatTemperature: signal(1),
    aiChatViewerInterval: signal(1),
    aiChatViewerWindow: signal(10),
    sttEndpointReached: signal(false),
    sttTranscriptBuffer: signal(''),
    sttUtteranceStartedAt: signal<number | null>(null),
    visionClipEnabled: signal(false),
    visionEnabled: signal(false),
    visionMaxEdge: signal(768),
    visionMaxFrames: signal(2),
    visionMode: signal<VisionMode>('direct'),
    visionVisualTrigger: signal(false),
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
  const timers = new Map<number, { callback: () => void; delay: number }>()
  let lastTimerId = 0
  const schedule = mock((callback: () => void, delay: number) => {
    timers.set(++lastTimerId, { callback, delay })
    return lastTimerId
  })
  class FakeDate extends Date {
    constructor(value: number = now) {
      super(value)
    }
    static now() {
      return now
    }
  }
  const replies: (string | Error)[] = []
  const chatCompletion = mock(async (options: ChatCompletionOptions): Promise<string> => {
    const next = replies.shift() ?? reply()
    if (next instanceof Error) throw next
    options.onPromptTokens?.(1234)
    return next
  })
  const log = mock((..._args: unknown[]) => {})
  const visionAvailability = signal<VisionAvailability>('ok')
  const fakes: VisionFakes = { kept: [], current: null, latestSample: null, clip: null, scenes: [], freshScene: null }
  const grabCurrentFrame = mock(async () => fakes.current)
  const getRecentClip = mock(async () => fakes.clip)
  const requestFreshScene = mock(async (_maxAgeMs: number, _timeoutMs?: number) => fakes.freshScene)
  const recordScene = mock((scene: string, noteSource: SceneNote['source'], at = now) => {
    fakes.scenes.push({ at, scene, source: noteSource })
  })
  let sceneCutListener: ((event: SceneCutEvent) => void) | undefined
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
    './llm': {
      chatCompletion,
      classifyMediaRejection: llm.classifyMediaRejection,
      modelRejectsImages: llm.modelRejectsImages,
    },
    './llm-tasks': { isLlmReady: () => true },
    './log': { appendLog: log },
    './prompts': { getActiveLlmPrompt: () => PROMPT },
    './send-queue': { enqueueDanmaku: enqueue, SendPriority: { AUTO: 0 } },
    './store': settings,
    './utils': { isRecord, parseEmbeddedJson },
    './vision/availability': { describeAvailability },
    './vision/captioner': { requestFreshScene },
    './vision/clip-recorder': { getRecentClip },
    './vision/config': { clampVisionFrames, resolveVisionEdge },
    './vision/frame-sampler': {
      getKeptFrames: () => fakes.kept,
      getLatestSample: () => fakes.latestSample,
      grabCurrentFrame,
      onSceneCut: (listener: (event: SceneCutEvent) => void) => {
        sceneCutListener = listener
        return () => {
          sceneCutListener = undefined
        }
      },
      visionAvailability,
    },
    './vision/luma': { lumaDiff, SAME_SCENE_DIFF, SCENE_CUT_DIFF },
    './vision/scene-memory': {
      latestScene: (maxAgeMs: number, at = now) => {
        const newest = fakes.scenes.at(-1)
        return newest && at - newest.at <= maxAgeMs ? newest : null
      },
      recordScene,
    },
    './vision/select-frames': { selectFrames },
  }
  const clock = { Date: FakeDate, setTimeout: schedule, clearTimeout: (id: number) => timers.delete(id) }
  const engine = await loadWithMocks<typeof import('./ai-chat')>(
    new URL('./ai-chat.ts', import.meta.url),
    dependencies,
    clock
  )
  cleanups.push(() => engine.stopAiChatEngine())
  engine.startAiChatEngine()

  async function send(text = '好耶') {
    engine.pendingCandidates.value = [
      {
        id: 1,
        transcript: '',
        decision: { send: true, message: text, reason: '', scene: '', usesScene: false },
        createdAt: now,
        frames: [],
        stale: false,
      },
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

  async function settle() {
    for (let i = 0; i < 20 && engine.aiChatStatus.value === 'generating'; i++) await flush()
  }

  function pendingDelays(): number[] {
    return [...timers.values()].map(timer => timer.delay)
  }

  /** Fire the pending timer with this delay, e.g. a scheduled round, and let that round finish. */
  async function fire(delay: number) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay)
    if (!entry) throw new Error(`No pending ${delay} ms timer`)
    timers.delete(entry[0])
    entry[1].callback()
    await settle()
  }

  /** The streamer finishes an utterance; `startedAt` is the STT tab's stamp. */
  async function say(text: string, startedAt: number | null = now - 2_000) {
    settings.sttUtteranceStartedAt.value = startedAt
    settings.sttTranscriptBuffer.value = text
    settings.sttEndpointReached.value = true
    await fire(500)
  }

  async function triggerNow() {
    engine.triggerNow()
    await settle()
  }

  function cut(event: SceneCutEvent) {
    sceneCutListener?.(event)
  }

  function call(index = -1): ChatCompletionOptions {
    const options = chatCompletion.mock.calls.at(index)?.[0]
    if (!options) throw new Error('chatCompletion was not called')
    return options
  }

  return {
    engine,
    enqueue,
    schedule,
    send,
    message,
    restart,
    deferSend,
    advance: (ms: number) => (now += ms),
    provider,
    settings,
    fakes,
    visionAvailability,
    replies,
    chatCompletion,
    log,
    grabCurrentFrame,
    getRecentClip,
    requestFreshScene,
    recordScene,
    settle,
    pendingDelays,
    fire,
    say,
    triggerNow,
    cut,
    call,
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('AI chat context', () => {
  test('viewer chat over half the context budget keeps its newest lines', async () => {
    const h = await createHarness()
    // Budget 40: the header and two 13-char lines fit (37), a third would not (51).
    h.settings.aiChatContextMaxChars.value = 80
    for (const text of ['第一条弹幕内容', '第二条弹幕内容', '第三条弹幕内容']) h.message(text)
    await h.fire(3_000)
    expect(h.call().messages[1].content).toBe(
      '上下文（最近的发送 / 观众弹幕）：\n"""\n[最近观众弹幕]:\n  观众: 第二条弹幕内容\n  观众: 第三条弹幕内容\n"""\n\n' +
        '主播刚刚说：\n"""\n（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）\n"""\n'
    )
  })

  test('a review-mode candidate counts as said, as sent once accepted, and as unsaid once skipped', async () => {
    const h = await createHarness()
    h.replies.push(reply({ message: '泡沫的真没怎么见过' }), reply({ message: '干粉最常见' }))
    await h.say('泡沫的我都没怎么见过')
    await h.say('最常见的是干粉')
    expect(userText(h.call())).toContain('[主播]: 泡沫的我都没怎么见过\n[你已发送]: [候选:泡沫的真没怎么见过]\n')

    const [first, second] = h.engine.pendingCandidates.value
    h.engine.acceptCandidate(first.id, '泡沫的是少见')
    await flush()
    h.engine.skipCandidate(second.id)
    await h.say('嗯 就是')
    expect(userText(h.call())).toContain(
      '[主播]: 泡沫的我都没怎么见过\n[你已发送]: 泡沫的是少见\n\n[主播]: 最常见的是干粉\n[你已发送]: [未采用:干粉最常见]\n'
    )
  })
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

describe('AI chat stream vision', () => {
  test('with vision off the request keeps the text-only shape and touches no vision source', async () => {
    const h = await createHarness()
    h.fakes.current = frame(10_000, 120)
    h.replies.push(reply({ scene: '不该被读取', uses_scene: true }))
    await h.say('大家好')

    const options = h.call()
    const time = new Date(10_000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    expect(options.messages).toEqual([
      {
        role: 'system',
        content:
          `${PROMPT}\n\n当前时间：${time}\n\n` +
          '上下文中 [你已发送] 后面是你每一轮的结果：直接写出的弹幕是你发出的；[候选:…] 是你提出、等待用户确认的，也算你说过的话；' +
          '[未采用:…] 是用户没有采用、没有发出的，不算你说过的话，也不要再提；[跳过:…] 是你没有发言的轮次。' +
          '你始终是同一位观众：不要和自己说过的话相矛盾或改口，也不要重复说过的话；弹幕区的说法和你之前说的相反时，跳过本次发送。\n\n' +
          '主播的话来自实时语音识别，只能用来大致了解主播在聊什么、情绪如何，不能当作原话：\n' +
          '- 常有同音、近音的错字或多余的字，例如把「粤语版」识别成「越越版」\n' +
          '- 夹杂的日语、英语等外语会被识别成读音相近的中文词，例如把日语「苦しい」（好难受）识别成「苦肉计」\n' +
          '- 读得通的中文也可能识别错了，句子也常是片段\n' +
          '所以不要在弹幕里引用或复述识别出的字词，也不要围绕其中的具体说法（人名、歌名、术语、数字等）发挥，具体说法以观众弹幕和画面为准；' +
          '上下文中的 [主播] 和角色设定里提到的「主播刚说的内容」同样如此。看不出主播大概在说什么时，跳过本次发送。\n' +
          '上下文中包含最近的发送记录与最新观众弹幕，请综合理解后再决定是否发送。\n\n' +
          '你必须返回一个 JSON 对象，包含三个字段：\n' +
          '- "send" (boolean)：当前内容是否值得作为弹幕发送\n' +
          '- "message" (string)：要发送的弹幕，长度不超过 100 个字符；send 为 false 时为空串\n' +
          '- "reason" (string)：你做此决定的简短理由\n' +
          '返回示例：{"send": true, "message": "要发送的弹幕", "reason": "简短理由"}\n',
      },
      { role: 'user', content: '主播刚刚说（语音识别，仅供参考）："大家好"' },
    ])
    expect(JSON.stringify(options.responseFormat)).toBe(
      '{"type":"json_schema","json_schema":{"name":"ai_chat_response","strict":true,"schema":{"type":"object",' +
        '"properties":{"send":{"type":"boolean"},"message":{"type":"string","maxLength":100},"reason":{"type":"string"}},' +
        '"required":["send","message","reason"],"additionalProperties":false}}}'
    )
    expect(Object.keys(options).sort()).toEqual([
      'apiKey',
      'base',
      'messages',
      'model',
      'onPromptTokens',
      'responseFormat',
      'signal',
      'temperature',
    ])
    expect([options.base, options.apiKey, options.model, options.temperature]).toEqual([
      'https://llm.test/v1',
      'key',
      'vision-model',
      1,
    ])
    expect(h.engine.pendingCandidates.value).toMatchObject([
      { decision: { scene: '', usesScene: false }, frames: [], stale: false },
    ])

    h.message('主播晚上好')
    await h.fire(3_000)
    expect(h.call().messages[1].content).toBe(
      '上下文（最近的发送 / 观众弹幕）：\n"""\n[主播]: 大家好\n[你已发送]: [候选:好耶]\n\n[最近观众弹幕]:\n  观众: 主播晚上好\n"""\n\n' +
        '主播刚刚说：\n"""\n（暂无主播语音；请仅基于上下文中的观众弹幕做出反应）\n"""\n'
    )
    expect(h.grabCurrentFrame).not.toHaveBeenCalled()
    expect(h.getRecentClip).not.toHaveBeenCalled()
    expect(h.requestFreshScene).not.toHaveBeenCalled()
    expect(h.recordScene).not.toHaveBeenCalled()
  })

  test('direct mode attaches labelled frames after the text and records the model scene', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    const current = frame(10_000, 120)
    h.fakes.kept = [frame(5_000, 0)]
    h.fakes.current = current
    h.fakes.latestSample = { at: current.at, luma: current.luma }
    h.replies.push(reply({ message: '好看', scene: '  主播在画一只猫  ', uses_scene: true }))
    await h.say('看我画的', 6_000)

    const options = h.call()
    expect(options.messages[1].content).toEqual([
      { type: 'text', text: '主播刚刚说（语音识别，仅供参考）："看我画的"' },
      FRAMES_HEADER,
      { type: 'text', text: '【5 秒前】' },
      image(5_000),
      { type: 'text', text: '【当前】' },
      image(10_000),
    ])
    const system = systemText(options)
    expect(system).toContain(`请综合理解后再决定是否发送。\n\n${VISION_RULES}`)
    expect(system).toContain(
      '- 不评论主播的身材、长相，不读出画面中的个人信息\n\n你必须返回一个 JSON 对象，包含五个字段：\n'
    )
    expect(system).toContain(
      '- "scene" (string)：用不超过 20 个字记录当前画面要点，仅供你之后参考，不会发送\n' +
        '- "uses_scene" (boolean)：message 是否依赖画面内容\n' +
        '返回示例：{"send": true, "message": "要发送的弹幕", "reason": "简短理由", "scene": "画面要点", "uses_scene": false}\n'
    )
    expect(system).not.toContain(SCENE_TEXT_HINT)
    expect(options.responseFormat).toMatchObject({
      json_schema: {
        schema: {
          properties: { scene: { type: 'string', maxLength: 40 }, uses_scene: { type: 'boolean' } },
          required: ['send', 'message', 'reason', 'scene', 'uses_scene'],
        },
      },
    })
    expect(h.recordScene).toHaveBeenCalledWith('主播在画一只猫', 'chat', 10_000)
    expect(h.engine.pendingCandidates.value).toMatchObject([
      {
        decision: { message: '好看', scene: '主播在画一只猫', usesScene: true },
        frames: [
          { thumbUrl: 'data:image/jpeg;base64,thumb5000', label: '5 秒前' },
          { thumbUrl: 'data:image/jpeg;base64,thumb10000', label: '当前' },
        ],
        stale: false,
      },
    ])
    expect(h.engine.aiChatVisionNote.value).toBe('')
  })

  test('立即生成 sends only the current frame, at low detail for the 512 px setting', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionMaxEdge.value = 512
    h.fakes.kept = [frame(5_000, 0)]
    h.fakes.current = frame(10_000, 120)
    await h.triggerNow()

    expect(userParts(h.call())).toEqual([
      { type: 'text', text: VIEWER_ONLY },
      FRAMES_HEADER,
      { type: 'text', text: '【当前】' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,frame10000', detail: 'low' } },
    ])
  })

  test('an unseen picture adds a note line instead of images', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.visionAvailability.value = 'paused'
    await h.triggerNow()

    const options = h.call()
    expect(options.messages[1].content).toBe(`${VIEWER_ONLY}\n（当前看不到直播画面：直播未在播放）`)
    expect(systemText(options)).not.toContain(VISION_RULES)
    expect(systemText(options)).not.toContain(SCENE_TEXT_HINT)
    expect(options.responseFormat).toMatchObject({
      json_schema: { schema: { required: ['send', 'message', 'reason'] } },
    })
    expect(h.grabCurrentFrame).not.toHaveBeenCalled()

    h.visionAvailability.value = 'ok'
    await h.triggerNow()
    expect(h.grabCurrentFrame).toHaveBeenCalledTimes(1)
    expect(h.call().messages[1].content).toEndWith('"""\n\n（当前看不到直播画面）')
  })

  test('a model listed as text-only gets no frames and a vision note', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.activeLlmProvider.value = { ...h.provider, models: [{ id: 'vision-model', inputModalities: ['text'] }] }
    h.fakes.current = frame(10_000, 120)
    await h.triggerNow()

    expect(h.call().messages[1].content).toBe(VIEWER_ONLY)
    expect(h.grabCurrentFrame).not.toHaveBeenCalled()
    expect(h.engine.aiChatVisionNote.value).toBe('当前模型不支持图片输入')
  })

  test('an unchanged picture within a minute sends the last scene note instead of images', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.replies.push(reply({ scene: '主播在画画' }))
    await h.triggerNow()
    expect(frameLabels(h.call())).toEqual(['【当前】'])

    h.advance(30_000)
    h.fakes.current = frame(40_000, 122)
    await h.triggerNow()
    const options = h.call()
    expect(options.messages[1].content).toEndWith('"""\n\n（画面与上次基本相同：主播在画画）')
    expect(systemText(options)).toContain(`请仅基于观众弹幕综合判断后再决定是否发送。\n\n${SCENE_TEXT_HINT}\n\n你必须`)
    expect(systemText(options)).not.toContain(VISION_RULES)
    expect(h.engine.pendingCandidates.value.at(-1)).toMatchObject({ frames: [], decision: { scene: '主播在画画' } })

    h.advance(30_000)
    h.fakes.current = frame(70_000, 122)
    await h.triggerNow()
    expect(frameLabels(h.call())).toEqual(['【当前】'])
  })

  test('the unchanged-picture shortcut ignores a scene note older than the last upload', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.scenes.push({ at: 5_000, scene: '上一个画面', source: 'chat' })
    h.fakes.current = frame(10_000, 120)
    await h.triggerNow()

    h.advance(10_000)
    h.fakes.current = frame(20_000, 121)
    await h.triggerNow()
    expect(frameLabels(h.call())).toEqual(['【当前】'])
    expect(userText(h.call())).not.toContain('上一个画面')
  })

  test('caption mode adds a [当前画面] note of the last 15 s and asks only whether the reply uses it', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionMode.value = 'caption'
    h.advance(20_000)
    h.fakes.freshScene = { at: 28_000, scene: '主播在唱歌', source: 'caption' }
    await h.triggerNow()

    expect(h.requestFreshScene).toHaveBeenCalledWith(15_000, 8_000)
    const options = h.call()
    expect(options.messages[1].content).toBe(`${VIEWER_ONLY}\n[当前画面]: 主播在唱歌`)
    expect(systemText(options)).toContain(SCENE_TEXT_HINT)
    expect(systemText(options)).not.toContain(VISION_RULES)
    expect(systemText(options)).toContain('包含四个字段')
    expect(systemText(options)).toContain('"uses_scene" (boolean)')
    expect(systemText(options)).not.toContain('"scene" (string)')
    expect(options.responseFormat).toMatchObject({
      json_schema: { schema: { required: ['send', 'message', 'reason', 'uses_scene'] } },
    })
    expect(h.grabCurrentFrame).not.toHaveBeenCalled()
    expect(h.recordScene).not.toHaveBeenCalled()
    expect(h.engine.pendingCandidates.value).toMatchObject([
      { decision: { scene: '主播在唱歌', usesScene: false }, frames: [], stale: false },
    ])
  })

  test('caption mode never takes a caption from before the latest cut', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionMode.value = 'caption'
    h.settings.visionVisualTrigger.value = true
    h.advance(20_000)
    h.fakes.freshScene = { at: 30_000, scene: '主播换了游戏', source: 'caption' }
    h.cut({ at: 29_000, before: frame(27_000, 0), after: frame(29_000, 200) })
    await h.fire(500)
    expect(h.requestFreshScene).toHaveBeenLastCalledWith(29_000, 8_000)
    expect(h.call().messages[1].content).toEndWith('\n[当前画面]: 主播换了游戏')

    h.advance(5_000)
    await h.triggerNow()
    expect(h.requestFreshScene).toHaveBeenLastCalledWith(29_000, 8_000)
  })

  test('a reply that uses a text picture note is dropped once a cut follows the note’s picture', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionMode.value = 'caption'
    h.settings.aiChatAutoSend.value = true
    h.fakes.freshScene = { at: 8_000, scene: '主播在唱歌', source: 'caption' }
    h.replies.push(reply({ uses_scene: true }))
    await h.triggerNow()
    expect(h.enqueue).toHaveBeenCalledTimes(1)

    // The cut lands while the second round is being generated.
    h.chatCompletion.mockImplementationOnce(async () => {
      h.cut({ at: 10_500, before: frame(8_000, 0), after: frame(10_500, 200) })
      return reply({ uses_scene: true })
    })
    h.advance(1_000)
    await h.triggerNow()
    expect(h.enqueue).toHaveBeenCalledTimes(1)
    expect(h.engine.aiChatHistory.value.at(-1)).toMatchObject({ message: '', reason: '画面已变化，放弃可能过时的弹幕' })
  })

  test('a clip goes out as video_url, and a video rejection retries with frames for the rest of the session', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionClipEnabled.value = true
    h.fakes.kept = [frame(5_000, 0)]
    h.fakes.current = frame(10_000, 120)
    h.fakes.clip = { dataUrl: 'data:video/mp4;base64,clip', mimeType: 'video/mp4', durationMs: 4_000, endedAt: 10_000 }
    await h.triggerNow()

    expect(userParts(h.call())).toEqual([
      { type: 'text', text: VIEWER_ONLY },
      { type: 'text', text: '最近几秒的直播画面视频片段（无声）：' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,clip' } },
    ])
    expect(systemText(h.call())).toContain(VISION_RULES)
    expect(h.engine.pendingCandidates.value.at(-1)?.frames).toEqual([
      { thumbUrl: 'data:image/jpeg;base64,thumb10000', label: '视频片段' },
    ])

    h.advance(5_000)
    h.fakes.current = frame(15_000, 30)
    h.replies.push(
      new Error('HTTP 400 Bad Request: {"error":{"message":"video_url is not supported by this model"}}'),
      reply()
    )
    h.message('主播在干嘛')
    await h.fire(3_000)
    expect(h.chatCompletion).toHaveBeenCalledTimes(3)
    expect(userParts(h.call(1))).toContainEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,clip' } })
    expect(userParts(h.call(2)).slice(1)).toEqual([
      FRAMES_HEADER,
      { type: 'text', text: '【10 秒前】' },
      image(5_000),
      { type: 'text', text: '【当前】' },
      image(15_000),
    ])
    expect(h.log).toHaveBeenCalledWith('ℹ️ [AI 融入] 当前模型不支持视频片段，已改用截图')
    expect(h.engine.pendingCandidates.value.at(-1)?.frames.map(thumb => thumb.label)).toEqual(['10 秒前', '当前'])

    h.advance(5_000)
    h.fakes.current = frame(20_000, 200)
    await h.triggerNow()
    expect(h.getRecentClip).toHaveBeenCalledTimes(2)
    expect(frameLabels(h.call())).toEqual(['【当前】'])
  })

  test('an image rejection retries text-only and keeps the downgrade for the session', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.replies.push(new Error(IMAGE_REJECTION), reply({ scene: '不该被读取', uses_scene: true }))
    await h.triggerNow()

    expect(h.chatCompletion).toHaveBeenCalledTimes(2)
    expect(userParts(h.call(0))).toHaveLength(4)
    const retry = h.call(1)
    expect(retry.messages[1].content).toBe(VIEWER_ONLY)
    expect(systemText(retry)).not.toContain(VISION_RULES)
    expect(retry.responseFormat).toMatchObject({ json_schema: { schema: { required: ['send', 'message', 'reason'] } } })
    expect(h.engine.aiChatVisionNote.value).toBe('当前模型不支持图片输入，已改为纯文本')
    expect(h.engine.pendingCandidates.value).toMatchObject([{ decision: { scene: '', usesScene: false }, frames: [] }])
    expect(h.recordScene).not.toHaveBeenCalled()

    h.engine.aiChatVisionNote.value = ''
    await h.triggerNow()
    expect(h.grabCurrentFrame).toHaveBeenCalledTimes(1)
    expect(h.call().messages[1].content).toBeString()
    expect(h.engine.aiChatVisionNote.value).toBe('当前模型不支持图片输入，已改为纯文本')
    expect(
      h.log.mock.calls.filter(([line]) => line === '⚠️ [AI 融入] 当前模型不支持图片输入，已改为纯文本')
    ).toHaveLength(1)
  })

  test('a bare 413 retries this round text-only but keeps frames for later rounds', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.replies.push(new Error('HTTP 413 Payload Too Large: request entity too large'))
    await h.triggerNow()

    expect(h.chatCompletion).toHaveBeenCalledTimes(2)
    expect(userParts(h.call(0))).toHaveLength(4)
    expect(h.call(1).messages[1].content).toBe(VIEWER_ONLY)
    expect(h.engine.aiChatVisionNote.value).toBe('')
    expect(h.log.mock.calls.some(([line]) => String(line).includes('HTTP 413'))).toBe(true)

    h.fakes.current = frame(20_000, 200)
    await h.triggerNow()
    expect(userParts(h.call())).toHaveLength(4)
  })

  test('a picture-dependent reply is dropped in auto mode and flagged in review mode once the picture cut away', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.aiChatAutoSend.value = true
    h.fakes.current = frame(10_000, 0)
    h.fakes.latestSample = { at: 11_000, luma: frame(11_000, 200).luma }
    h.replies.push(reply({ message: '这个手办好看', scene: '主播展示手办', uses_scene: true }))
    await h.triggerNow()

    expect(h.enqueue).not.toHaveBeenCalled()
    expect(h.engine.aiChatHistory.value.at(-1)).toMatchObject({
      message: '',
      reason: '画面已变化，放弃可能过时的弹幕',
      sent: false,
      scene: '主播展示手办',
      frames: [{ thumbUrl: 'data:image/jpeg;base64,thumb10000', label: '当前' }],
    })

    h.fakes.current = frame(10_000, 100)
    h.replies.push(reply({ message: '晚上好', uses_scene: false }))
    await h.triggerNow()
    expect(h.enqueue).toHaveBeenCalledTimes(1)

    h.settings.aiChatAutoSend.value = false
    h.fakes.current = frame(10_000, 50)
    h.replies.push(reply({ message: '这个手办好看', uses_scene: true }))
    await h.triggerNow()
    expect(h.engine.pendingCandidates.value).toMatchObject([{ decision: { message: '这个手办好看' }, stale: true }])
  })

  test('a sample from before the uploaded picture never marks a reply stale', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.aiChatAutoSend.value = true
    h.fakes.current = frame(10_000, 0)
    // The 1 Hz sampler last saw the picture before a cut that the grab already caught.
    h.fakes.latestSample = { at: 9_500, luma: frame(9_500, 200).luma }
    h.replies.push(reply({ message: '这个手办好看', uses_scene: true }))
    await h.triggerNow()
    expect(h.enqueue).toHaveBeenCalledTimes(1)
  })

  test('nothing gathered while 看画面 is switched off goes out', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionMode.value = 'caption'
    const note = Promise.withResolvers<SceneNote | null>()
    h.requestFreshScene.mockImplementationOnce(() => note.promise)
    h.engine.triggerNow()
    await flush()
    h.settings.visionEnabled.value = false
    note.resolve({ at: 10_000, scene: '主播在打 Boss', source: 'caption' })
    await h.settle()
    expect(h.chatCompletion).toHaveBeenCalledTimes(1)
    expect(h.call().messages[1].content).toBe(VIEWER_ONLY)
  })

  test('a retry after 看画面 is switched off sends no pictures', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.chatCompletion.mockImplementationOnce(async () => {
      h.settings.visionEnabled.value = false
      throw new Error('HTTP 400 Bad Request: response_format is not supported')
    })
    await h.triggerNow()
    expect(h.chatCompletion).toHaveBeenCalledTimes(2)
    expect(userParts(h.call(0))).toContainEqual(image(10_000))
    expect(h.call(1).messages[1].content).toBe(VIEWER_ONLY)
  })

  test('a clip too large for the provider retries this round with frames and keeps clips for later rounds', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionClipEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.fakes.clip = { dataUrl: 'data:video/mp4;base64,clip', mimeType: 'video/mp4', durationMs: 4_000, endedAt: 10_000 }
    h.replies.push(new Error('HTTP 413 Payload Too Large'), reply())
    await h.triggerNow()
    expect(h.chatCompletion).toHaveBeenCalledTimes(2)
    expect(userParts(h.call(1))).toContainEqual(image(10_000))
    expect(h.log).toHaveBeenCalledWith('⚠️ [AI 融入] 视频片段过大被服务商拒绝（HTTP 413），本轮改用截图')

    h.advance(5_000)
    h.fakes.current = frame(15_000, 30)
    await h.triggerNow()
    expect(userParts(h.call())).toContainEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,clip' } })
  })

  test('a picture-dependent reply still queued when the picture cuts away is cancelled at dispatch', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.aiChatAutoSend.value = true
    h.fakes.current = frame(10_000, 100)
    h.fakes.latestSample = { at: 10_000, luma: frame(10_000, 100).luma }
    h.replies.push(reply({ message: '这个手办好看', scene: '主播展示手办', uses_scene: true }))
    const queued = h.deferSend(false)
    await h.triggerNow()
    expect(h.enqueue).toHaveBeenCalledTimes(1)

    h.fakes.latestSample = { at: 11_000, luma: frame(11_000, 220).luma }
    expect(queued.dispatch()).toBe(false)
    await h.settle()
    expect(h.engine.aiChatHistory.value.at(-1)).toMatchObject({
      message: '',
      reason: '画面已变化，放弃可能过时的弹幕',
      sent: false,
    })
  })

  test('a scene cut during silence schedules one visual round that runs with an empty transcript', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    const before = frame(8_000, 100)
    // Further from the current picture, but older than the cut: outside the visual window.
    h.fakes.kept = [frame(1_000, 0), before]
    h.fakes.current = frame(10_000, 200)
    const event: SceneCutEvent = { at: 10_000, before, after: h.fakes.current }

    h.cut(event)
    h.settings.visionVisualTrigger.value = true
    h.settings.visionEnabled.value = false
    h.cut(event)
    expect(h.schedule).not.toHaveBeenCalled()

    h.settings.visionEnabled.value = true
    h.cut(event)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([500])
    expect(h.engine.aiChatStatus.value).toBe('waiting')
    await h.fire(500)

    const options = h.call()
    expect(userText(options)).toBe('主播刚刚说："（主播没有说话；本轮由直播画面变化触发）"')
    expect(systemText(options)).toContain(
      '主播目前没有说话，本轮由直播画面的明显变化触发。上下文中包含最近的发送记录与最新观众弹幕；画面变化不值得回应时不要发送。\n\n'
    )
    expect(frameLabels(options)).toEqual(['【2 秒前】', '【当前】'])

    h.advance(59_000)
    h.cut({ ...event, at: 69_000 })
    expect(h.pendingDelays()).toEqual([])
    h.advance(1_000)
    h.cut({ ...event, at: 70_000 })
    expect(h.pendingDelays()).toEqual([500])
  })

  test('a visual trigger waits a minute after any decided round', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionVisualTrigger.value = true
    h.fakes.current = frame(10_000, 200)
    await h.triggerNow()
    const event: SceneCutEvent = { at: 10_000, before: null, after: h.fakes.current }

    h.advance(59_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([])
    h.advance(1_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([500])
  })

  test('visual triggers wait for an idle engine and an empty transcript buffer', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionVisualTrigger.value = true
    h.fakes.current = frame(10_000, 200)
    const event: SceneCutEvent = { at: 10_000, before: null, after: h.fakes.current }
    const pending = Promise.withResolvers<string>()
    h.chatCompletion.mockImplementationOnce(() => pending.promise)
    h.engine.triggerNow()
    await flush()
    expect(h.engine.aiChatStatus.value).toBe('generating')

    h.cut(event)
    h.settings.sttTranscriptBuffer.value = '我先说两句'
    pending.resolve(reply({ send: false }))
    await h.settle()
    h.advance(60_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([])

    h.settings.sttTranscriptBuffer.value = ''
    h.cut(event)
    expect(h.pendingDelays()).toEqual([500])
  })

  test('a visual round that cannot see the picture makes no call but still counts toward the interval', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionVisualTrigger.value = true
    h.visionAvailability.value = 'hidden'
    const event: SceneCutEvent = { at: 10_000, before: null, after: frame(10_000, 200) }
    h.cut(event)
    await h.fire(500)
    expect(h.chatCompletion).not.toHaveBeenCalled()
    expect(h.engine.aiChatStatus.value).toBe('idle')

    h.visionAvailability.value = 'ok'
    h.advance(30_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([])
    h.advance(30_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([500])
  })

  test('a transcript round takes frames from its utterance onward and consumes the utterance stamp', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.advance(20_000)
    h.fakes.kept = [frame(15_000, 0), frame(22_000, 60)]
    h.fakes.current = frame(30_000, 120)
    await h.say('刚才那个', 21_500)
    expect(frameLabels(h.call())).toEqual(['【8 秒前】', '【当前】'])
    expect(h.settings.sttUtteranceStartedAt.value).toBeNull()
    // Consuming the buffer must not re-arm an empty transcript round.
    expect(h.pendingDelays()).toEqual([])

    await h.say('再说一遍', null)
    expect(frameLabels(h.call())).toEqual(['【15 秒前】', '【当前】'])

    h.settings.sttUtteranceStartedAt.value = 25_000
    h.restart()
    expect(h.settings.sttUtteranceStartedAt.value).toBeNull()
  })

  test('a round that consumes no speech keeps the stamp of the utterance still in progress', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.advance(20_000)
    h.fakes.current = frame(30_000, 120)
    h.settings.sttUtteranceStartedAt.value = 27_000
    h.message('主播在干嘛')
    await h.fire(3_000)
    expect(h.settings.sttUtteranceStartedAt.value).toBe(27_000)
  })

  test('a viewer round looks back 12 s', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.advance(20_000)
    h.fakes.kept = [frame(15_000, 0), frame(20_000, 60)]
    h.fakes.current = frame(30_000, 120)
    h.message('主播在干嘛')
    await h.fire(3_000)
    expect(frameLabels(h.call())).toEqual(['【10 秒前】', '【当前】'])
  })

  test('reported prompt tokens feed aiChatLastPromptTokens, and a call without them clears it', async () => {
    const h = await createHarness()
    expect(h.engine.aiChatLastPromptTokens.value).toBeNull()
    await h.triggerNow()
    expect(h.engine.aiChatLastPromptTokens.value).toBe(1234)
    h.chatCompletion.mockImplementationOnce(async () => reply())
    await h.triggerNow()
    expect(h.engine.aiChatLastPromptTokens.value).toBeNull()
  })

  test('changing the active provider or model clears the vision note', async () => {
    const h = await createHarness()
    h.engine.aiChatVisionNote.value = '当前模型不支持图片输入，已改为纯文本'
    h.settings.activeLlmProvider.value = { ...h.provider, model: 'other-model' }
    expect(h.engine.aiChatVisionNote.value).toBe('')
  })

  test('a scene cut within 10 s of STT hearing speech start is not silence', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.settings.visionVisualTrigger.value = true
    const now = h.advance(60_000)
    h.settings.sttUtteranceStartedAt.value = now - 5_000
    const event: SceneCutEvent = { at: now, before: frame(now - 2_000, 0), after: frame(now, 200) }
    h.cut(event)
    expect(h.pendingDelays()).toEqual([])
    h.advance(5_000)
    h.cut(event)
    expect(h.pendingDelays()).toEqual([500])
  })

  test('later rounds see each earlier picture note as a [画面] line in the context', async () => {
    const h = await createHarness()
    h.settings.visionEnabled.value = true
    h.fakes.current = frame(10_000, 120)
    h.replies.push(reply({ message: '好看', scene: '主播在画画' }))
    await h.say('看我画的')

    h.advance(5_000)
    h.fakes.current = frame(15_000, 0)
    await h.say('画完了')
    expect(userText(h.call())).toContain('\n[画面]: 主播在画画\n[主播]: 看我画的\n[你已发送]: [候选:好看]\n')
  })
})
