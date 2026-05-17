import { DOCUMENT_URL, PROJECT_URL, VERSION } from '../lib/const'

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
    trigger: '打开设置页时自动同步',
    description: '从云端获取由社区维护的弹幕敏感词替换规则，每 10 分钟自动同步一次。',
  },
  {
    name: '烂梗列表',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/memes',
    trigger: '打开独轮车页面中的烂梗列表时',
    description: '从 LAPLACE Live! 服务获取烂梗列表。复制烂梗时会向服务报告使用次数。',
  },
  {
    name: 'Soniox 语音识别',
    host: 'api.soniox.com',
    url: 'https://soniox.com',
    trigger: '使用同传功能时',
    description: '通过 WebSocket 连接 Soniox 语音识别云服务，将麦克风音频流实时转换为文字。需要提供 Soniox API Key。',
  },
  {
    name: 'LLM API（用户自定义）',
    host: '用户在设置中配置',
    trigger: '在设置中点击「刷新」获取模型列表，或使用对应的 AI 功能时调用',
    description:
      '兼容 OpenAI API 的大语言模型服务，由用户自行配置 API 地址与 API Key。脚本会向用户填写的地址发送请求，请确保该地址可信。',
  },
  {
    name: 'Soniox SDK',
    host: 'unpkg.com',
    url: 'https://github.com/soniox/speech-to-text-web',
    trigger: '首次启动同传时',
    description:
      '从 unpkg CDN 按需加载 Soniox 语音识别 SDK (@soniox/speech-to-text-web)，仅在首次点击「开始同传」时下载。',
  },
  {
    name: 'mpegts.js',
    host: 'unpkg.com',
    url: 'https://github.com/xqq/mpegts.js',
    trigger: '首次启用仅音频模式时',
    description:
      '从 unpkg CDN 按需加载 mpegts.js 流媒体库，用于解析 bilibili 直播的纯音频流，仅在首次点击「仅音频」时下载。',
  },
]

export function AboutTab() {
  return (
    <>
      <div class={'my-2 border-b border-b-ga2 border-b-solid pb-4'}>
        <div class={'mb-2 font-bold'}>LAPLACE Chatterbox 弹幕助手</div>
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
            <a href={PROJECT_URL} target='_blank' rel='noopener' class={'text-link no-underline'}>
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

      {/* Same section spacing as above but without the divider on the last block. */}
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
              <div class='mb-1 font-mono text-ga6 text-[.9em]'>{service.host}</div>
              <div class='mb-1 text-[.9em]'>
                <span class='text-brand'>触发条件:</span> {service.trigger}
              </div>
              <div class='text-ga6 text-[.9em]'>{service.description}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
