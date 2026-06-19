import { GM_info } from '$'

/**
 * Userscript version, sourced from the `// @version` header that
 * vite-plugin-monkey generates from `package.json`. Importing `GM_info`
 * from `$` lets vite-plugin-monkey track the dependency and add the
 * matching `@grant`.
 *
 * Kept out of `const.ts` so that file stays free of the `$` userscript-
 * runtime import — that lets `vite.config.ts` import the plain string
 * constants from `const.ts` when Node evaluates the config (where `$`
 * doesn't resolve). Import `VERSION` from here directly, not via `const`.
 */
export const VERSION = GM_info.script.version
