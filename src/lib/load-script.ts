/**
 * Shared lazy `<script>` loader for CDN-hosted UMD bundles.
 *
 * Why this lives in its own module: two unrelated features
 * (audio-only via mpegts.js, speech-to-text via Soniox) load CDN
 * bundles with the exact same shape — probe the page for a global,
 * inject a `<script>` tag if missing, share the in-flight promise so
 * concurrent callers don't race two parallel fetches, evict the
 * cache on error so a retry can re-fetch. Centralising here means
 * any future lazy CDN dep gets the same battle-tested behaviour for
 * free, and we don't have N copies of the dance drifting apart.
 *
 * Why we deliberately bypass the bundler's `externalGlobals` /
 * Tampermonkey `@require` path for these libs: that path fetches
 * eagerly at every userscript injection, even on pages where the
 * feature is never used. Lazy injection collapses that cost to zero
 * until the user actually toggles the feature on.
 *
 * The injected `<script>` runs in the page context (not the
 * userscript sandbox), so the global lands on the real page window.
 * Callers must therefore probe via `unsafeWindow` rather than the
 * sandboxed `window` the userscript sees by default.
 */

const inFlight = new Map<string, Promise<unknown>>()

/**
 * Inject `url` as a `<script>` tag and resolve once `getGlobal()`
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
export function loadScript<T>(url: string, getGlobal: () => T | null): Promise<T> {
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
