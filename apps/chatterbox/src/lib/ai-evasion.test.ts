import { describe, expect, mock, test } from 'bun:test'
import { signal } from '@preact/signals'

import * as constants from './const'
import * as utils from './utils'
import * as wrap from './wrap'

const source = await Bun.file(new URL('./ai-evasion.ts', import.meta.url)).text()
let moduleId = 0

async function loadAiEvasion(opts: { maxUnits?: number; sensitiveWords?: string[]; failChunkAt?: number } = {}) {
  const aiEvasion = signal(true)
  const danmakuMaxUnits = signal(opts.maxUnits ?? 80)
  const invisibleChar = signal('\u00AD')
  const logs: string[] = []
  const sent: string[] = []
  const enqueueDanmaku = mock(async (message: string) => {
    const idx = sent.length
    sent.push(message)
    if (opts.failChunkAt === idx) return { success: false, message, isEmoticon: false, error: 'f' }
    return { success: true, message, isEmoticon: false }
  })
  const fetch = mock(async () =>
    Response.json({
      completion: opts.sensitiveWords
        ? { hasSensitiveContent: true, sensitiveWords: opts.sensitiveWords }
        : { hasSensitiveContent: false },
    })
  )
  const dependencies: Record<string, unknown> = {
    './const': constants,
    './emoticon': { isEmoticonUnique: () => false },
    './log': { appendLog: (msg: string) => logs.push(msg) },
    './send-queue': { enqueueDanmaku, SendPriority: { MANUAL: 2 } },
    './store': { aiEvasion, danmakuMaxUnits, invisibleChar },
    './utils': utils,
    './wrap': wrap,
  }
  const key = `__aiEvasionTest${++moduleId}`
  Reflect.set(globalThis, key, { fetch, dependencies })
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
  })
  const code = `const { fetch } = globalThis[${JSON.stringify(key)}];\n${injected}`
  try {
    const mod: typeof import('./ai-evasion') = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )
    return { mod, sent, logs, danmakuMaxUnits }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

describe('splitEvadedMessage', () => {
  test('keeps evaded text intact when still within maxUnits', async () => {
    const { mod } = await loadAiEvasion()
    // 78 ASCII (78) + '\u00AD' (2) = 80 units.
    expect(mod.splitEvadedMessage(`a\u00ADb${'x'.repeat(76)}`, 80)).toHaveLength(1)
    expect(mod.splitEvadedMessage(`【${'好'.repeat(38)}】`, 80)).toEqual([`【${'好'.repeat(38)}】`])
    expect(mod.splitEvadedMessage(`【${'x'.repeat(76)}】`, 80)).toEqual([`【${'x'.repeat(76)}】`])
  })

  test('splits plain and 【】-wrapped overflow so every chunk stays within maxUnits', async () => {
    const { mod } = await loadAiEvasion()
    const plain = mod.splitEvadedMessage('好'.repeat(42), 80)
    expect(plain).toEqual(['好'.repeat(40), '好'.repeat(2)])

    const wrapped = mod.splitEvadedMessage(`【${'好'.repeat(40)}】`, 80)
    expect(wrapped).toEqual([`【${'好'.repeat(38)}】`, `【${'好'.repeat(2)}】`])
    for (const chunk of wrapped) {
      expect(utils.getDanmakuUnits(chunk)).toBeLessThanOrEqual(80)
    }

    // Separate bracketed phrases in one message are not a single outer wrapper.
    const multiGroup = `【甲乙】${'好'.repeat(36)}【丙丁】`
    expect(mod.splitEvadedMessage(multiGroup, 80)).toEqual([`【甲乙】${'好'.repeat(36)}`, '【丙丁】'])
  })
})

describe('tryAiEvasion overflow splitting', () => {
  test('splits retries only when inserted invisible chars push a full-length message past danmakuMaxUnits', async () => {
    const { mod, sent } = await loadAiEvasion({ maxUnits: 80, sensitiveWords: ['敏感词'] })
    const message = `${'啊'.repeat(37)}敏感词`
    const result = await mod.tryAiEvasion(message, 100, 'csrf', '', 'manual')
    expect(result.success).toBe(true)
    expect(sent).toHaveLength(2)
    for (const chunk of sent) {
      expect(utils.getDanmakuUnits(chunk)).toBeLessThanOrEqual(80)
    }
  })

  test('stops and reports failure if a split evasion chunk is rejected', async () => {
    const { mod, sent } = await loadAiEvasion({ maxUnits: 80, sensitiveWords: ['敏感词'], failChunkAt: 0 })
    const message = `${'啊'.repeat(37)}敏感词`
    const result = await mod.tryAiEvasion(message, 100, 'csrf', '', 'manual')
    expect(result).toMatchObject({ success: false, error: 'f' })
    expect(sent).toHaveLength(1)
  })
})
