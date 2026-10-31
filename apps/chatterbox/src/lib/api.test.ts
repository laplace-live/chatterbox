import { expect, mock, test } from 'bun:test'

import * as constants from './const'
import * as danmakuLimit from './danmaku-limit'
import * as utils from './utils'

const source = await Bun.file(new URL('./api.ts', import.meta.url)).text()
let moduleId = 0

/** Fresh api module whose `fetch` answers with `body` (a `Response` as-is); GM-backed imports are stubbed through globalThis. */
async function loadApi(body: unknown) {
  const fetch = mock(async (_url: string, _init?: RequestInit) =>
    body instanceof Response ? body : Response.json(body)
  )
  const dependencies: Record<string, unknown> = {
    './const': constants,
    './danmaku-limit': danmakuLimit,
    './emoticon': { isEmoticonUnique: () => false },
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
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({ success: false, error: 'f', rejected: true })
})

test('a non-zero code fails even without a message', async () => {
  const { api } = await loadApi({ code: 10030, message: '' })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({
    success: false,
    error: 'code 10030',
    rejected: true,
  })
})

test('a non-zero code reports msg when message is empty', async () => {
  const { api } = await loadApi({ code: 10030, message: '', msg: '您发送弹幕的频率过快' })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({
    success: false,
    error: '您发送弹幕的频率过快',
    rejected: true,
  })
})

test('a response without code or message is accepted', async () => {
  const { api } = await loadApi({ data: {} })
  expect(await api.sendDanmaku('hi', 1, 'csrf')).toMatchObject({ success: true })
})

test('an unreadable response fails without counting as a rejection', async () => {
  const { api } = await loadApi(new Response('<html>Bad Gateway</html>', { status: 502 }))
  const result = await api.sendDanmaku('hi', 1, 'csrf')
  expect(result).toMatchObject({ success: false })
  expect(result.rejected).toBeUndefined()
})

test('fetchDanmakuMaxLength populates roomDanmakuUnits from getInfoByUser', async () => {
  danmakuLimit.roomDanmakuUnits.value = null
  try {
    const { api, fetch } = await loadApi({ code: 0, data: { property: { danmu: { length: 80 } } } })
    await api.fetchDanmakuMaxLength(12345)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(danmakuLimit.roomDanmakuUnits.peek()).toBe(80)
  } finally {
    danmakuLimit.roomDanmakuUnits.value = null
  }
})
