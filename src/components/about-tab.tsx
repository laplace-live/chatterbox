import { DOCUMENT_URL, GITHUB_URL } from '../lib/const'
import { VERSION } from '../lib/version'
import { Separator } from './ui/separator'

interface ExternalService {
  name: string
  host: string
  url?: string
  trigger: string
  description: string
}

const EXTERNAL_SERVICES: ExternalService[] = [
  {
    name: 'AI 弹幕审核',
    host: 'edge-workers.laplace.cn',
    url: 'https://subspace.institute/docs/open-platform/chat-audit',
    trigger: '启用「AI 规避」功能时',
    description:
      '当弹幕发送失败且开启了 AI 规避功能后，脚本会将弹幕文本发送至此服务进行敏感词检测，并尝试自动替换敏感词后重新发送。',
  },
  {
    name: '云端替换规则',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/replacement',
    trigger: '在设置中启用「云端规则替换」后自动同步',
    description:
      '从云端获取由社区维护的弹幕敏感词替换规则。该功能默认关闭，需在设置页手动开启；开启后会立即同步一次，并每 10 分钟自动同步一次。',
  },
  {
    name: '烂梗列表',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/memes',
    trigger: '在「烂梗库」面板中勾选「开启烂梗库」后',
    description:
      '从 LAPLACE Live! 服务获取烂梗列表。该功能默认关闭，需在「烂梗库」面板左上角手动勾选开启；开启后每 30 秒自动刷新一次，复制或发送烂梗时会向服务报告使用次数。',
  },
  {
    name: 'LLM API（用户自定义）',
    host: '用户在设置中配置',
    trigger: '在设置中点击「刷新」获取模型列表，或使用对应的 AI 功能时调用',
    description:
      '兼容 OpenAI API 的大语言模型服务，由用户自行配置 API 地址与 API Key。脚本会向用户填写的地址发送请求，请确保该地址可信。',
  },
  {
    name: 'Soniox 语音识别',
    host: 'api.soniox.com',
    url: 'https://soniox.com',
    trigger: '使用同传功能时',
    description: '通过 WebSocket 连接 Soniox 语音识别云服务，将麦克风音频流实时转换为文字。需要提供 Soniox API Key。',
  },
  {
    name: 'Soniox SDK',
    host: 'unpkg.com',
    url: 'https://github.com/soniox/soniox-js',
    trigger: '首次启动同传时',
    description: '从 unpkg CDN 按需加载 Soniox 语音识别 SDK (@soniox/client)，仅在首次点击「开始同传」时下载。',
  },
  {
    name: 'ElevenLabs 语音识别',
    host: 'api.elevenlabs.io',
    url: 'https://elevenlabs.io',
    trigger: '将同传供应商切换为 ElevenLabs 并使用同传功能时',
    description:
      '通过 WebSocket 连接 ElevenLabs Scribe 实时语音识别服务，将麦克风音频流实时转换为文字。连接前会先用 API Key 申请一个有效期 15 分钟的一次性令牌（避免在 WebSocket 上暴露 API Key）。需要提供 ElevenLabs API Key。',
  },
  {
    name: 'mpegts.js',
    host: 'unpkg.com',
    url: 'https://github.com/xqq/mpegts.js',
    trigger: '首次启用仅音频模式时',
    description:
      '从 unpkg CDN 按需加载 mpegts.js 流媒体库，用于解析 bilibili 直播的纯音频流，仅在首次点击「仅音频」时下载。',
  },
  {
    name: '主播公会 / MCN 信息',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/streamer-info',
    trigger: '在设置中开启「显示公会」或「显示 MCN」后，打开主播信息面板时',
    description:
      '向 LAPLACE Live! 服务发送当前主播的 UID，获取该主播在 bilibili 的历史公会与 MCN 归属记录。两个开关共享同一个接口，开启其中任意一个即会触发请求。数据按 UID 在页面内存中缓存，刷新页面后会重新获取。',
  },
  {
    name: '主播魔法期数据',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/streamer-info',
    trigger: '在设置中开启「显示魔法期」后，打开主播信息面板时',
    description:
      '向 LAPLACE Live! 服务发送当前主播的 UID（直播间页面为主播 UID，个人空间页面为页面 UID），获取该主播的魔法期记录与预测。仅在开启对应开关后才会请求，数据按 UID 在页面内存中缓存，刷新页面后会重新获取。',
  },
]

export function AboutTab() {
  return (
    <>
      <div class={'my-2 pb-4'}>
        <div class={'mb-2 font-bold'}>LAPLACE Chatterbox 直播助手</div>
        <div class='flex flex-col text-ga6'>
          <span>版本: {VERSION}</span>
          <span>
            作者:{' '}
            <a href='https://laplace.live' target='_blank' rel='noopener' class={'text-link no-underline'}>
              LAPLACE Live!
            </a>
          </span>
          <span>许可证: AGPL-3.0</span>
          <span>
            源代码:{' '}
            <a href={GITHUB_URL} target='_blank' rel='noopener' class={'text-link no-underline'}>
              GitHub
            </a>
          </span>
          <span>
            使用文档:{' '}
            <a href={DOCUMENT_URL} target='_blank' rel='noopener' class={'text-link no-underline'}>
              Subspace Institute 亚空间研究所
            </a>
          </span>
        </div>
      </div>

      <Separator />

      <div class='my-2 pb-4'>
        <div class={'mb-2 font-bold'}>隐私说明</div>
        <div class='mb-3 text-ga6'>本脚本在运行时可能会与以下外部服务通信。不同功能触发的请求不同，请按需启用。</div>

        <div class='flex flex-col gap-3'>
          {EXTERNAL_SERVICES.map(service => (
            <div key={service.name} class='rounded bg-ga1s p-2'>
              <div class='mb-1 font-bold'>
                {service.url ? (
                  <a href={service.url} target='_blank' rel='noopener' class={'text-link no-underline'}>
                    {service.name}
                  </a>
                ) : (
                  service.name
                )}
              </div>
              <div class='mb-1 font-mono text-ga6 text-sm'>{service.host}</div>
              <div class='mb-1'>
                <span class='text-brand'>触发条件:</span> {service.trigger}
              </div>
              <div class='text-ga6'>{service.description}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
