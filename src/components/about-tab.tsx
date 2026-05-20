import { Fragment } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { VERSION } from '../lib/const'
import {
  activeTab,
  aiEvasion,
  autoBlendYolo,
  autoSendYolo,
  cbBackendEnabled,
  cbBackendUrlOverride,
  guardRoomEndpoint,
  guardRoomSyncKey,
  hasSeenWelcome,
  hzmDriveMode,
  lastSeenVersion,
  llmApiKey,
  normalSendYolo,
  sonioxApiKey,
} from '../lib/store'
import { shouldShowVersionUpdateBadge } from '../lib/version-update'

const SECTION_STYLE = {
  margin: '.5em 0',
  paddingBottom: '1em',
  borderBottom: '1px solid var(--Ga2, #eee)',
} as const

const HEADING_STYLE = {
  fontWeight: 'bold',
  marginBottom: '.5em',
} as const

const LINK_STYLE = {
  color: '#288bb8',
  textDecoration: 'none',
} as const

type ServiceStatus = 'always' | 'on' | 'off'

interface ExternalService {
  name: string
  host: string
  url?: string
  trigger: string
  description: string
  /**
   * Whether this service is currently active given the user's settings.
   * - `always` — used regardless of toggles (Bilibili APIs, mandatory CDNs)
   * - `on`     — opt-in feature is enabled
   * - `off`    — opt-in feature is disabled or unconfigured
   */
  status: () => ServiceStatus
}

