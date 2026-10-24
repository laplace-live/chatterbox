import { expect, mock, test } from 'bun:test'

import * as constants from './const'
import * as utils from './utils'

const source = await Bun.file(new URL('./api.ts', import.meta.url)).text()
let moduleId = 0

/** Fresh api module whose `fetch` answers with `body`; GM-backed imports are stubbed through globalThis. */
async function loadApi(body: unknown) {
  const fetch = mock(async (_url: string, _init?: RequestInit) => Response.json(body))
  const dependencies: Record<string, unknown> = {
    './const': constants,
    './emoticon': { isEmoticonUnique: () => false },
    './replacement': { buildReplacementMap: () => {} },
    './store': {},
    './utils': utils,
    './wbi': { cachedWbiKeys: null, encodeWbi: () => '' },
  }
  const key = `__apiTest${++moduleId}`
  Reflect.set(globalThis, key, { fetch, dependencies })
  // Transpile first so type-only specifiers are gone before the imports are swapped.
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, path) => {
    if (!(path in dependencies)) throw new Error(`Unmocked import: ${path}`)
    return `const {${names}} = globalThis[${JSON.stringify(key)}].dependencies[${JSON.stringify(path)}];`
  })
  const code = `const { fetch } = globalThis[${JSON.stringify(key)}];\n${injected}`
  try {
    const api: typeof import('./api') = await import(
      `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
    )
    return { api, fetch }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

test('code 0 with an empty message is accepted', async () => {
  const { api, fetch } = await loadApi({ code: 0, data: {}, message: '', msg: '' })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({ success: true, message: 'hi' })
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('a rejection message is the error, even with code 0', async () => {
  const { api } = await loadApi({ code: 0, data: {}, message: 'f', msg: 'f' })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({ success: false, error: 'f' })
})

test('a non-zero code fails even without a message', async () => {
  const { api } = await loadApi({ code: 10030, message: '' })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({ success: false, error: 'code 10030' })
})
