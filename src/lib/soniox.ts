/**
 * Lazy loader for the @soniox/client SDK (v2+).
 *
 * @soniox/client ships ESM/CJS only — no UMD — so it can't be pulled
 * in via a plain `<script>` + `window.*` probe the way a UMD bundle
 * can. `loadEsmScript()` (see `lib/load-script.ts`) owns the
 * `<script type="module">` injection, namespace stashing, and the
 * resolve-across-the-sandbox dance; this module just binds it to the
 * Soniox URL and the global key we park the namespace on.
 *
 * Why we keep the lazy path instead of bundling: the SDK adds ~42 KB
 * minified to the userscript and pulls in MediaRecorder / WebSocket
 * setup that's only useful when the user actually opens the STT tab.
 * Lazy injection collapses that cost to zero until 开始同传 is clicked,
 * matching the strategy used for mpegts.js.
 *
 * Source files keep `import type { ... } from '@soniox/client'` for
 * static typing; the value-side reference goes through `loadSoniox()`
 * and reads off the page-window namespace at call time.
 */

import { SONIOX_CDN_URL } from './const'
import { loadEsmScript } from './load-script'

type SonioxModule = typeof import('@soniox/client')

// Property name we stash the module namespace on. Underscored prefix
// to avoid colliding with anything bilibili.com itself might assign.
const GLOBAL_KEY = '__sonioxClient'

export function loadSoniox(): Promise<SonioxModule> {
  return loadEsmScript<SonioxModule>(SONIOX_CDN_URL, GLOBAL_KEY)
}
