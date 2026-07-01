/**
 * Lazy loader for the @soniox/client SDK (v2+).
 *
 * ESM/CJS-only (no UMD), so it can't be probed off `window.*`; lazy
 * injection also keeps ~42 KB off the userscript until the STT tab opens.
 */

import { SONIOX_CDN_URL } from './const'
import { loadEsmScript } from './load-script'

type SonioxModule = typeof import('@soniox/client')

// Underscored prefix avoids colliding with anything bilibili.com assigns.
const GLOBAL_KEY = '__sonioxClient'

export function loadSoniox(): Promise<SonioxModule> {
  return loadEsmScript<SonioxModule>(SONIOX_CDN_URL, GLOBAL_KEY)
}
