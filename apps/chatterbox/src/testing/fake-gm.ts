import { join } from 'node:path'
import type { BunPlugin } from 'bun'

import type { FakeGmRequest } from './fake-gm-transport'

const ENTRY = join(import.meta.dir, '__fake-gm-entry__.ts')
const TRANSPORT = join(import.meta.dir, 'fake-gm-transport.ts')
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
    files: { [ENTRY]: `export * from ${JSON.stringify(path)}\nexport { requests } from '$'` },
    plugins: [fakeGm],
    target: 'bun',
  })
  return result.outputs[0].text()
}

/** Bundle a fresh copy of `module` with `$` swapped for the fake transport; `requests` records its GM calls. */
export async function loadWithFakeGm<T>(module: URL): Promise<T & { requests: FakeGmRequest[] }> {
  const path = Bun.fileURLToPath(module)
  const code = bundles.get(path) ?? bundle(path)
  bundles.set(path, code)
  // Bun caches modules by URL; the counter gives each load its own instance (and its own `requests`).
  return import(`data:text/javascript;base64,${Buffer.from(`${await code}\n// load ${++loads}`).toString('base64')}`)
}
