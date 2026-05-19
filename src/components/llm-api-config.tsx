import { useSignal } from '@preact/signals'

import { validateLlmBaseUrl } from '../lib/llm-base-url-validate'
import {
  clearLlmApiKey,
  type LlmProvider,
  llmApiKey,
  llmApiKeyPersist,
  llmBaseURL,
  llmModel,
  llmProvider,
} from '../lib/store-llm'

/**
 * 共享 LLM API 配置面板。
 *
 * 历史背景：这套 UI 原本嵌在「智能辅助驾驶」(`HzmDrivePanel`) 里。但 HZM 面板
 * 受 `meme-sources` 注册表 gate（目前只有灰泽满 1713546334 房间会渲染），导致
 * 别的房间用户开了三个 AI 润色（原代号 YOLO）开关却找不到地方填 API key。
 * 这次抽出来：
 *  - 设置 → LLM 永远显示这块（凭证集中管理）
 *  - HZM 面板不再内嵌 API 配置，只读地显示状态 + 跳设置链接
 *
 * 排版策略：**label 在上、input 100% 宽占下一行的"堆叠"模式**。
 *
 * 历史教训：原版用 `cb-row` flex 把 label + input + 状态文字 + 清除按钮 4 个
 * 元素挤到一行，在 320px 宽的弹幕助手面板里 input 会被压到 ~80px，连
 * placeholder 都看不全；"OpenAI 兼容" segment 按钮文字也会被压成两行。这次
 * 改为 medal-check 风格的 stacked layout——label 短行在上、input 全宽在下、
 * 辅助按钮（清除 / 测试）也独占一行——保证 320px 内每个控件可读、可点。
 */

const PROVIDER_LABEL: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  // "OpenAI 兼容"全称——配合下面 segment 的 minmax(94px) 列宽足够一行 fit，
  // 不会被压成 "OpenAI / 兼容" 那种破碎两行。
  'openai-compat': 'OpenAI 兼容',
}

const PROVIDER_TITLE: Record<LlmProvider, string> = {
  anthropic: 'Anthropic（推荐 claude-haiku-4-5-20251001）',
  openai: 'OpenAI（推荐 gpt-4o-mini）',
  'openai-compat': 'OpenAI 兼容（DeepSeek / Moonshot / OpenRouter / Ollama / 小米 mimo）',
}

/**
 * openai-compat 预设：一键填 base URL + 推荐 model。Jobs 式审计后的 #11——
 * UI 只露 3 个 provider 选项,5 个常见 OpenAI-compatible 后端做成 preset 按钮,
 * 用户点一下自动填两个字段,不用记 URL。能力不减(`openai-compat` 仍可手填任意
 * base URL),可见性压一半。
 *
 * URL 标准化策略:存盘的形式跟用户在文档里看到的形式一致(带 /v1 或不带),
 * 因为 `llm-driver` 内部会自动补全到 `/v1/chat/completions`(见
 * `llm-base-url-validate.ts`)。preset 按钮存的是"通常文档示例的最短形式"。
 */
interface OpenAICompatPreset {
  id: string
  label: string
  baseURL: string
  /** 该 provider 上的推荐模型——填进 llmModel input,用户仍可改。 */
  model: string
  /** hover title:简短描述这个 provider 是什么。 */
  hint: string
}
const OPENAI_COMPAT_PRESETS: readonly OpenAICompatPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    hint: 'DeepSeek（国内便宜、中文好；deepseek-chat 是 V3 模型别名）',
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseURL: 'https://api.moonshot.cn',
    model: 'moonshot-v1-8k',
    hint: 'Moonshot Kimi（国内、长上下文；8k 足够单条弹幕改写）',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api',
    model: 'meta-llama/llama-3.2-3b-instruct:free',
    hint: 'OpenRouter（一个 key 路由到任意模型；这里默认填免费的 Llama 3.2 3B,你可以换）',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseURL: 'http://localhost:11434',
    model: 'llama3.2',
    hint: 'Ollama 本地模型（先在本机 ollama pull llama3.2；@connect localhost 自动满足）',
  },
  {
    id: 'mimo',
    label: '小米 mimo',
    baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
    model: '',
    hint: '小米 mimo（你需要从内部渠道拿到 model 名）',
  },
] as const

