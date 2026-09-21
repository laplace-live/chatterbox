/**
 * Lazy CDN-bundle loaders sharing one in-flight cache. Lazy injection
 * avoids the eager fetch of `externalGlobals`/`@require` on every page.
 * Injected scripts run in the page context, so globals are read back via
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

// Untyped so one map serves every loader without casts; `loadOnce` re-validates per caller.
const inFlight = new Map<string, Promise<void>>()

/** Resolve with `unsafeWindow[globalKey]` once `isValid` accepts it, sharing one `inject` per URL. */
function loadOnce<T>(
  url: string,
  globalKey: keyof Window,
  isValid: (value: unknown) => value is T,
  inject: () => Promise<void>
): Promise<T> {
  const read = (): T | null => {
    const value: unknown = unsafeWindow[globalKey]
    return isValid(value) ? value : null
  }
  const existing = read()
  if (existing) return Promise.resolve(existing)

  let pending = inFlight.get(url)
  if (!pending) {
    pending = inject().catch((err: unknown) => {
      // Evict so a later caller can retry instead of reusing the failed promise.
      inFlight.delete(url)
      throw err
    })
    inFlight.set(url, pending)
  }
  // Re-check after load: `onload` proves only that bytes arrived, so an empty-body 200 would otherwise pass.
  return pending.then(() => {
    const loaded = read()
    if (!loaded) throw new Error(`script loaded but window.${globalKey} is missing: ${url}`)
    return loaded
  })
}

/**
 * Inject `url` as a UMD `<script>` and resolve with the global it installs
 * at `unsafeWindow[globalKey]`. Concurrent callers for the same URL share one fetch.
 */
export function loadUmdScript<T>(
  url: string,
  globalKey: keyof Window,
  isValid: (value: unknown) => value is T
): Promise<T> {
  return loadOnce(url, globalKey, isValid, () => injectUmdScript(url))
}

function injectUmdScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    // unpkg sends `access-control-allow-origin: *`, so anonymous CORS works.
    script.crossOrigin = 'anonymous'
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load script from ${url}`))
    document.head.appendChild(script)
  })
}

/**
 * Inject `url` as an ESM `<script type="module">` shim, stash its
 * namespace on `unsafeWindow[globalKey]`, and resolve with it.
 * Concurrent callers for the same URL share one fetch.
 *
 * @param globalKey - Page-window property where the shim parks the
 *   namespace; we pick it, so use an underscored prefix to avoid
 *   colliding with the host page.
 */
export function loadEsmScript<T>(
  url: string,
  globalKey: keyof Window,
  isValid: (value: unknown) => value is T
): Promise<T> {
  return loadOnce(url, globalKey, isValid, () => injectEsmScript(url, globalKey))
}

function injectEsmScript(url: string, globalKey: keyof Window): Promise<void> {
  return new Promise((resolve, reject) => {
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
      reject(new Error(`failed to inject module loader for ${url}`))
    }
    document.head.appendChild(script)
  })
}
