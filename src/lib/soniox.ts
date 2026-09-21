/**
 * Lazy loader for the @soniox/client SDK (v2+).
 *
 * ESM/CJS-only (no UMD), so it can't be probed off `window.*`; lazy
 * injection also keeps ~42 KB off the userscript until the STT tab opens.
 */

import { unsafeWindow } from '$'
import { SONIOX_CDN_URL } from './const'
import { loadEsmScript } from './load-script'
import { isRecord } from './utils'

type SonioxModule = typeof import('@soniox/client')

// Where the ESM shim parks the namespace; narrowed by `isSonioxModule`.
declare global {
  interface Window {
    __sonioxClient?: unknown
  }
}

// Underscored prefix avoids colliding with anything bilibili.com assigns.
const GLOBAL_KEY = '__sonioxClient'

/** Checks the constructors `soniox-engine` instantiates. */
function isSonioxModule(value: unknown): value is SonioxModule {
  return isRecord(value) && typeof value.SonioxClient === 'function' && typeof value.MicrophoneSource === 'function'
}

function getSonioxFromWindow(): SonioxModule | null {
  const mod = unsafeWindow[GLOBAL_KEY]
  return isSonioxModule(mod) ? mod : null
}

export function loadSoniox(): Promise<SonioxModule> {
  return loadEsmScript(SONIOX_CDN_URL, GLOBAL_KEY, getSonioxFromWindow)
}