/**
 * 把 base URL 归一化用于"哪个 preset 当前匹配"对比。两端做最小程度的清洗:
 * - 删除 trailing `/`
 * - 删除 trailing `/v1`(用户文档里可能带或不带)
 * - lowercase scheme/host(`localhost` vs `LOCALHOST`)
 *
 * 这只用于 UI 高亮 active preset,不会改变 GM 存储的实际值。
 */
function normalizePresetUrl(url: string): string {
  try {
    const trimmed = url.trim()
    if (!trimmed) return ''
    const parsed = new URL(trimmed)
    let pathname = parsed.pathname.replace(/\/+$/, '')
    if (pathname.endsWith('/v1')) pathname = pathname.slice(0, -3)
    return `${parsed.protocol}//${parsed.host}${pathname}`.toLowerCase()
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, '').replace(/\/v1$/, '')
  }
}

/** 把 API key 显示成 `sk-1234…abcd` 这种半遮罩形态。 */
function maskKey(k: string): string {
  const trimmed = k.trim()
  if (trimmed.length <= 8) return trimmed ? `${trimmed[0]}***${trimmed.at(-1)}` : ''
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`
}

function modeButtonStyle(active: boolean) {
  return {
    fontWeight: active ? ('bold' as const) : undefined,
  }
}

const FIELD_LABEL_STYLE = { fontSize: '11px', fontWeight: 600, color: '#1d1d1f' }
const FIELD_HINT_STYLE = { fontSize: '11px', color: '#6e6e73' }
const STACK_STYLE = { display: 'grid', gap: '4px' }

export interface LlmApiConfigPanelProps {
  /**
   * 隐藏"测试连接"按钮——HZM 面板原本就没暴露这个功能；保留这里只是让设置面板
   * 用一份相同 UI 即可。`true` 默认显示。
   */
  showTestConnection?: boolean
}

export function LlmApiConfigPanel({ showTestConnection = true }: LlmApiConfigPanelProps) {
  const testStatus = useSignal<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const testError = useSignal<string>('')

  const apiKeyConfigured = llmApiKey.value.trim().length > 0

  const handleTestLLM = async () => {
    if (testStatus.value === 'testing') return
    testStatus.value = 'testing'
    testError.value = ''
    try {
      const { testLLMConnection } = await import('../lib/llm-driver')
      const r = await testLLMConnection({
        provider: llmProvider.value,
        apiKey: llmApiKey.value,
        model: llmModel.value,
        baseURL: llmBaseURL.value.trim() || undefined,
      })
      if (r.ok) {
        testStatus.value = 'ok'
      } else {
        testStatus.value = 'fail'
        testError.value = r.error ?? '未知错误'
      }
    } catch (err) {
      testStatus.value = 'fail'
      testError.value = err instanceof Error ? err.message : String(err)
    }
  }

  const inputStyle = { boxSizing: 'border-box' as const, width: '100%' }

  return (
    <div className='cb-stack' style={{ margin: '.5em 0', gap: '10px' }}>
      {/* Provider —— segment 用 grid auto-fit minmax 自适应；窄宽不会把
          单个按钮文字压成两行，而是整体换行。 */}
      <div style={STACK_STYLE}>
        <span style={FIELD_LABEL_STYLE}>Provider</span>
        <div
          className='cb-segment'
          style={{
            // 关键：用 minmax 让按钮可换行成多行，但单个按钮文字不会被压成两行。
            // 94px 阈值挑得在 320px 弹幕助手面板里稳定 wrap 成 2+1 布局（多占
            // 30px 高度），保证"OpenAI 兼容"全文一行可读——尝试过 80/88px 单行
            // 三按钮，但 "OpenAI 兼容" 会被等分宽度（~88px）压成 "OpenAI 兼"+"容"
            // 两行；"含义清晰" 胜过 "紧凑"。
            gridTemplateColumns: 'repeat(auto-fit, minmax(94px, 1fr))',
            gridAutoFlow: 'row',
          }}
        >
          {(['anthropic', 'openai', 'openai-compat'] as const).map(p => (
            <button
              key={p}
              type='button'
              aria-pressed={llmProvider.value === p}
              style={modeButtonStyle(llmProvider.value === p)}
              title={PROVIDER_TITLE[p]}
              onClick={() => {
                llmProvider.value = p
                testStatus.value = 'idle'
              }}
            >
              {PROVIDER_LABEL[p]}
            </button>
          ))}
        </div>
      </div>

      {/* API Key —— input 单独占满一行；状态/清除做成下方 helper row。
          这样窄面板下密码框还能容纳 30+ 字符，不会被挤成 80px。 */}
      <div style={STACK_STYLE}>
        <span style={FIELD_LABEL_STYLE}>API Key</span>
        <input
          type='password'
          value={llmApiKey.value}
          onInput={e => {
            llmApiKey.value = e.currentTarget.value
            testStatus.value = 'idle'
          }}
          placeholder='sk-... 或 anthropic key'
          style={inputStyle}
          autocomplete='off'
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={FIELD_HINT_STYLE}>{apiKeyConfigured ? `已配置：${maskKey(llmApiKey.value)}` : '未配置'}</span>
          <button
            type='button'
            disabled={!apiKeyConfigured}
            onClick={() => {
              clearLlmApiKey()
              testStatus.value = 'idle'
            }}
            style={{ marginLeft: 'auto', fontSize: '11px' }}
            title='把 key 从内存和 GM 存储里都抹掉'
          >
            清除
          </button>
        </div>
        <label
          htmlFor='llmApiKeyPersist'
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', ...FIELD_HINT_STYLE, cursor: 'pointer' }}
        >
          <input
            id='llmApiKeyPersist'
            type='checkbox'
            checked={llmApiKeyPersist.value}
            onInput={e => {
              llmApiKeyPersist.value = e.currentTarget.checked
            }}
          />
          <span title='不勾：key 仅留在内存，刷新页面就清空，GM 存储里的旧值也立即抹掉'>
            保存到 GM 存储（关闭后仅本次会话有效）
          </span>
        </label>
      </div>

      <div style={STACK_STYLE}>
        <span style={FIELD_LABEL_STYLE}>模型</span>
        <input
          type='text'
          value={llmModel.value}
          onInput={e => {
            llmModel.value = e.currentTarget.value
            testStatus.value = 'idle'
          }}
          placeholder='例：claude-haiku-4-5-20251001'
          title='Anthropic 推荐 claude-haiku-4-5-20251001；OpenAI 推荐 gpt-4o-mini；DeepSeek 用 deepseek-chat'
          style={inputStyle}
        />
      </div>

      {llmProvider.value === 'openai-compat' && (
        <div style={STACK_STYLE}>
          {/*
            预设按钮:5 个常见 OpenAI 兼容后端,点一下自动填 base URL + 推荐模型。
            highlight 当前匹配的 preset(归一化后比 baseURL),让用户知道自己处于
            哪个"位置"。任何 preset 没匹配 = 用户自己填的自定义 base URL,所有
            按钮都不高亮——这本身也是信号。
           */}
          <span style={FIELD_LABEL_STYLE}>预设（一键填 base URL + 推荐模型）</span>
          <div
            className='cb-segment'
            style={{
              // 5 个 preset 在 320px 面板里大约能挤 2 行(3+2 或 2+2+1),挑 70px
              // minmax 让"OpenRouter"、"小米 mimo" 不被压字。
              gridTemplateColumns: 'repeat(auto-fit, minmax(70px, 1fr))',
              gridAutoFlow: 'row',
            }}
          >
            {OPENAI_COMPAT_PRESETS.map(preset => {
              const isActive = normalizePresetUrl(llmBaseURL.value) === normalizePresetUrl(preset.baseURL)
              return (
                <button
                  key={preset.id}
                  type='button'
                  aria-pressed={isActive}
                  style={modeButtonStyle(isActive)}
                  title={preset.hint}
                  onClick={() => {
                    // 一键填两个字段;model 已有非空值时不覆盖(避免用户精调过模型名又被
                    // preset 一键清掉)。preset.model 为空的也跳过。
                    llmBaseURL.value = preset.baseURL
                    if (preset.model && !llmModel.value.trim()) {
                      llmModel.value = preset.model
                    }
                    testStatus.value = 'idle'
                  }}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <span style={FIELD_LABEL_STYLE}>Base URL</span>
          <input
            type='url'
            value={llmBaseURL.value}
            onInput={e => {
              llmBaseURL.value = e.currentTarget.value
              testStatus.value = 'idle'
            }}
            placeholder='https://api.deepseek.com'
            title='点上面的预设按钮一键填,或手动输入任意 OpenAI 兼容 base URL。'
            style={inputStyle}
          />
          <span style={FIELD_HINT_STYLE}>带不带 /v1 都行，自动补全到 /v1/chat/completions。</span>
          {(() => {
            const v = llmBaseURL.value.trim()
            if (v === '') return null
            const result = validateLlmBaseUrl(v)
            if (!result) return null
            const isError = result.severity === 'error'
            return (
              <span
                role='status'
                aria-live='polite'
                style={{
                  color: isError ? 'var(--cb-danger-text)' : 'var(--cb-warning-text)',
                  fontSize: '11px',
                  fontWeight: isError ? 600 : 500,
                  lineHeight: 1.4,
                  display: 'block',
                }}
              >
                ⚠️ {result.message}
              </span>
            )
          })()}
        </div>
      )}

      {showTestConnection && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <button
            type='button'
            disabled={!apiKeyConfigured || testStatus.value === 'testing'}
            // skipcq: JS-0098 — `void` discards the floating Promise from the async handler so the click stays sync-typed for React.
            onClick={() => void handleTestLLM()}
            title='发一个最小请求验证 key/路由能跑通；不消耗你的实际配额'
          >
            {testStatus.value === 'testing' ? '测试中…' : '测试连接'}
          </button>
          {testStatus.value === 'ok' && (
            <span className='cb-soft' style={{ color: 'var(--cb-success-text)' }}>
              连接成功
            </span>
          )}
          {testStatus.value === 'fail' && (
            <span style={{ color: '#c00', fontSize: '11px', wordBreak: 'break-all', flex: '1 1 100%' }}>
              连接失败：{testError.value}
            </span>
          )}
        </div>
      )}

      {/* 安全提示分两条：明文落盘的风险条只在 persist + 已配置 key 时显示得显眼，
          其它情况退回浅色 helper hint。Tampermonkey 的 @connect 提示永远显示，
          因为它跟域名授权流程有关，跟 key 是否落盘无关。 */}
      {llmApiKeyPersist.value && apiKeyConfigured ? (
        <div
          role='status'
          aria-live='polite'
          style={{
            color: 'var(--cb-danger-text)',
            background: 'rgba(176,0,32,.08)',
            border: '1px solid rgba(176,0,32,.25)',
            padding: '6px 8px',
            borderRadius: '4px',
            fontSize: '12px',
            fontWeight: 600,
            lineHeight: 1.45,
          }}
        >
          ⚠️ Key 已明文存进浏览器 GM 存储。共用电脑、浏览器同步、其他扩展、备份导出
          都能直接读到。担心泄漏：上面取消勾选「保存到 GM 存储」改为仅本会话。
        </div>
      ) : (
        <div className='cb-note' style={{ color: 'var(--cb-warning-text)' }}>
          {llmApiKeyPersist.value
            ? '提示：填入 key 后会明文存进 GM 存储。关掉「保存到 GM 存储」可改为仅本会话。'
            : 'Key 仅留在内存，刷新页面后清空。'}
        </div>
      )}
      <div className='cb-note' style={{ color: 'var(--cb-warning-text)' }}>
        openai-compat 自定义域首次调用时 Tampermonkey 会弹权限确认，需手动允许。
      </div>
    </div>
  )
}

/**
 * 紧凑摘要：用在已经显示了配置面板的别处（例如 HZM 面板）作为状态指示，
 * 不重复一份完整 UI。点 anchor 跳转到设置面板。
 */
export function LlmApiConfigSummary({ onJumpToSettings }: { onJumpToSettings?: () => void }) {
  const apiKeyConfigured = llmApiKey.value.trim().length > 0
  const baseLabel = llmProvider.value === 'openai-compat' ? llmBaseURL.value.trim() || '未填 base URL' : ''
  return (
    <div className='cb-panel' style={{ display: 'grid', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' }}>
        <strong>LLM</strong>
        {apiKeyConfigured ? (
          <span className='cb-soft' style={{ color: 'var(--cb-success-text)' }}>
            已配置
          </span>
        ) : (
          <span style={{ color: '#c00' }}>未配置</span>
        )}
        {onJumpToSettings && (
          <button
            type='button'
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              padding: 0,
              color: 'var(--cb-accent)',
              cursor: 'pointer',
              fontSize: '11px',
            }}
            onClick={onJumpToSettings}
          >
            在设置中配置 →
          </button>
        )}
      </div>
      {apiKeyConfigured && (
        <div className='cb-soft' style={{ wordBreak: 'break-all', fontSize: '11px' }}>
          {PROVIDER_TITLE[llmProvider.value].split('（')[0]} · {maskKey(llmApiKey.value)} ·{' '}
          {llmModel.value || '未填模型'}
          {baseLabel && ` · ${baseLabel}`}
        </div>
      )}
    </div>
  )
}
