import { expect, test } from 'bun:test'
import * as signals from '@preact/signals'

const source = await Bun.file(new URL('./replacement.ts', import.meta.url)).text()
let moduleId = 0

async function loadReplacement() {
  const store = {
    cachedRoomId: signals.signal<number | null>(null),
    localGlobalRules: signals.signal<Array<{ from?: string; to?: string }>>([]),
    localRoomRules: signals.signal<Record<string, Array<{ from?: string; to?: string }>>>({}),
    remoteKeywords: signals.signal<{
      global?: { keywords?: Record<string, string> }
      rooms?: Array<{ room: string; keywords?: Record<string, string> }>
    } | null>(null),
    remoteRulesEnabled: signals.signal(false),
  }
  const key = `__replacementTest${++moduleId}`
  Reflect.set(globalThis, key, { signals, store })
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(
      /import\s*\{([^}]+)\}\s*from\s*["']@preact\/signals["'];?/,
      (_m, names) => `const {${names}} = globalThis[${JSON.stringify(key)}].signals;`
    )
    .replace(
      /import\s*\{([^}]+)\}\s*from\s*["']\.\/store["'];?/,
      (_m, names) => `const {${names}} = globalThis[${JSON.stringify(key)}].store;`
    )
  try {
    const mod: typeof import('./replacement') = await import(
      `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
    )
    return { ...mod, store }
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}

test('applyReplacements reactively tracks remote/local global & room rules by priority', async () => {
  const { applyReplacements, store } = await loadReplacement()
  store.remoteKeywords.value = {
    global: { keywords: { 甲: '云全局', 乙: '云乙' } },
    rooms: [{ room: '100', keywords: { 甲: '云房间' } }],
  }
  expect(applyReplacements('甲 乙')).toBe('甲 乙')

  store.remoteRulesEnabled.value = true
  expect(applyReplacements('甲 乙')).toBe('云全局 云乙')

  store.cachedRoomId.value = 100
  expect(applyReplacements('甲 乙')).toBe('云房间 云乙')

  store.localGlobalRules.value = [{ from: '甲', to: '本地全局' }]
  expect(applyReplacements('甲 乙')).toBe('本地全局 云乙')

  store.localRoomRules.value = { '100': [{ from: '甲', to: '本地房间' }] }
  expect(applyReplacements('甲 乙')).toBe('本地房间 云乙')

  store.remoteRulesEnabled.value = false
  expect(applyReplacements('甲 乙')).toBe('本地房间 乙')
})
