import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as signals from '@preact/signals'

import type { ChatCompletionOptions } from '../llm'
import type { LlmProviderProfile } from '../store'
import type { SceneCutEvent, SceneNote, VisionAvailability, VisionFrame } from './types'

import { loadWithFakeGm } from '../../testing/fake-gm'
import { loadWithMocks } from '../../testing/load-with-mocks'
import { isRecord, parseEmbeddedJson } from '../utils'
import { selectFrames } from './select-frames'

const SYSTEM_PROMPT = [
  '你是直播画面记录员，负责把直播画面截图整理成简短的文字记录，供其他模型理解直播内容。',
  '只描述画面中确实能看到的内容，看不清或不确定的不要猜。忽略画面中滚动的弹幕文字和聊天框。',
  '返回一个 JSON 对象：',
  '- "scene" (string)：不超过 30 个字，概括当前画面（主播在做什么、游戏或场景、画面上值得注意的文字）',
  '- "event" (string)：相比上一条记录刚刚发生的明显变化，没有则为空串',
  '返回示例：{"scene": "主播在玩恐怖游戏，角色站在走廊里", "event": "怪物突然出现"}',
].join('\n')
const HINT = '⚠️ [画面识别] 请在「设置 → 画面识别」选择画面描述模型'
const UNSUPPORTED = '❌ [画面识别] 画面描述模型不支持图片输入'
const START = 100_000
const PROVIDER: LlmProviderProfile = {
  id: 'vision',
  name: '视觉',
  apiBase: 'https://llm.test/v1',
  apiKey: 'key',
  model: 'vision-model',
  models: [],
}

const { classifyMediaRejection } = await loadWithFakeGm<typeof import('../llm')>(new URL('../llm.ts', import.meta.url))
const cleanups: (() => void)[] = []

async function flush(): Promise<void> {
  await Bun.sleep(0)
}

function createClock() {
  let now = START
  let nextId = 0
  const timers = new Map<number, { due: number; run: () => void; every: number }>()
  const add = (run: () => void, ms = 0, every = 0) => {
    timers.set(++nextId, { due: now + ms, run, every })
    return nextId
  }
  const remove = (id?: number) => {
    if (id !== undefined) timers.delete(id)
  }
  return {
    now: () => now,
    globals: {
      Date: { now: () => now },
      setTimeout: (run: () => void, ms?: number) => add(run, ms),
      clearTimeout: remove,
      setInterval: (run: () => void, ms: number) => add(run, ms, ms),
      clearInterval: remove,
    },
    /** Move time forward, firing due timers in order and letting their async work settle. */
    async advance(ms: number) {
      const end = now + ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0]
        if (!due) break
        const [id, timer] = due
        now = timer.due
        if (timer.every) timer.due += timer.every
        else timers.delete(id)
        timer.run()
        await flush()
      }
      now = end
    },
  }
}

function frame(at: number, shade: number): VisionFrame {
  return { at, luma: new Uint8Array(16).fill(shade), dataUrl: `data:image/jpeg;base64,${at}`, thumbUrl: '' }
}

interface PendingCall {
  options: ChatCompletionOptions
  reply: (text: string) => void
  fail: (error: unknown) => void
}