const EXTERNAL_SERVICES: ExternalService[] = [
  {
    name: 'Bilibili 直播接口和 WebSocket',
    host: 'api.live.bilibili.com / 直播 WebSocket',
    trigger: '发送弹幕、自动跟车、读取房间信息和粉丝牌、巡检禁言/封禁、Chatterbox Chat 直连事件流时',
    description:
      '使用你浏览器当前的 B 站登录会话访问直播相关接口，并直连直播 WebSocket。用于发送弹幕、读取房间号 / 表情包 / 粉丝牌房间、巡检限制状态，发送后等 WS / DOM 回显以判断是否真的广播（影子屏蔽校验），以及为 Chatterbox Chat 提供弹幕 / 礼物 / 醒目留言 / 进场等事件源。',
    status: () => 'always',
  },
  {
    name: 'AI 弹幕审核',
    host: 'edge-workers.laplace.cn',
    trigger: '启用「AI 规避」功能时',
    description:
      '当弹幕发送失败或疑似被屏蔽且开启了 AI 规避功能后，脚本会将弹幕文本发送至此服务进行敏感词检测，并尝试自动改写后重新发送。',
    status: () => (aiEvasion.value ? 'on' : 'off'),
  },
  {
    name: '云端替换规则',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/replacement',
    trigger: '打开设置页时自动同步',
    description: '从云端获取由社区维护的弹幕敏感词替换规则，每 10 分钟自动同步一次；带数量与长度上限。',
    status: () => 'always',
  },
  {
    name: 'LAPLACE 烂梗列表',
    host: 'workers.vrp.moe',
    url: 'https://subspace.institute/docs/laplace-chatterbox/memes',
    trigger: '打开烂梗库时；或 chatterbox-cloud 后端不可用时降级直拉',
    description:
      '烂梗面板优先从 chatterbox-cloud 自建后端拉取聚合数据，后端不可用时降级到本地直拉 LAPLACE 烂梗列表。复制烂梗时会向服务报告使用次数。',
    status: () => 'always',
  },
  {
    name: 'chatterbox-cloud 自建后端',
    host: 'chatterbox-cloud.aijc-eric.workers.dev',
    url: 'https://github.com/aijc123/bilibili-live-wheel-auto-follow/tree/master/server',
    trigger: '打开烂梗库或向社区贡献候选梗时',
    description:
      '本仓库 server/ 自建后端，聚合 LAPLACE + SBHZM + 社区贡献的梗库。可在设置里通过 cbBackendUrlOverride 指向自有部署或本地 localhost 实例。',
    status: () => (cbBackendEnabled.value ? 'on' : 'off'),
  },
  {
    name: 'SBHZM 社区梗源',
    host: 'sbhzm.cn',
    trigger: '进入注册过的直播间（如灰泽满直播间）拉取烂梗时',
    description: '社区自建的房间专属烂梗源，提供该房间梗列表，可在设置里关闭或被 chatterbox-cloud 后端聚合代理。',
    status: () => 'always',
  },
  {
    name: '直播间保安室',
    host: 'bilibili-guard-room.vercel.app',
    trigger: '启用粉丝牌巡检同步、订阅控制 profile 或 live-desk 心跳时',
    description:
      '完全可选。开启后只同步巡检摘要、选定的影子屏蔽规则或 live-desk 心跳，不会上传 cookie、csrf、localStorage 或完整 B 站接口响应；HTTPS-only（loopback 除外）。也可由保安室通过 URL 查询参数接管直播页（如 dry-run 模式）。',
    status: () => (guardRoomEndpoint.value.trim() !== '' && guardRoomSyncKey.value.trim() !== '' ? 'on' : 'off'),
  },
  {
    name: 'LLM 智能辅助（AI 规避 / 改写 / 选梗）',
    host: 'api.anthropic.com / api.openai.com / 自填 OpenAI 兼容 base URL',
    trigger: '填入 API Key 并启用 AI 规避或智能辅助驾驶 LLM 选梗时',
    description:
      '默认关闭，必须自己填 API Key 才会调用。支持 Anthropic、OpenAI，以及任何 OpenAI 兼容自填 base URL（DeepSeek、Moonshot、OpenRouter、Ollama、小米 mimo 等）；自定义域走脚本管理器的 @connect 兜底，每个新域首次访问仍会单独弹窗确认。Prompt 内容仅包含当前要改写的弹幕或候选梗及必要上下文，不会带 cookie、csrf 或其他私人数据。',
    status: () => {
      if (llmApiKey.value.trim() === '') return 'off'
      const anyConsumer =
        normalSendYolo.value || autoBlendYolo.value || autoSendYolo.value || hzmDriveMode.value === 'llm'
      return anyConsumer ? 'on' : 'off'
    },
  },
  {
    name: '本地开发后端',
    host: 'localhost',
    trigger: '把 cbBackendUrlOverride 指向本地 chatterbox-cloud 实例时',
    description: '用于本地开发和自托管后端联调，仅在你主动配置后才生效。',
    status: () => (cbBackendUrlOverride.value.trim() !== '' ? 'on' : 'off'),
  },
  {
    name: 'Soniox 语音识别',
    host: 'api.soniox.com',
    url: 'https://soniox.com',
    trigger: '使用同传功能时',
    description: '通过 WebSocket 连接 Soniox 语音识别云服务，将麦克风音频流实时转换为文字。需要提供 Soniox API Key。',
    status: () => (sonioxApiKey.value.trim() !== '' ? 'on' : 'off'),
  },
  {
    name: 'Soniox SDK',
    host: 'unpkg.com',
    trigger: '使用同传功能时按需加载',
    description: '从 unpkg CDN 加载 Soniox 语音识别 SDK (@soniox/client)。',
    status: () => (sonioxApiKey.value.trim() !== '' ? 'on' : 'off'),
  },
]

function statusBadgeStyle(status: ServiceStatus): { background: string; color: string; label: string; title: string } {
  switch (status) {
    case 'always':
      return {
        background: 'rgba(0, 122, 255, .14)',
        color: '#0a64c2',
        label: '总会调用',
        title: '该服务在脚本运行时按需调用，与你的开关无关',
      }
    case 'on':
      return {
        background: 'rgba(48, 209, 88, .18)',
        color: 'var(--cb-success-text)',
        label: '已启用',
        title: '当前开关已打开，会按"触发条件"调用此服务',
      }
    case 'off':
      return {
        background: 'rgba(120, 120, 128, .18)',
        color: '#6e6e73',
        label: '未启用',
        title: '当前开关关闭或未配置；脚本不会调用此服务',
      }
  }
}

