import { describe, expect, test } from 'bun:test'
import * as signals from '@preact/signals'

import * as utils from './utils'

const source = await Bun.file(new URL('./loop.ts', import.meta.url)).text()
const transpiler = new Bun.Transpiler({ loader: 'ts' })
let moduleId = 0

class StopLoop extends Error {}

async function createLoopHarness(opts: {
  template: string
  maxUnits?: number
  roomUnits?: number | null
  stopAfterRounds?: number
  randomChar?: boolean
  invisibleChar?: string
  yolo?: boolean
  replacements?: Record<string, string>
  emoteIds?: string[]
  polishFn?: (text: string) => Promise<string>
  fetchMaxLengthFn?: (roomId: number) => Promise<void>
  onSleepFn?: () => Promise<void>
}) {
  const sent: string[] = []
  const logs: string[] = []
  const fetchMaxLengthCalls: number[] = []
  const store = {
    activeTemplateIndex: signals.signal(0),
    autoSendYolo: signals.signal(opts.yolo ?? false),
    availableDanmakuColors: signals.signal<string[] | null>(null),
    cachedRoomId: signals.signal<number | null>(456117),
    effectiveAutoSendMaxUnits: signals.signal(opts.maxUnits ?? 40),
    forceScrollDanmaku: signals.signal(false),
    invisibleChar: signals.signal(opts.invisibleChar ?? '\u00AD'),
    msgSendInterval: signals.signal(1),
    msgTemplates: signals.signal([opts.template]),
    randomChar: signals.signal(opts.randomChar ?? false),
    randomColor: signals.signal(false),
    randomInterval: signals.signal(false),
    roomDanmakuUnits: signals.signal<number | null>(
      opts.roomUnits !== undefined ? opts.roomUnits : (opts.maxUnits ?? 40)
    ),
    sendMsg: signals.signal(true),
  }
  const rules = opts.replacements ?? {}
  const deps: Record<string, unknown> = {
    './api': {
      ensureRoomId: async () => 456117,
      fetchDanmakuMaxLength: async (roomId: number) => {
        fetchMaxLengthCalls.push(roomId)
        if (opts.fetchMaxLengthFn) await opts.fetchMaxLengthFn(roomId)
      },
      fetchEmoticons: async () => {},
      getCsrfToken: () => 'csrf',
      getSpmPrefix: () => '444.8',
      setDanmakuMode: async () => {},
      setRandomDanmakuColor: async () => {},
    },
    './const': { BASE_URL: 'https://api.live.bilibili.com' },
    './emoticon': {
      formatLockedEmoticonReject: (m: string) => m,
      formatUnavailableEmoticonReject: (m: string) => m,
      isEmoticonUnique: (m: string) => (opts.emoteIds ?? []).includes(m),
      isLockedEmoticon: () => false,
      isUnavailableEmoticon: () => false,
    },
    './llm-tasks': {
      isLlmReady: () => true,
      polishWithLlm: async (_slot: string, text: string) => (opts.polishFn ? opts.polishFn(text) : text),
    },
    './log': {
      appendLog: (...args: unknown[]) => {
        const text = args.map(String).join(' ')
        logs.push(text)
        if (text.includes(`第 ${opts.stopAfterRounds ?? 1} 轮发送完成`)) {
          throw new StopLoop()
        }
      },
    },
    './replacement': {
      applyReplacements: (text: string) => {
        let out = text
        for (const [from, to] of Object.entries(rules)) {
          out = out.split(from).join(to)
        }
        return out
      },
    },
    './send-queue': {
      SendPriority: { AUTO: 2 },
      enqueueDanmaku: async (message: string) => {
        sent.push(message)
        return { isEmoticon: false, ok: true }
      },
    },
    './store': store,
    './utils': {
      ...utils,
      abortableSleep: async () => {
        if (opts.onSleepFn) await opts.onSleepFn()
        return true
      },
    },
    './wbi': {
      cachedWbiKeys: null,
      encodeWbi: () => '',
      waitForWbiKeys: async () => {},
    },
  }

  const key = `__loopTest${++moduleId}`
  Reflect.set(globalThis, key, deps)
  const js = transpiler
    .transformSync(source)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_m, names: string, spec: string) => {
      if (!(spec in deps)) throw new Error(`Unmocked import in loop.ts: ${spec}`)
      const bindings = names
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => {
          const [orig, alias] = s.split(/\s+as\s+/).map(p => p.trim())
          return alias ? `${orig}: ${alias}` : orig
        })
        .join(', ')
      return `const { ${bindings} } = globalThis[${JSON.stringify(key)}][${JSON.stringify(spec)}];`
    })

  try {
    store.sendMsg.subscribe(active => {
      if (!active) throw new StopLoop()
    })
    const mod: typeof import('./loop') = await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )
    return { loop: mod.loop, sent, logs, store, fetchMaxLengthCalls }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('loop replacement & unit-cap ordering', () => {
  test('applies length-expanding replacements before randomChar and splitting so chunks never overrun maxUnits', async () => {
    const { loop, sent } = await createLoopHarness({
      template: `${'好'.repeat(18)}敏感`,
      maxUnits: 40,
      randomChar: true,
      invisibleChar: '\u00AD',
      replacements: { 敏感: '敏·感' },
    })

    await expect(loop()).rejects.toBeInstanceOf(StopLoop)
    expect(sent.length).toBe(2)
    const combined = sent.join('')
    expect([...combined].filter(ch => ch === '\u00AD')).toHaveLength(1)
    expect(combined.replaceAll('\u00AD', '')).toBe(`${'好'.repeat(18)}敏·感`)
    for (const chunk of sent) {
      expect(utils.getDanmakuUnits(chunk)).toBeLessThanOrEqual(40)
    }
  })

  test('triggers fallback cap lookup when cachedRoomId is pre-populated and sends without blocking on a pending lookup', async () => {
    let releaseLookup: (() => void) | undefined
    const stalledLookup = new Promise<void>(resolve => {
      releaseLookup = resolve
    })
    const { loop, sent, fetchMaxLengthCalls } = await createLoopHarness({
      template: '你好世界',
      maxUnits: 80,
      roomUnits: null,
      fetchMaxLengthFn: () => stalledLookup,
    })

    try {
      await expect(loop()).rejects.toBeInstanceOf(StopLoop)
      expect(fetchMaxLengthCalls).toEqual([456117])
      expect(sent).toEqual(['你好世界'])
    } finally {
      releaseLookup?.()
    }
  })

  test('retries a failed room-cap lookup within the same loop run only after bounded backoff', async () => {
    const realDateNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    let sleepCount = 0
    const lookupTimes: number[] = []
    try {
      const { loop, fetchMaxLengthCalls, store } = await createLoopHarness({
        template: '你好',
        maxUnits: 80,
        roomUnits: null,
        stopAfterRounds: 3,
        fetchMaxLengthFn: async () => {
          lookupTimes.push(now)
          if (fetchMaxLengthCalls.length === 1) throw new Error('HTTP 502')
          store.roomDanmakuUnits.value = 60
        },
        onSleepFn: async () => {
          sleepCount += 1
          await Promise.resolve()
          if (sleepCount === 1) now += 5_000
          if (sleepCount === 2) now += 30_000
        },
      })

      await expect(loop()).rejects.toBeInstanceOf(StopLoop)
      expect(fetchMaxLengthCalls).toEqual([456117, 456117])
      expect(lookupTimes[1] - lookupTimes[0]).toBeGreaterThanOrEqual(30_000)
      expect(store.roomDanmakuUnits.value).toBe(60)
    } finally {
      Date.now = realDateNow
    }
  })

  test('re-splits unsent direct tasks when effectiveAutoSendMaxUnits drops mid-round', async () => {
    let sleepCount = 0
    const harness = await createLoopHarness({
      template: `第一句\n${'好'.repeat(40)}`,
      maxUnits: 80,
      onSleepFn: async () => {
        sleepCount += 1
        if (sleepCount === 1) {
          harness.store.effectiveAutoSendMaxUnits.value = 40
        }
      },
    })

    await expect(harness.loop()).rejects.toBeInstanceOf(StopLoop)
    expect(harness.sent).toEqual(['第一句', '好'.repeat(20), '好'.repeat(20)])
  })

  test('keeps emote IDs produced by replacement aliases intact without randomChar or splitting', async () => {
    const { loop, sent } = await createLoopHarness({
      template: '赞',
      maxUnits: 10,
      randomChar: true,
      invisibleChar: '\u00AD',
      replacements: { 赞: 'official_147' },
      emoteIds: ['official_147'],
    })

    await expect(loop()).rejects.toBeInstanceOf(StopLoop)
    expect(sent).toEqual(['official_147'])
  })

  test('stops cleanly when replacements erase the entire template instead of spinning empty rounds', async () => {
    const { loop, sent, logs, store } = await createLoopHarness({
      template: 'dropme',
      maxUnits: 40,
      replacements: { dropme: '   ' },
    })

    await expect(loop()).rejects.toBeInstanceOf(StopLoop)
    expect(sent).toEqual([])
    expect(store.sendMsg.value).toBe(false)
    expect(logs.some(l => l.includes('当前模板替换后为空，已自动停止运行'))).toBe(true)
  })

  test('applies replacements before splitting YOLO polished output so chunks stay within maxUnits', async () => {
    const { loop, sent } = await createLoopHarness({
      template: '原始文案',
      maxUnits: 40,
      yolo: true,
      replacements: { v: '微信' },
      polishFn: async () => `${'好'.repeat(19)}v`,
    })

    await expect(loop()).rejects.toBeInstanceOf(StopLoop)
    expect(sent.length).toBe(2)
    expect(sent.join('')).toBe(`${'好'.repeat(19)}微信`)
    for (const chunk of sent) {
      expect(utils.getDanmakuUnits(chunk)).toBeLessThanOrEqual(40)
    }
  })
})
