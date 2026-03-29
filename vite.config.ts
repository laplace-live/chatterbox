import { defineConfig } from 'vite'
import monkey, { util } from 'vite-plugin-monkey'

export default defineConfig({
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'LAPLACE 弹幕助手 - 哔哩哔哩直播间独轮车、弹幕发送',
        namespace: 'https://greasyfork.org/users/1524935',
        version: '2.3.3',
        description:
          '这是 bilibili 直播间简易版独轮车，基于 quiet/thusiant cmd 版本 https://greasyfork.org/scripts/421507 继续维护而来',
        author: 'laplace-live',
        license: 'AGPL-3.0',
        icon: 'https://laplace.live/favicon.ico',
        match: ['*://live.bilibili.com/*'],
        'run-at': 'document-start',
      },
      build: {
        externalGlobals: {
          '@soniox/speech-to-text-web': [
            'SonioxSpeechToTextWeb',
            (version: string) =>
              `https://unpkg.com/@soniox/speech-to-text-web@${version}/dist/speech-to-text-web.umd.cjs`,
          ].concat(util.dataUrl(';window.SonioxSpeechToTextWeb=window["speech-to-text-web"];')),
        },
      },
    }),
  ],
})
