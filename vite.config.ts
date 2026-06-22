import preact from '@preact/preset-vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import monkey from 'vite-plugin-monkey'

import { GITHUB_URL, PROJECT_URL } from './src/lib/const'

// const DOWNLOAD_BASE = 'https://laplace-live.github.io/chatterbox' // Github Pages backup, 100 GB bandwidth/month limit
const DOWNLOAD_BASE = 'https://downloads.vrp.moe/chatterbox'

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
        homepageURL: PROJECT_URL,
        supportURL: GITHUB_URL,
        match: [
          '*://live.bilibili.com/*',
          '*://space.bilibili.com/*',
          '*://www.bilibili.com/video/*',
          '*://www.bilibili.com/opus/*',
        ],
        'run-at': 'document-start',
        // GM_xmlhttpRequest target: the Deepgram model-list fetch
        // (GET /v1/models) is cross-origin and Deepgram sends no CORS headers
        // for third-party origins, so it routes through GM_xmlhttpRequest. The
        // STT WebSockets (all providers) and the ElevenLabs token fetch need no
        // @connect.
        connect: ['api.deepgram.com'],
        // Self-hosted on GitHub Pages: managers poll the 1 KB meta file for
        // version checks and only fetch the full script when it changes.
        downloadURL: `${DOWNLOAD_BASE}/laplace-chatterbox.user.js`,
        updateURL: `${DOWNLOAD_BASE}/laplace-chatterbox.meta.js`,
      },
      build: {
        metaFileName: true,
      },
    }),
  ],
})
