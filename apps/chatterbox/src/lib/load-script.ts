/**
 * Lazy UMD CDN-bundle loader sharing one in-flight cache. Lazy injection
 * avoids the eager fetch of `externalGlobals`/`@require` on every page.
 * Injected scripts run in the page context, so globals are read back via
 * `unsafeWindow`, not the sandboxed `window`.
 */

import { unsafeWindow } from '$'

// Untyped so one map serves every loader without casts; `loadUmdScript` re-validates per caller.
const inFlight = new Map<string, Promise<void>>()

/**
 * Inject `url` as a UMD `<script>` and resolve with the global it installs
 * at `unsafeWindow[globalKey]`. Concurrent callers for the same URL share one fetch.
 */
export function loadUmdScript<T>(
  url: string,
  globalKey: keyof Window,
  isValid: (value: unknown) => value is T
): Promise<T> {
  const read = (): T | null => {
    const value: unknown = unsafeWindow[globalKey]
    return isValid(value) ? value : null
  }
  const existing = read()
  if (existing) return Promise.resolve(existing)

  let pending = inFlight.get(url)
  if (!pending) {
    pending = injectUmdScript(url).catch((err: unknown) => {
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
