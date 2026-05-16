/**
 * Lazy loader for the @soniox/speech-to-text-web SDK.
 *
 * Previously bundled via `externalGlobals` (@require), which made
 * Tampermonkey fetch the SDK eagerly on every bilibili page load —
 * paying the ~150 KB cost for users who never opened the STT tab.
 * Switching to runtime injection collapses that cost to zero until
 * the user actually clicks 开始同传, matching the same lazy strategy
 * mpegts.js uses for audio-only mode.
 *
 * Source files keep their `import type { SonioxClient }` for static
 * typing; the value-side reference goes through `loadSoniox()` and
 * reads the constructor off the page-window namespace at call time.
 */

import { unsafeWindow } from '$'
import { loadScript } from './load-script'

type SonioxModule = typeof import('@soniox/speech-to-text-web')

// Pinned version. Locked rather than `latest` so an upstream
// breaking change can't silently land in user browsers on the next
// CDN cache miss. Bump deliberately when validating a new version,
// and keep it in sync with the version range in `package.json`
// (installed purely for `import type`) so the locally-checked
// types stay accurate against the runtime UMD we actually fetch.
const SONIOX_CDN_URL = 'https://unpkg.com/@soniox/speech-to-text-web@1.4.0/dist/speech-to-text-web.umd.cjs'

function getSonioxFromWindow(): SonioxModule | null {
  // The UMD bundle assigns its exports to a hyphenated global —
  // bracket access is mandatory because `window.speech-to-text-web`
  // would parse as subtraction. (Verified in the published UMD:
  //   `o(s["speech-to-text-web"]={})`.)
  const candidate = (unsafeWindow as unknown as { 'speech-to-text-web'?: SonioxModule })['speech-to-text-web']
  return candidate ?? null
}

export function loadSoniox(): Promise<SonioxModule> {
  return loadScript(SONIOX_CDN_URL, getSonioxFromWindow)
}
