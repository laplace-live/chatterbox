/**
 * Lazy CDN-bundle loaders sharing one in-flight cache. Lazy injection
 * avoids the eager fetch of `externalGlobals`/`@require` on every page.
 * Injected scripts run in the page context, so callers must probe via
 * `unsafeWindow`, not the sandboxed `window`.
 */

import { unsafeWindow } from '$'

// Resolver slots the ESM shim calls back into, keyed per-load id.
declare global {
  interface Window {
    [slot: `__esmLoad_resolve_${number}`]: (() => void) | undefined
    [slot: `__esmLoad_reject_${number}`]: ((err: string) => void) | undefined
  }
}

// Settles once a URL's script has run; each caller re-probes through its own typed getter.
const inFlight = new Map<string, Promise<void>>()

/**
 * Inject `url` as a UMD `<script>`, resolving once `getGlobal()` reports
 * the global. Concurrent callers for the same URL share one fetch.
 *
 * @param getGlobal - Probe for the installed global (`null` if absent).
 *   Run after `onload` too, since `onload` proves only that bytes
 *   downloaded — an empty-body 200 would otherwise silently succeed.
 */
export function loadUmdScript<T>(url: string, getGlobal: () => T | null): Promise<T> {
  const existing = getGlobal()
  if (existing) return Promise.resolve(existing)

  const probe = (): T => {
    const g = getGlobal()
    if (!g) throw new Error(`script loaded but expected global not found: ${url}`)
    return g
  }

  const cached = inFlight.get(url)
  if (cached) return cached.then(probe)

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    // unpkg sends `access-control-allow-origin: *`, so anonymous CORS works.
    script.crossOrigin = 'anonymous'
    script.onload = () => resolve()
    script.onerror = () => {
      // Evict so a later caller can retry instead of reusing the failed promise.
      inFlight.delete(url)
      reject(new Error(`failed to load script from ${url}`))
    }
    document.head.appendChild(script)
  })
  inFlight.set(url, promise)
  return promise.then(probe)
}

/**
 * Inject `url` as an ESM `<script type="module">` shim, stash its
 * namespace on `unsafeWindow[globalKey]`, and resolve with it.
 * Concurrent callers for the same URL share one fetch.
 *
 * @param globalKey - Page-window property where the shim parks the
 *   namespace; we pick it, so use an underscored prefix to avoid
 *   colliding with the host page.
 * @param getGlobal - Reads `unsafeWindow[globalKey]` back, narrowed to `T` (`null` if absent).
 */
export function loadEsmScript<T>(url: string, globalKey: string, getGlobal: () => T | null): Promise<T> {
  const existing = getGlobal()
  if (existing) return Promise.resolve(existing)

  const probe = (): T => {
    const mod = getGlobal()
    if (!mod) throw new Error(`module loaded but global not set: ${url}`)
    return mod
  }

  const cached = inFlight.get(url)
  if (cached) return cached.then(probe)

  const promise = new Promise<void>((resolve, reject) => {
    // resolve/reject go through temporary `window.*` slots because
    // functions can't cross the userscript sandbox boundary; only the
    // plain namespace object travels back via `unsafeWindow[globalKey]`.
    const id = Date.now() + Math.floor(Math.random() * 1000)
    // `as const` pins the literal to the `__esmLoad_*_${number}` index
    // signature instead of widening to `string` (which falls back to `any`).
    const resolveKey = `__esmLoad_resolve_${id}` as const
    const rejectKey = `__esmLoad_reject_${id}` as const
    const win = unsafeWindow

    const cleanup = () => {
      win[resolveKey] = undefined
      win[rejectKey] = undefined
    }

    win[resolveKey] = () => {
      cleanup()
      resolve()
    }
    win[rejectKey] = (msg: string) => {
      cleanup()
      inFlight.delete(url)
      reject(new Error(msg))
    }

    const script = document.createElement('script')
    script.type = 'module'
    // Catch inside the shim: the element's `onerror` covers the shim
    // itself, not the dynamic `import()` it kicks off (which would
    // otherwise hang on a CDN outage or bad version pin).
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
  return promise.then(probe)
}
