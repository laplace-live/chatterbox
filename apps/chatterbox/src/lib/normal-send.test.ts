import { describe, expect, it, mock } from 'bun:test'
import * as signals from '@preact/signals'

import * as utils from './utils'
import * as wrap from './wrap'

const source = await Bun.file(new URL('./normal-send.ts', import.meta.url)).text()
let moduleId = 0

/** Fresh normal-send module whose LLM reports `llmGap`; store, LLM and log are stubbed through globalThis. */
async function loadNormalSend(llmGap: string | null) {
  const polishWithLlm = mock(async (_feature: string, text: string) => `${text}～`)
  const logs: string[] = []
  const fasongText = signals.signal('主播好')
  const dependencies: Record<string, unknown> = {
    '@preact/signals': signals,
    './ai-evasion': {},
    './api': {},
    './emoticon': {},
    './llm-tasks': { describeLlmGap: () => llmGap, polishWithLlm },
    './log': { appendLog: (message: unknown) => logs.push(String(message)) },
    './replacement': {},
    './road-rage': {},
    './send-queue': {},
    './store': { fasongText, normalSendYolo: signals.signal(false) },
    './utils': utils,
    './wrap': wrap,
  }
  const key = `__normalSendTest${++moduleId}`
  Reflect.set(globalThis, key, { dependencies })
  // Transpile first so type-only specifiers are gone before the imports are swapped.
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
      if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
      return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
    })
  try {
    const mod: typeof import('./normal-send') = await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )
    return { mod, polishWithLlm, logs, fasongText }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

function enter(mods: { altKey?: boolean; shiftKey?: boolean; isComposing?: boolean } = {}) {
  return { key: 'Enter', altKey: false, shiftKey: false, isComposing: false, preventDefault: mock(() => {}), ...mods }
}

describe('handleNormalSendKeyDown', () => {
  it('polishes the shared draft in place on Alt+Enter once the LLM is ready', async () => {
    const { mod, polishWithLlm, fasongText } = await loadNormalSend(null)
    const e = enter({ altKey: true })
    mod.handleNormalSendKeyDown(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(polishWithLlm).toHaveBeenCalledWith('normalSend', '主播好')
    while (mod.normalSendPolishing.value) await Bun.sleep(1)
    expect(fasongText.value).toBe('主播好～')
  })

  it('only explains the gap on Alt+Enter while the LLM is not ready', async () => {
    const { mod, polishWithLlm, logs } = await loadNormalSend('请先在「设置 → LLM 设置」中填写 API Key')
    const e = enter({ altKey: true })
    mod.handleNormalSendKeyDown(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
    expect(polishWithLlm).not.toHaveBeenCalled()
    expect(logs).toEqual(['❌ AI 润色不可用：请先在「设置 → LLM 设置」中填写 API Key'])
  })

  it('leaves Shift+Enter and IME confirmations to the textarea', async () => {
    const { mod, polishWithLlm } = await loadNormalSend(null)
    for (const e of [enter({ shiftKey: true }), enter({ altKey: true, isComposing: true })]) {
      mod.handleNormalSendKeyDown(e)
      expect(e.preventDefault).not.toHaveBeenCalled()
    }
    expect(polishWithLlm).not.toHaveBeenCalled()
  })
})
