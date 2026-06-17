/**
 * Shared lazy CDN-bundle loaders. Two mechanisms, one cache:
 *
 * - `loadUmdScript()` for UMD bundles (e.g. mpegts.js) that assign
 *   themselves to a `window.*` global as a side effect of running.
 *   Inject a plain `<script>`, then probe for that global.
 * - `loadEsmScript()` for ESM-only packages (e.g. @soniox/client)
 *   that never self-assign a global. Inject a `<script type="module">`
 *   shim that `import()`s the bundle, stashes the namespace on a
 *   `window` key we pick, and signals back across the userscript
 *   sandbox boundary once the *async* import settles.
 *
 * Why two functions rather than one with an `esm` flag: the two share
 * only the in-flight dedup + error-eviction bookkeeping (centralised
 * below in `inFlight`). Their injection and — crucially — their
 * *resolution* differ completely. A UMD `<script>`'s `onload` fires in
 * the sandbox and IS the completion signal; an ESM shim's `onload`
 * fires while `import()` is still pending, so there's no DOM event for
 * "the module finished" and we must hand a resolver into the page
 * context. A boolean would just switch between two disjoint bodies.
 *
 * Why we deliberately bypass the bundler's `externalGlobals` /
 * Tampermonkey `@require` path for these libs: that path fetches
 * eagerly at every userscript injection, even on pages where the
 * feature is never used. Lazy injection collapses that cost to zero
 * until the user actually toggles the feature on.
 *
 * The injected scripts run in the page context (not the userscript
 * sandbox), so any global lands on the real page window. Callers must
 * therefore probe via `unsafeWindow` rather than the sandboxed
 * `window` the userscript sees by default.
 */

import { unsafeWindow } from '$'

// Resolver slots the ESM shim calls back into. Keyed by a per-load id
// so concurrent loads (shouldn't happen — the in-flight cache dedupes
// — but defensively) don't step on each other's callback.
declare global {
  interface Window {
    [slot: `__esmLoad_resolve_${number}`]: (() => void) | undefined
    [slot: `__esmLoad_reject_${number}`]: ((err: string) => void) | undefined
  }
}

const inFlight = new Map<string, Promise<unknown>>()

/**
 * Inject `url` as a UMD `<script>` tag and resolve once `getGlobal()`
 * reports the expected global is on the window. Safe to call
 * concurrently — callers for the same URL share a single fetch.
 *
 * @param url - Script URL (typically a version-pinned unpkg path).
 * @param getGlobal - Probe that returns the installed global, or
 *   `null` if it isn't on the window yet. Called BEFORE injection
 *   to short-circuit when something else on the page already loaded
 *   the same library, and AFTER `onload` to confirm the install
 *   actually took (script `onload` only proves the bytes downloaded,
 *   not that they did anything useful — a 200-with-empty-body would
 *   silently "succeed" otherwise).
 */
export function loadUmdScript<T>(url: string, getGlobal: () => T | null): Promise<T> {
  const existing = getGlobal()
  if (existing) return Promise.resolve(existing)

  const cached = inFlight.get(url)
  if (cached) return cached as Promise<T>

  const promise = new Promise<T>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    // unpkg sets `access-control-allow-origin: *`, so anonymous
    // CORS works and the browser doesn't gate the global assignment
    // behind a credentialled CORS check.
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      const g = getGlobal()
      if (g) resolve(g)
      else reject(new Error(`script loaded but expected global not found: ${url}`))
    }
    script.onerror = () => {
      // Evict so a subsequent caller can retry instead of being
      // permanently locked into the failed promise.
      inFlight.delete(url)
      reject(new Error(`failed to load script from ${url}`))
    }
    document.head.appendChild(script)
  })
  inFlight.set(url, promise)
  return promise
}

/**
 * Inject `url` as an ESM `<script type="module">` shim, stash its
 * namespace on `unsafeWindow[globalKey]`, and resolve with it. Safe to
 * call concurrently — callers for the same URL share a single fetch.
 *
 * @param url - ESM module URL (typically a version-pinned `.mjs`).
 * @param globalKey - Property on the page window where the shim parks
 *   the imported namespace. We choose it (unlike UMD, where the
 *   library dictates its own global), so an underscored prefix that
 *   won't collide with anything the host page assigns is wise.
 */
export function loadEsmScript<T>(url: string, globalKey: string): Promise<T> {
  const getGlobal = () => ((unsafeWindow as unknown as Record<string, unknown>)[globalKey] as T | undefined) ?? null

  const existing = getGlobal()
  if (existing) return Promise.resolve(existing)

  const cached = inFlight.get(url)
  if (cached) return cached as Promise<T>

  const promise = new Promise<T>((resolve, reject) => {
    // Unique id so the shim's resolve/reject callbacks don't clash if
    // two loads somehow run at once. We hand resolve/reject *into* the
    // page context via temporary `window.*` slots because functions
    // can't cross the userscript sandbox boundary directly — only the
    // resolved namespace travels back, through `unsafeWindow[globalKey]`,
    // which is a plain object.
    const id = Date.now() + Math.floor(Math.random() * 1000)
    // `as const` pins the literal type so these indexed assignments
    // match the `__esmLoad_*_${number}` index signature on Window
    // rather than widening to `string` and falling back to `any`.
    const resolveKey = `__esmLoad_resolve_${id}` as const
    const rejectKey = `__esmLoad_reject_${id}` as const
    const win = unsafeWindow

    const cleanup = () => {
      win[resolveKey] = undefined
      win[rejectKey] = undefined
    }

    win[resolveKey] = () => {
      cleanup()
      const mod = getGlobal()
      if (mod) resolve(mod)
      else reject(new Error(`module loaded but global not set: ${url}`))
    }
    win[rejectKey] = (msg: string) => {
      cleanup()
      inFlight.delete(url)
      reject(new Error(msg))
    }

    const script = document.createElement('script')
    script.type = 'module'
    // The module body imports the bundled SDK, stashes the namespace
    // on `window[globalKey]`, then signals back to the sandbox via the
    // resolver we installed above. We catch import errors too — a CDN
    // outage or a bad version pin would otherwise leave us hanging,
    // since the script element's `onerror` only covers the shim itself,
    // not the dynamic `import()` it kicks off.
    script.textContent = `
      import(${JSON.stringify(url)})
        .then((mod) => {
          window[${JSON.stringify(globalKey)}] = mod;
          window[${JSON.stringify(resolveKey)}]?.();
        })
        .catch((err) => {
          window[${JSON.stringify(rejectKey)}]?.(String(err?.message || err));
        });
    `
    script.onerror = () => {
      cleanup()
      inFlight.delete(url)
      reject(new Error(`failed to inject module loader for ${url}`))
    }
    document.head.appendChild(script)
  })
  inFlight.set(url, promise)
  return promise
}
