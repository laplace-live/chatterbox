import { GM_info } from '$'

/**
 * Userscript version from the `// @version` header; the `$` import makes
 * vite-plugin-monkey add the matching `@grant`. Kept out of `const.ts` so
 * that file stays importable by `vite.config.ts` under Node (no `$` there).
 */
export const VERSION = GM_info.script.version
