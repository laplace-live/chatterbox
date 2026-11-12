import { join } from 'node:path'
import type { BunPlugin } from 'bun'

import type { FakeGmRequest } from './fake-gm-transport'

const ENTRY = join(import.meta.dir, '__fake-gm-entry__.ts')
const TRANSPORT = join(import.meta.dir, 'fake-gm-transport.ts')
const SEED_PLACEHOLDER = '__FAKE_GM_SEED_KEY__'
const bundles = new Map<string, Promise<string>>()
let loads = 0

const fakeGm: BunPlugin = {
  name: 'fake-gm',
  setup(build) {
    build.onResolve({ filter: /^\$$/ }, () => ({ path: TRANSPORT }))
  },
}

async function bundle(path: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    files: { [ENTRY]: `export * from ${JSON.stringify(path)}\nexport { requests, store } from '$'` },
    plugins: [fakeGm],
    target: 'bun',
  })
  if (!result.success) throw new AggregateError(result.logs, `Failed to bundle ${path}`)
  return result.outputs[0].text()
}

/** Bundle a fresh copy of `module` with `$` swapped for the fake transport (`requests`) and storage (`store`). */
export async function loadWithFakeGm<T>(
  module: URL,
  seed: Iterable<readonly [string, unknown]> = []
): Promise<T & { requests: FakeGmRequest[]; store: Map<string, unknown> }> {
  const path = Bun.fileURLToPath(module)
  const cached = bundles.get(path) ?? bundle(path)
  bundles.set(path, cached)
  const id = ++loads
  const seedKey = `__fakeGmSeed_${id}`
  Reflect.set(globalThis, seedKey, new Map<string, unknown>(seed))
  try {
    // Bun caches modules by URL; the counter gives each load its own instance (`requests` and `store`).
    const code = (await cached).replaceAll(SEED_PLACEHOLDER, seedKey)
    return await import(`data:text/javascript;base64,${Buffer.from(`${code}\n// load ${id}`).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, seedKey)
  }
}
