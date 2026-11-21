const transpiler = new Bun.Transpiler({ loader: 'ts' })
let loads = 0

/** Import a fresh copy of `module` with every named import read from `deps[specifier]` (a missing one throws) and `globals` shadowing same-named globals. */
export async function loadWithMocks<T>(
  module: URL,
  deps: Record<string, unknown>,
  globals: Record<string, unknown> = {}
): Promise<T> {
  const key = `__loadWithMocks${++loads}`
  const scope = `globalThis[${JSON.stringify(key)}]`
  const js = transpiler.transformSync(await Bun.file(module).text())
  const injected = js.replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_match, names, specifier) => {
    if (!(specifier in deps)) throw new Error(`Unmocked import: ${specifier}`)
    return `const {${names}} = ${scope}.deps[${JSON.stringify(specifier)}];`
  })
  const prelude = `const {${Object.keys(globals).join(', ')}} = ${scope}.globals;\n`
  Reflect.set(globalThis, key, { deps, globals })
  try {
    return await import(`data:text/javascript;base64,${Buffer.from(prelude + injected).toString('base64')}`)
  } finally {
    Reflect.deleteProperty(globalThis, key)
  }
}
