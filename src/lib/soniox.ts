/**
 * Lazy loader for the @soniox/client SDK (v2+).
 *
 * The previous SDK (@soniox/speech-to-text-web) was deprecated and
 * shipped a UMD bundle, so it could be lazy-loaded via a plain
 * `<script>` tag with a `window.*` probe. @soniox/client ships
 * ESM/CJS only — no UMD — so we inject a `<script type="module">`
 * that imports from unpkg and stashes the namespace on
 * `window.__sonioxClient` for the userscript sandbox to read.
 *
 * Why we keep the lazy path instead of bundling: the SDK adds
 * ~42 KB minified to the userscript and pulls in MediaRecorder /
 * WebSocket setup that's only useful when the user actually opens
 * the STT tab. Lazy injection collapses that cost to zero until
 * 开始同传 is clicked, matching the strategy used for mpegts.js.
 *
 * Source files keep `import type { ... } from '@soniox/client'` for
 * static typing; the value-side reference goes through `loadSoniox()`
 * and reads off the page-window namespace at call time.
 */

import { unsafeWindow } from '$'
import { SONIOX_CDN_URL } from './const'

type SonioxModule = typeof import('@soniox/client')

// Property name we stash the module namespace on. Underscored prefix
// to avoid colliding with anything bilibili.com itself might assign.
const GLOBAL_KEY = '__sonioxClient'

// Augment the `Window` interface in-place so `unsafeWindow.*` is
// typed for the three slots we mount, with no cast at the call
// sites. Wider than necessary on the per-load `__sonioxClient_*`
// slots — they're keyed by a random id at runtime — but TypeScript
// has no template-literal-with-runtime-number index signature, so
// we settle for the looser union and gain readable call sites.
declare global {
  interface Window {
    [GLOBAL_KEY]?: SonioxModule
    [slot: `__sonioxClient_resolve_${number}`]: (() => void) | undefined
    [slot: `__sonioxClient_reject_${number}`]: ((err: string) => void) | undefined
  }
}

let inFlight: Promise<SonioxModule> | null = null

function getSonioxFromWindow(): SonioxModule | null {
  return unsafeWindow[GLOBAL_KEY] ?? null
}

export function loadSoniox(): Promise<SonioxModule> {
  const existing = getSonioxFromWindow()
  if (existing) return Promise.resolve(existing)
  if (inFlight) return inFlight

  inFlight = new Promise<SonioxModule>((resolve, reject) => {
    // Unique id so concurrent loads (shouldn't happen, but…) don't
    // step on each other's resolver slot. We hand the resolve/reject
    // *into* the page context via temporary `window.*` callbacks
    // because functions can't cross the userscript sandbox boundary
    // directly — only the resolved value travels back through
    // `unsafeWindow.__sonioxClient`, which is a plain object.
    const id = Date.now() + Math.floor(Math.random() * 1000)
    // Template literals over a non-literal `number` widen to `string`,
    // which doesn't match the `__sonioxClient_resolve_${number}`
    // index signature on Window. `as const` pins the literal type so
    // the indexed assignments below are statically checked rather
    // than falling back to an implicit any.
    const resolveKey = `__sonioxClient_resolve_${id}` as const
    const rejectKey = `__sonioxClient_reject_${id}` as const
    const win = unsafeWindow

    const cleanup = () => {
      win[resolveKey] = undefined
      win[rejectKey] = undefined
    }

    win[resolveKey] = () => {
      cleanup()
      const mod = getSonioxFromWindow()
      if (mod) resolve(mod)
      else reject(new Error('Soniox module loaded but global not set'))
    }
    win[rejectKey] = (msg: string) => {
      cleanup()
      inFlight = null
      reject(new Error(msg))
    }

    const script = document.createElement('script')
    script.type = 'module'
    // The module body imports the bundled SDK, stashes the namespace
    // on `window`, then signals back to the sandbox via the resolver
    // we installed above. We catch import errors too — a CDN outage
    // or a bad version pin would otherwise leave the promise hanging.
    script.textContent = `
      import(${JSON.stringify(SONIOX_CDN_URL)})
        .then((mod) => {
          window[${JSON.stringify(GLOBAL_KEY)}] = mod;
          window[${JSON.stringify(resolveKey)}]?.();
        })
        .catch((err) => {
          window[${JSON.stringify(rejectKey)}]?.(String(err?.message || err));
        });
    `
    script.onerror = () => {
      cleanup()
      inFlight = null
      reject(new Error(`failed to inject Soniox loader for ${SONIOX_CDN_URL}`))
    }
    document.head.appendChild(script)
  })

  return inFlight
}
