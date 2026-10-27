import { join } from 'node:path'
import type { BunPlugin } from 'bun'

import type { FakeGmRequest } from './fake-gm-transport'

const ENTRY = join(import.meta.dir, '__fake-gm-entry__.ts')
const TRANSPORT = join(import.meta.dir, 'fake-gm-transport.ts')
let loads = 0

const fakeGm: BunPlugin = {
  name: 'fake-gm',
  setup(build) {
    build.onResolve({ filter: /^\$$/ }, () => ({ path: TRANSPORT }))
  },
}

/** Bundle a fresh copy of `module` with `$` swapped for the fake transport; `requests` records its GM calls. */
export async function loadWithFakeGm<T>(module: URL): Promise<T & { requests: FakeGmRequest[] }> {
  const result = await Bun.build({
    entrypoints: [ENTRY],
    files: { [ENTRY]: `export * from ${JSON.stringify(Bun.fileURLToPath(module))}\nexport { requests } from '$'` },
    plugins: [fakeGm],
    target: 'bun',
  })
  const output = result.outputs[0]
  if (!result.success || !output) throw new AggregateError(result.logs, 'fake-gm build failed')
  // Bun caches modules by URL, and identical bundles would share one data URL (and one `requests`).
  const code = `${await output.text()}\n// load ${++loads}`
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