/**
 * 术语表：用 Greasy Fork 搜索 "Bilibili Live" 进来的非水友圈新用户，看到
 * "独轮车 / 跟车 / 智驾 / 烂梗库 / 影子屏蔽" 等会一头雾水。这张表把每个术语
 * 翻译成"一句话能 hold 住的事"，让用户看完就知道"哦原来是这个意思"。
 *
 * 内容遵守的原则：
 *  - 不超过一行——超过一行就不是术语表了，是文档。
 *  - 用普通话不用社群黑话（"循环刷"而不是"压麦"）。
 *  - 对应 UI 用同样的词（不要在术语表里写"独轮车"在 UI 里写"自动发送"）。
 */
const GLOSSARY_ITEMS: ReadonlyArray<readonly [string, string]> = [
  ['独轮车', '循环重复发送同一条/同一组自定义弹幕（最经典的"压"）'],
  ['自动跟车', '检测到公屏多人在刷同一句话时，自动跟一条'],
  ['智驾 / 智能辅助驾驶', '后台按节奏从烂梗库自动挑梗发送（启发式或 LLM 选）'],
  ['烂梗库', '梗模板库——聚合 LAPLACE + SBHZM + 自建后端 + 房间专属源'],
  ['影子屏蔽', 'B 站不告诉你弹幕被隐身屏蔽了；脚本发完会校验回显'],
  ['同传', '麦克风语音实时识别成文字推到发送框（Soniox）'],
  ['保安室', '自部署的同步后端，可选；同步巡检摘要、影子规则、心跳'],
  ['雷达', '跨直播间热梗探测（默认关；开启后向 chatterbox-cloud 上报）'],
  ['试运行 / dryRun', '只演练不真发——所有自动功能首次启用建议先试运行'],
  ['AI 润色（原 YOLO）', '发送前用 LLM 临时改写一遍再发——用你在「设置 → LLM 提示词」里写的 prompt（会消耗 token）'],
]

const LOCAL_DATA_ITEMS: string[] = [
  '弹幕模板、发送设置和自动跟车 / 智能辅助驾驶配置。',
  '云端 / 本地全局 / 当前房间替换规则。',
  'Chatterbox Chat 主题、自定义 CSS 和偏好。',
  '粉丝牌巡检缓存。',
  '影子屏蔽观察记录和候选改写。',
]