async function createHarness(kept: VisionFrame[] = []) {
  const { signal } = signals
  const clock = createClock()
  const provider = signal<LlmProviderProfile | null>(PROVIDER)
  const model = signal('')
  const availability = signal<VisionAvailability>('ok')
  const calls: PendingCall[] = []
  const log = mock((_message: string) => {})
  let cutListener: ((event: SceneCutEvent) => void) | undefined
  const chatCompletion = (options: ChatCompletionOptions) =>
    new Promise<string>((resolve, reject) => {
      options.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      )
      calls.push({ options, reply: resolve, fail: reject })
    })
  const memory = await loadWithMocks<typeof import('./scene-memory')>(
    new URL('./scene-memory.ts', import.meta.url),
    { '@preact/signals': signals },
    clock.globals
  )
  const captioner = await loadWithMocks<typeof import('./captioner')>(
    new URL('./captioner.ts', import.meta.url),
    {
      '@preact/signals': signals,
      '../llm': { chatCompletion, classifyMediaRejection },
      '../log': { appendLog: log },
      '../store': { visionCaptionModel: model, visionCaptionProvider: provider },
      '../utils': { isRecord, parseEmbeddedJson },
      './frame-sampler': {
        visionAvailability: availability,
        getKeptFrames: () => kept,
        grabCurrentFrame: async () => frame(clock.now(), 200),
        onSceneCut: (listener: (event: SceneCutEvent) => void) => {
          cutListener = listener
          return () => {
            cutListener = undefined
          }
        },
      },
      './scene-memory': memory,
      './select-frames': { selectFrames },
    },
    clock.globals
  )
  cleanups.push(() => captioner.stopCaptioner())

  function cut() {
    cutListener?.({ at: clock.now(), before: null, after: frame(clock.now(), 0) })
  }

  return { ...captioner, memory, clock, provider, model, availability, calls, log, cut }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe('caption request', () => {
  test('sends the previous note and labelled frames with the caption settings', async () => {
    const h = await createHarness([frame(START - 6_000, 0)])
    h.memory.recordScene('主播在聊天', 'caption', START - 20_000)
    h.startCaptioner()
    const pending = h.requestFreshScene(h.clock.now() - 15_000)
    await flush()
    expect(h.calls).toHaveLength(1)
    const { messages, signal, ...settings } = h.calls[0].options
    expect(settings).toEqual({
      base: 'https://llm.test/v1',
      apiKey: 'key',
      model: 'vision-model',
      temperature: 0.2,
      maxTokens: 200,
    })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '上一条记录：主播在聊天' },
          { type: 'text', text: '【6 秒前】' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${START - 6_000}` } },
          { type: 'text', text: '【当前】' },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${START}` } },
        ],
      },
    ])
    h.calls[0].reply('{"scene": "主播在做饭", "event": ""}')
    expect(await pending).toEqual({ at: START, scene: '主播在做饭', source: 'caption' })
  })

  test('uses the model override, frames from the last 12 s, and （无） without a recent note', async () => {
    const h = await createHarness([frame(START - 20_000, 0)])
    h.model.value = ' vision-pro '
    h.memory.recordScene('很久以前的画面', 'caption', START - 120_000)
    h.startCaptioner()
    void h.requestFreshScene(h.clock.now() - 15_000)
    await flush()
    expect(h.calls[0].options.model).toBe('vision-pro')
    expect(h.calls[0].options.messages[1].content).toEqual([
      { type: 'text', text: '上一条记录：（无）' },
      { type: 'text', text: '【当前】' },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${START}` } },
    ])
  })
})

describe('scene notes', () => {
  test.each([
    [
      '{"scene": "主播在玩恐怖游戏，角色站在走廊里", "event": "怪物突然出现"}',
      '主播在玩恐怖游戏，角色站在走廊里；刚刚：怪物突然出现',
    ],
    ['{"scene": " 主播在做饭 ", "event": ""}', '主播在做饭'],
    ['好的：\n```json\n{"scene": "主播在唱歌", "event": "换了首歌"}\n```', '主播在唱歌；刚刚：换了首歌'],
    ['  主播在和观众聊天  ', '主播在和观众聊天'],
  ])('records %j as a caption note', async (reply, scene) => {
    const h = await createHarness()
    h.startCaptioner()
    const pending = h.requestFreshScene(h.clock.now() - 15_000)
    await flush()
    h.calls[0].reply(reply)
    expect(await pending).toEqual({ at: START, scene, source: 'caption' })
    expect(h.memory.sceneNotes.value).toEqual([{ at: START, scene, source: 'caption' }])
    expect(h.captionerStatus.value).toBe('idle')
  })

  test.each(['', '{"scene": "", "event": ""}'])('records nothing for %j', async reply => {
    const h = await createHarness()
    h.startCaptioner()
    const pending = h.requestFreshScene(h.clock.now() - 15_000)
    await flush()
    h.calls[0].reply(reply)
    expect(await pending).toBeNull()
    expect(h.memory.sceneNotes.value).toEqual([])
    expect(h.captionerStatus.value).toBe('idle')
  })
})

describe('triggers', () => {
  test('keeps one call in flight; triggers during it join instead of calling again', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    expect(h.captionerStatus.value).toBe('captioning')
    await flush()
    await h.clock.advance(10_000)
    h.cut()
    const joined = h.requestFreshScene(h.clock.now() - 15_000)
    await flush()
    expect(h.calls).toHaveLength(1)
    h.calls[0].reply('{"scene": "画面一"}')
    expect(await joined).toEqual({ at: START, scene: '画面一', source: 'caption' })
    expect(h.calls).toHaveLength(1)
  })

  test('a joined call of a picture from before `notBefore` is followed by one more caption', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    await h.clock.advance(2_000)
    const pending = h.requestFreshScene(h.clock.now() - 500)
    await flush()
    expect(h.calls).toHaveLength(1)
    h.calls[0].reply('{"scene": "切换前"}')
    await flush()
    expect(h.calls).toHaveLength(2)
    h.calls[1].reply('{"scene": "切换后"}')
    expect(await pending).toEqual({ at: START + 2_000, scene: '切换后', source: 'caption' })
  })

  test('captions a scene cut at most once per 10 s', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.calls[0].reply('{"scene": "画面一"}')
    await h.clock.advance(9_999)
    h.cut()
    await flush()
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(1)
    h.cut()
    await flush()
    expect(h.calls).toHaveLength(2)
  })

  test('refreshes every 45 s while the newest note is older than 45 s', async () => {
    const h = await createHarness()
    h.startCaptioner()
    await h.clock.advance(5_000)
    expect(h.calls).toHaveLength(1)
    h.calls[0].reply('{"scene": "画面一"}')
    await h.clock.advance(45_000)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(5_000)
    expect(h.calls).toHaveLength(2)
  })

  test('skips every trigger unless frames are available', async () => {
    const h = await createHarness()
    h.availability.value = 'hidden'
    h.startCaptioner()
    h.cut()
    await h.clock.advance(60_000)
    expect(await h.requestFreshScene(h.clock.now() - 15_000)).toBeNull()
    expect(h.calls).toHaveLength(0)
    expect(h.captionerStatus.value).toBe('idle')
    h.availability.value = 'ok'
    await h.clock.advance(5_000)
    expect(h.calls).toHaveLength(1)
  })
})

describe('failures', () => {
  test.each([
    ['model', (h: Harness) => (h.model.value = 'vision-pro')],
    ['provider', (h: Harness) => (h.provider.value = { ...PROVIDER, id: 'other' })],
  ])('a media rejection stops captioning until the %s changes', async (_label, change) => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.calls[0].fail(new Error('HTTP 400 Bad Request: {"error":{"message":"This model does not support image input"}}'))
    await flush()
    expect(h.captionerStatus.value).toBe('unsupported')
    expect(h.log.mock.calls).toEqual([[UNSUPPORTED]])
    await h.clock.advance(120_000)
    h.cut()
    expect(await h.requestFreshScene(h.clock.now() - 15_000)).toBeNull()
    expect(h.calls).toHaveLength(1)
    change(h)
    expect(h.captionerStatus.value).toBe('idle')
    h.cut()
    await flush()
    expect(h.calls).toHaveLength(2)
    expect(h.log).toHaveBeenCalledTimes(1)
  })

  test('an oversized request (HTTP 413) is a failed call, not an unsupported model', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.calls[0].fail(new Error('HTTP 413 Payload Too Large: image exceeds the size limit'))
    await flush()
    expect(h.captionerStatus.value).toBe('error')
    await h.clock.advance(10_000)
    h.cut()
    await flush()
    expect(h.calls).toHaveLength(2)
  })

  test('switching back to a rejected model tries it again', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.calls[0].fail(new Error('HTTP 400 Bad Request: image input is not supported'))
    await flush()
    h.model.value = 'vision-pro'
    h.model.value = ''
    expect(h.captionerStatus.value).toBe('idle')
    await h.clock.advance(10_000)
    h.cut()
    await flush()
    expect(h.calls.map(call => call.options.model)).toEqual(['vision-model', 'vision-model'])
  })

  test('a failure after the model changed mid-call leaves the new model idle', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.model.value = 'vision-pro'
    expect(h.captionerStatus.value).toBe('captioning')
    h.calls[0].fail(new Error('HTTP 401 Unauthorized'))
    await flush()
    expect(h.captionerStatus.value).toBe('idle')
  })

  test('other errors log at most once per 60 s and retry on the next trigger', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    h.calls[0].fail(new Error('HTTP 502 Bad Gateway'))
    await flush()
    expect(h.captionerStatus.value).toBe('error')
    expect(h.log.mock.calls).toEqual([['⚠️ [画面识别] 画面描述失败：HTTP 502 Bad Gateway']])

    await h.clock.advance(10_000)
    h.cut()
    await flush()
    h.calls[1].fail(new Error('网络请求失败：offline'))
    await flush()
    expect(h.log).toHaveBeenCalledTimes(1)

    // The 45 s refresh retries at +55 s; its failure lands 60 s after the first log.
    await h.clock.advance(50_000)
    expect(h.calls).toHaveLength(3)
    h.calls[2].fail(new Error('HTTP 503 Service Unavailable'))
    await flush()
    expect(h.log.mock.calls).toEqual([
      ['⚠️ [画面识别] 画面描述失败：HTTP 502 Bad Gateway'],
      ['⚠️ [画面识别] 画面描述失败：HTTP 503 Service Unavailable'],
    ])

    await h.clock.advance(10_000)
    h.cut()
    await flush()
    h.calls[3].reply('{"scene": "恢复了"}')
    await flush()
    expect(h.captionerStatus.value).toBe('idle')
  })

  test('gives up on a call after 30 s', async () => {
    const h = await createHarness()
    h.startCaptioner()
    h.cut()
    await flush()
    await h.clock.advance(30_000)
    expect(h.calls[0].options.signal?.aborted).toBe(true)
    expect(h.captionerStatus.value).toBe('error')
    expect(h.log.mock.calls).toEqual([['⚠️ [画面识别] 画面描述失败：请求超时（30 秒）']])
  })

  test.each([
    ['no provider', null, ''],
    ['no API base', { ...PROVIDER, apiBase: ' ' }, ''],
    ['no API key', { ...PROVIDER, apiKey: '' }, ''],
    ['no model', { ...PROVIDER, model: '' }, ' '],
  ])('%s: status error plus one hint log, and no calls', async (_label, provider, model) => {
    const h = await createHarness()
    h.provider.value = provider
    h.model.value = model
    h.startCaptioner()
    expect(h.captionerStatus.value).toBe('error')
    h.cut()
    await h.clock.advance(60_000)
    expect(await h.requestFreshScene(h.clock.now() - 15_000)).toBeNull()
    h.provider.value = { ...PROVIDER, apiKey: '' }
    expect(h.captionerStatus.value).toBe('error')
    expect(h.calls).toHaveLength(0)
    expect(h.log.mock.calls).toEqual([[HINT]])
    h.provider.value = PROVIDER
    expect(h.captionerStatus.value).toBe('idle')
  })
})

describe('requestFreshScene', () => {
  test('returns null while stopped', async () => {
    const h = await createHarness()
    expect(await h.requestFreshScene(h.clock.now() - 15_000)).toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  test('returns a fresh-enough note without calling the model', async () => {
    const h = await createHarness()
    h.memory.recordScene('主播在聊天', 'chat', START - 5_000)
    h.startCaptioner()
    expect(await h.requestFreshScene(h.clock.now() - 15_000)).toEqual({
      at: START - 5_000,
      scene: '主播在聊天',
      source: 'chat',
    })
    expect(h.calls).toHaveLength(0)
  })

  test('captions once when the newest note is too old', async () => {
    const h = await createHarness()
    h.memory.recordScene('主播在聊天', 'chat', START - 5_000)
    h.startCaptioner()
    const first = h.requestFreshScene(h.clock.now() - 3_000)
    const second = h.requestFreshScene(h.clock.now() - 3_000)
    await flush()
    expect(h.calls).toHaveLength(1)
    h.calls[0].reply('{"scene": "主播开始做饭", "event": "端出了一盘菜"}')
    const note: SceneNote = { at: START, scene: '主播开始做饭；刚刚：端出了一盘菜', source: 'caption' }
    expect(await first).toEqual(note)
    expect(await second).toEqual(note)
  })

  test('stops waiting at the timeout but keeps the late note', async () => {
    const h = await createHarness()
    h.startCaptioner()
    let settled = false
    const pending = h.requestFreshScene(h.clock.now() - 15_000, 8_000).finally(() => {
      settled = true
    })
    await h.clock.advance(7_999)
    expect(settled).toBe(false)
    await h.clock.advance(1)
    expect(await pending).toBeNull()
    h.calls[0].reply('{"scene": "迟到的画面"}')
    await flush()
    expect(h.memory.latestScene(60_000)?.scene).toBe('迟到的画面')
  })
})

describe('start and stop', () => {
  test('are ref-counted; the last stop aborts the call in flight', async () => {
    const h = await createHarness()
    expect(h.captionerStatus.value).toBe('off')
    h.startCaptioner()
    h.startCaptioner()
    expect(h.captionerStatus.value).toBe('idle')
    h.cut()
    await flush()
    h.stopCaptioner()
    expect(h.captionerStatus.value).toBe('captioning')
    expect(h.calls[0].options.signal?.aborted).toBe(false)
    h.stopCaptioner()
    expect(h.captionerStatus.value).toBe('off')
    expect(h.calls[0].options.signal?.aborted).toBe(true)
    await flush()
    expect(h.captionerStatus.value).toBe('off')
    expect(h.log).not.toHaveBeenCalled()

    h.stopCaptioner()
    h.cut()
    await h.clock.advance(60_000)
    expect(h.calls).toHaveLength(1)
    expect(h.memory.sceneNotes.value).toEqual([])
  })
})
