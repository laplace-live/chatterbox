import { readFileSync } from 'node:fs'
import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

// Read package.json directly — some packages (e.g. @preact/signals) don't
// expose it through their exports map, so require() can't reach it.
const pkgVersion = (name: string) =>
  JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8')).version

// Preact is loaded via @require per Greasy Fork's library rule. npmmirror is
// on Greasy Fork's allowed CDN list and is reliable for this script's
// primary audience (mainland-China Bilibili users), unlike jsDelivr.
const preactVersion = pkgVersion('preact')
const preactCdn = (path: string) => `https://registry.npmmirror.com/preact/${preactVersion}/files/${path}`

// Greasy Fork requires inlined libraries to carry source attribution and a
// technical reason for not using @require.
const inlinedLibsBanner = `/*
 * Bundled third-party libraries (each bundled verbatim from its official npm
 * package, unminified by this build). None of them can be loaded via
 * @require: they either ship no UMD build, or are tree-shaken to a small
 * subset of a very large package:
 * - @preact/signals@${pkgVersion('@preact/signals')} — https://www.npmjs.com/package/@preact/signals (no UMD build)
 * - tailwind-merge@${pkgVersion('tailwind-merge')} — https://www.npmjs.com/package/tailwind-merge (no UMD build)
 * - clsx@${pkgVersion('clsx')} — https://www.npmjs.com/package/clsx (no unminified UMD build)
 * - @tabler/icons-preact@${pkgVersion('@tabler/icons-preact')} — https://www.npmjs.com/package/@tabler/icons-preact (only the icons actually used)
 */`

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    // Tailwind v4 must run before the framework plugin so it can scan the
    // JSX sources before they're transformed to plain JS. The emitted CSS
    // is referenced via `import './styles.css'` in the entry and inlined
    // into the userscript by vite-plugin-monkey via GM_addStyle.
    tailwindcss(),
    preact(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        name: 'LAPLACE 弹幕助手 - 哔哩哔哩直播间独轮车、弹幕发送',
        namespace: 'https://greasyfork.org/users/1524935',
        description:
          '这是 bilibili 直播间简易版独轮车，基于 quiet/thusiant cmd 版本 https://greasyfork.org/scripts/421507 继续维护而来',
        author: 'laplace-live',
        license: 'AGPL-3.0',
        icon: 'https://laplace.live/favicon.ico',
        match: ['*://live.bilibili.com/*', '*://space.bilibili.com/*', '*://www.bilibili.com/video/*'],
        'run-at': 'document-start',
      },
      build: {
        metaFileName: true,
        // Greasy Fork requires libraries to be loaded via @require where
        // technically possible; the preact family ships UMD builds.
        externalGlobals: {
          preact: ['preact', preactCdn('dist/preact.umd.js')],
          'preact/hooks': ['preactHooks', preactCdn('hooks/dist/hooks.umd.js')],
          'preact/jsx-runtime': ['jsxRuntime', preactCdn('jsx-runtime/dist/jsxRuntime.umd.js')],
          'preact/compat': ['preactCompat', preactCdn('compat/dist/compat.umd.js')],
        },
      },
    }),
  ],
  build: {
    // Greasy Fork requires the posted script body to be unminified, with
    // whitespace and variable names retained.
    minify: false,
    rollupOptions: {
      output: {
        banner: inlinedLibsBanner,
      },
    },
  },
})