export function AboutTab() {
  const initialSeenRef = useRef(lastSeenVersion.value)
  const isFreshUpdate = shouldShowVersionUpdateBadge(initialSeenRef.current, VERSION)
  useEffect(() => {
    if (lastSeenVersion.value !== VERSION) {
      lastSeenVersion.value = VERSION
    }
  }, [])

  return (
    <>
      <div className='cb-section cb-stack' style={SECTION_STYLE}>
        <div className='cb-heading' style={HEADING_STYLE}>
          B站独轮车 + 自动跟车
        </div>
        <div className='cb-note' style={{ display: 'flex', flexDirection: 'column', gap: '.25em', color: '#666' }}>
          <span>
            版本: {VERSION}
            {isFreshUpdate && (
              <span
                style={{
                  marginLeft: '.5em',
                  padding: '1px 6px',
                  borderRadius: '999px',
                  background: '#ffe7c2',
                  color: 'var(--cb-warning-text)',
                  fontSize: '0.8em',
                }}
                title={`从 v${initialSeenRef.current} 更新到 v${VERSION}`}
              >
                🆕 已更新
              </span>
            )}
          </span>
          <span>作者: NougatDev</span>
          <span>许可证: AGPL-3.0</span>
          <span>
            源代码:{' '}
            <a
              href='https://github.com/aijc123/bilibili-live-wheel-auto-follow'
              target='_blank'
              rel='noopener'
              style={LINK_STYLE}
            >
              GitHub
            </a>
          </span>
          <span>
            原项目:{' '}
            <a href='https://github.com/laplace-live/chatterbox' target='_blank' rel='noopener' style={LINK_STYLE}>
              LAPLACE Chatterbox
            </a>
          </span>
          <span style={{ marginTop: '.5em' }}>
            <button
              type='button'
              className='cb-btn'
              onClick={() => {
                hasSeenWelcome.value = false
                activeTab.value = 'fasong'
              }}
              title='下次打开「发送」页签时会再次显示首次引导'
            >
              重新查看新手引导
            </button>
          </span>
        </div>
      </div>

      <div className='cb-section cb-stack' style={SECTION_STYLE}>
        <div className='cb-heading' style={HEADING_STYLE}>
          术语表
        </div>
        <div className='cb-note' style={{ color: '#666', marginBottom: '.5em' }}>
          脚本里用到的弹幕圈黑话。一句话解释。
        </div>
        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            columnGap: '.75em',
            rowGap: '.4em',
            margin: 0,
            fontSize: '.9em',
          }}
        >
          {GLOSSARY_ITEMS.map(([term, def]) => (
            <Fragment key={term}>
              <dt style={{ fontWeight: 'bold', color: '#1d1d1f', whiteSpace: 'nowrap' }}>{term}</dt>
              <dd style={{ margin: 0, color: '#555' }}>{def}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <div className='cb-section cb-stack' style={{ ...SECTION_STYLE, borderBottom: 'none' }}>
        <div className='cb-heading' style={HEADING_STYLE}>
          隐私说明
        </div>
        <div className='cb-note' style={{ color: '#666', marginBottom: '.75em' }}>
          大部分配置只保存在你的浏览器里，由脚本管理器本地存储；下面也列出脚本运行时可能与之通信的外部服务，请按需启用。
        </div>

        <div style={{ marginBottom: '1em' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '.25em', fontSize: '.95em' }}>本地保存的数据</div>
          <ul style={{ margin: 0, paddingLeft: '1.25em', fontSize: '.9em', color: '#555' }}>
            {LOCAL_DATA_ITEMS.map(item => (
              <li key={item} style={{ marginBottom: '.15em' }}>
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div style={{ fontWeight: 'bold', marginBottom: '.5em', fontSize: '.95em' }}>可能访问的外部服务</div>

        <div className='cb-list' style={{ display: 'flex', flexDirection: 'column', gap: '.75em' }}>
          {EXTERNAL_SERVICES.map(service => {
            const badge = statusBadgeStyle(service.status())
            return (
              <div
                key={service.name}
                className='cb-list-item'
                style={{
                  padding: '.5em',
                  borderRadius: '4px',
                  background: 'var(--Ga1_s, rgba(0,0,0,.03))',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '.5em',
                    flexWrap: 'wrap',
                    marginBottom: '.25em',
                  }}
                >
                  <div style={{ fontWeight: 'bold' }}>
                    {service.url ? (
                      <a href={service.url} target='_blank' rel='noopener' style={LINK_STYLE}>
                        {service.name}
                      </a>
                    ) : (
                      service.name
                    )}
                  </div>
                  <span
                    title={badge.title}
                    style={{
                      padding: '1px 8px',
                      borderRadius: '999px',
                      background: badge.background,
                      color: badge.color,
                      fontSize: '0.75em',
                      fontWeight: 650,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {badge.label}
                  </span>
                </div>
                <div style={{ fontSize: '.9em', color: '#666', fontFamily: 'monospace', marginBottom: '.25em' }}>
                  {service.host}
                </div>
                <div style={{ fontSize: '.9em', marginBottom: '.25em' }}>
                  <span style={{ color: 'var(--cb-success-text)' }}>触发条件:</span> {service.trigger}
                </div>
                <div style={{ fontSize: '.9em', color: '#555' }}>{service.description}</div>
              </div>
            )
          })}
        </div>

        <div className='cb-note' style={{ color: 'var(--cb-warning-text)', marginTop: '.75em', fontSize: '.85em' }}>
          反馈问题或截图时，请不要公开 cookie、csrf token、账号密钥、localStorage dump、私人房间规则或私有同步地址。
        </div>
      </div>
    </>
  )
}
