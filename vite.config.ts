import preact from '@preact/preset-vite'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import monkey, { util } from 'vite-plugin-monkey'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    UnoCSS(),
    preact(),
    monkey({
      entry: 'src/main.tsx',
      userscript: {
        // @name 是 Greasy Fork 搜索抓的 SEO 锚点，**绝不**移动 "独轮车 + 自动跟车"
        // 这两个关键词的位置 —— 用户就是搜这两个词找到这个脚本的。Jobs 不
        // 为了视觉纯洁牺牲发现力；产品识别度由 @description + hero tagline +
        // README H1 这些「人看的」位置承担，@name 留给「机器+用户搜索」的工作。
        name: 'B站独轮车 + 自动跟车 / Bilibili Live Auto Follow',
        namespace: 'https://github.com/aijc123/bilibili-live-wheel-auto-follow',
        description:
          '替你说，替你看 —— 给每天泡 B 站直播、在弹幕里特别活跃的观众。独轮车循环 / 自动跟车 / 手动发送 + AI 润色 / 影子屏蔽自动改写 / Chatterbox Chat 接管评论区 / 粉丝牌禁言巡检 / 同传 + 烂梗库。',
        author: 'aijc123',
        license: 'AGPL-3.0',
        icon: 'https://www.bilibili.com/favicon.ico',
        homepage: 'https://aijc123.github.io/bilibili-live-wheel-auto-follow/',
        homepageURL: 'https://aijc123.github.io/bilibili-live-wheel-auto-follow/',
        website: 'https://aijc123.github.io/bilibili-live-wheel-auto-follow/',
        source: 'https://github.com/aijc123/bilibili-live-wheel-auto-follow',
        supportURL: 'https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues',
        // 只匹配直播间页面。space.bilibili.com 以前也在 match 列表里，但
        // main.tsx 在非 `live.bilibili.com` hostname 上立即 return（见 main.tsx:15-21），
        // 死匹配，保留只会让 TM 安装提示多列一个让新用户警觉的域名。
        match: ['*://live.bilibili.com/*'],
        connect: [
          'bilibili-guard-room.vercel.app',
          'localhost',
          // 烂梗库专属梗源（灰泽满直播间等社区自建库）
          'sbhzm.cn',
          // chatterbox-cloud 自建后端（聚合 LAPLACE+SBHZM+社区贡献，硬审核）
          // 默认部署在 *.workers.dev；本地开发时 cbBackendUrlOverride 走上面的 localhost。
          'chatterbox-cloud.aijc-eric.workers.dev',
          // live-meme-radar 传感器后端（跨房间 meme 聚类 + trending rank）。
          // 只读：烂梗库面板打开时后台拉一次 /radar/clusters/today（10 分钟缓存），
          // 把命中的梗在 UI 上加 🔥 徽章。无用户开关，失败静默。不发送弹幕。
          'live-meme-radar.aijc-eric.workers.dev',
          // 智能辅助驾驶 LLM 默认 provider
          'api.anthropic.com',
          'api.openai.com',
          // OpenAI 兼容自定义 base URL（DeepSeek/Moonshot/OpenRouter/Ollama/小米 mimo 等）。
          // 之前我们没有兜底 → TM 直接以 "domain is not a part of the @connect list"
          // 拒绝，连权限弹窗都不会出。加 '*' 后 TM 仍会在首次访问每个新域时弹一次
          // 用户确认（这是用户授权 LLM 的最后一道闸门），但不会再无声拒绝。
          '*',
        ],
        'run-at': 'document-start',
      },
      build: {
        metaFileName: true,
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
