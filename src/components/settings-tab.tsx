import { debugLogVisible, maxLogLines } from '../lib/log'
import {
  llmActivePromptAutoBlend,
  llmActivePromptAutoSend,
  llmActivePromptGlobal,
  llmActivePromptNormalSend,
  llmPromptsAutoBlend,
  llmPromptsAutoSend,
  llmPromptsGlobal,
  llmPromptsNormalSend,
} from '../lib/store-llm'
import { settingsAdvancedVisible } from '../lib/store-ui'
import { EmoteIds } from './emote-ids'
import { LlmApiConfigPanel } from './llm-api-config'
import { PromptManager } from './prompt-manager'
import { BackupSection } from './settings/backup-section'
import { CbBackendSection } from './settings/cb-backend-section'
import { ChatfilterSection } from './settings/chatfilter-section'
import { CustomChatSection } from './settings/custom-chat-section'
import { DanmakuDirectSection } from './settings/danmaku-direct-section'
import { LayoutSection } from './settings/layout-section'
import { MedalCheckSection } from './settings/medal-check-section'
import { RadarSection } from './settings/radar-section'
import { matchesSearchQuery } from './settings/search'

function GroupHeading({ children, query }: { children: string; query: string }) {
  if (query) return null
  return (
    <div
      className='cb-group-heading'
      style={{
        margin: '1em 0 .25em',
        fontSize: '0.75em',
        fontWeight: 'bold',
        color: '#999',
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  )
}

/**
 * 设置 Tab。
 *
 * 设计：默认只露 5 个**常用** section（Chatterbox Chat / +1 直接动作 / 布局 /
 * 表情 / 备份），其余 11+ 个 section 折在"显示高级设置"开关后面。这把 151+ 个
 * 持久化项的首屏认知量从"压垮"降到"可消化"。
 *
 * **重要例外**：搜索框有关键词时，所有 section 都参与匹配，无视高级开关 ——
 * 否则用户搜索"粉丝牌"会因为"工具"组被高级开关隐藏而搜不到东西，违反搜索
 * 的直觉。
 */
export function SettingsTab() {
  const showAdvanced = settingsAdvancedVisible.value

  // Jobs 式 #10: 搜索框已删除——"需要搜索"本身就是设置过多的征兆。
  // 替换规则的 5 个 section 已经在 #7 砍掉,剩下的设置走"5 常用 + 10 高级"
  // 两级分类,通过 GroupHeading 锚定语义,通过<details>折叠减压。空 query
  // 一律命中(`matchesSearchQuery` 早返 true),所有 section 接受 query=''
  // 默认值。子 section 内部仍保留 KEYWORDS 常量是 forward-compat:若未来
  // 重新引入搜索,只需在这里挂一个输入框就够。
  const query = ''

  return (
    <>
      <GroupHeading query={query}>常用</GroupHeading>
      <CustomChatSection query={query} />
      <DanmakuDirectSection query={query} />
      <LayoutSection query={query} />
      {matchesSearchQuery('表情 emote emoji 表情包 ID 复制 表情ID 表情ids', query) && (
        <details className='cb-settings-accordion' open>
          <summary>表情</summary>
          <div
            className='cb-section cb-stack'
            style={{ margin: '.5em 0', paddingBottom: '1em', borderBottom: '1px solid var(--Ga2, #eee)' }}
          >
            <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
              表情（复制后可在独轮车或手动发送中直接发送）
            </div>
            <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
              <EmoteIds />
            </div>
          </div>
        </details>
      )}
      <BackupSection query={query} />

      {/*
       * 高级设置：默认折叠。命名上叫"高级"是因为这些 section 用户少则一辈子
       * 不动，多则上线初期调一次。把它们藏起来不影响日常使用。
       *
       * 这两个 toggle 按钮特意做成低视觉权重——它们是导航元素而不是主操作，
       * 不该和"开车 / 停车"那种主 CTA 平级。borderless、淡灰、左对齐，文本
       * 链接的观感。
       */}
      {!showAdvanced && (
        <div style={{ margin: '1.25em 0 .5em' }}>
          <button
            type='button'
            className='cb-disclosure-link'
            onClick={() => {
              settingsAdvancedVisible.value = true
            }}
            aria-expanded={false}
            aria-controls='cb-advanced-settings'
          >
            ▸ 显示高级设置（LLM / 粉丝牌巡检 / 雷达 / 日志…）
          </button>
          <div className='cb-note' style={{ color: '#999', fontSize: '0.8em', marginTop: '.25em' }}>
            常用 5 项已展开；剩下大多数用户不需要碰。
          </div>
        </div>
      )}

      {showAdvanced && (
        <div id='cb-advanced-settings'>
          <div style={{ margin: '1.25em 0 .5em' }}>
            <button
              type='button'
              className='cb-disclosure-link'
              onClick={() => {
                settingsAdvancedVisible.value = false
              }}
              aria-expanded={true}
              aria-controls='cb-advanced-settings'
            >
              ▾ 收起高级设置
            </button>
          </div>

          <GroupHeading query={query}>智能识别</GroupHeading>
          <ChatfilterSection query={query} />

          {/*
           * 「替换规则」section 组已删除(2026 Jobs 式审计):云端规则、本地全局
           * 规则、本地房间规则、影子屏蔽观察列表 5 个 section 全部从设置面板移除。
           * 用户从来不应该思考"规则有几层、我在哪一层加"——这是数据库设计师的
           * 心智,不是用户的心智。
           *
           * 后台机制全部保留:
           *  - 云端规则继续由 `cloud-replacement-sync.ts` 每 10 分钟拉一次
           *    (boot 阶段就启动,与 UI 解耦)。
           *  - 本地全局/本地房间规则:已有的 GM 持久值仍然被 `replacement.ts`
           *    读取并应用,但不再有添加/删除入口。
           *  - 影子屏蔽自动学习:`shadow-learn.ts` 继续运行;候选改写气泡仍
           *    通过 `<ShadowBypassChip>` 出现在「手动发送」输入框旁边。
           *  - hidden GM 键 `disableCloudReplacement` 留给少数派用户(Apple
           *    'hidden defaults' 风格,不在 UI 上暴露)。
           */}

          <GroupHeading query={query}>
            LLM（智驾选梗 + AI 润色共用）·「AI 润色」= LLM 在你发出去之前用你写的 prompt 重写一遍（原代号 YOLO）
          </GroupHeading>
          <LlmApiSection query={query} />
          <LlmPromptsSection query={query} />

          {/* 工具组：把粉丝牌巡检放在最前面（最常用），其它按使用频率次序。 */}
          <GroupHeading query={query}>工具</GroupHeading>
          <MedalCheckSection query={query} />
          <CbBackendSection query={query} />
          <RadarSection query={query} />

          <GroupHeading query={query}>系统 · 日志</GroupHeading>
          {matchesSearchQuery('日志设置 日志 行数 调试 debug log lines', query) && (
            <details className='cb-settings-accordion'>
              <summary>日志设置</summary>
              <div className='cb-section cb-stack' style={{ margin: '.5em 0', paddingBottom: '1em' }}>
                <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
                  日志设置
                </div>
                <div
                  className='cb-row'
                  style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <label htmlFor='maxLogLines' style={{ color: '#666' }}>
                    最大日志行数:
                  </label>
                  <input
                    id='maxLogLines'
                    type='number'
                    min='1'
                    max='1000'
                    style={{ width: '80px' }}
                    value={maxLogLines.value}
                    onChange={e => {
                      let v = Number.parseInt(e.currentTarget.value, 10)
                      if (Number.isNaN(v) || v < 1) v = 1
                      else if (v > 1000) v = 1000
                      maxLogLines.value = v
                    }}
                  />
                  <span style={{ color: '#999', fontSize: '0.9em' }}>(1-1000)</span>
                </div>
                <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.4em' }}>
                  <input
                    id='debugLogVisible'
                    type='checkbox'
                    checked={debugLogVisible.value}
                    onInput={e => {
                      debugLogVisible.value = e.currentTarget.checked
                    }}
                  />
                  <label
                    htmlFor='debugLogVisible'
                    title='打开后内部诊断日志会带上 🔍 前缀，便于打包成完整日志反馈给维护者。正常使用不需要打开。'
                  >
                    调试模式（在日志中标注内部诊断行）
                  </label>
                </span>
                <div className='cb-note' style={{ color: '#666' }}>
                  收到「请发完整日志」类的反馈请求时打开此开关，再复制日志面板内容提交。
                </div>
              </div>
            </details>
          )}
        </div>
      )}
    </>
  )
}

/**
 * LLM API 凭证（provider / key / model / baseURL）。
 *
 * 这个 section 必须在所有房间都可见——之前 LLM 凭证嵌在「智能辅助驾驶」面板里，
 * 而 HZM 面板只对注册了梗源的房间渲染（目前仅灰泽满），导致别的房间用户开了三个
 * 发送路径的 AI 润色却找不到地方填 API key。把它搬到设置里、永远可见。
 *
 * 同一份 signal 既给智能辅助驾驶选梗用，也给三处 AI 润色（自动跟车 / 独轮车 / 手动
 * 发送）用——配置一次两用。
 */
function LlmApiSection({ query }: { query: string }) {
  // KEYWORDS 同时收录新旧术语（AI 润色 + YOLO + 常规发送 + 手动发送），保证旧用户
  // 用旧词搜索仍能找到这一节。
  const KEYWORDS =
    'llm api key model 模型 anthropic openai deepseek moonshot openrouter ollama 智能辅助驾驶 智驾 ai 润色 yolo 改写 base url 凭证 token 选梗'
  if (!matchesSearchQuery(KEYWORDS, query)) return null
  return (
    <details className='cb-settings-accordion' open>
      <summary>LLM API 配置（智驾选梗 + AI 润色共用）</summary>
      <div className='cb-section cb-stack' style={{ margin: '.5em 0', paddingBottom: '1em', gap: '.75em' }}>
        <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
          填一次，「智能辅助驾驶」选梗 与「自动跟车 / 独轮车 / 手动发送」的 AI 润色都能用。
        </div>
        <div
          className='cb-note'
          style={{
            color: '#6e6e73',
            fontSize: '0.8em',
            lineHeight: 1.5,
            background: 'rgba(118,118,128,.1)',
            padding: '.4em .55em',
            borderRadius: '6px',
          }}
        >
          <strong>名词解释 ·「AI 润色」</strong>（原代号 YOLO）—— 发出去之前先让 LLM 按你写的提示词
          重写一遍弹幕。代价：每条弹幕都会调用一次大模型 API，产生 token 消耗；好处：可以套 你写的提示词（卖萌 / 化身
          VTuber / 避敏感词等）。关闭后弹幕原样发出。提示词在下面 的「LLM 提示词」section 里管理。
        </div>
        <LlmApiConfigPanel showTestConnection />
      </div>
    </details>
  )
}

/**
 * LLM 提示词管理（AI 润色用）。
 *
 * 全局基线 + 三个功能特定的 PromptManager。getActiveLlmPrompt 在调用时会把
 * 全局拼到功能前面（详见 `src/lib/prompts.ts`）。
 * 设计参考自 upstream chatterbox 0c8706f / 090bd1e。
 */
function LlmPromptsSection({ query }: { query: string }) {
  // 收录新旧术语，保证旧用户用「yolo」「常规发送」搜索仍能找到这里。
  const KEYWORDS =
    'llm 提示词 prompt ai 润色 yolo 改写 openai anthropic 全局基线 手动发送 常规发送 自动跟车 独轮车 system prompt'
  if (!matchesSearchQuery(KEYWORDS, query)) return null
  return (
    <details className='cb-settings-accordion'>
      <summary>LLM 提示词（AI 润色用）</summary>
      <div className='cb-section cb-stack' style={{ margin: '.5em 0', paddingBottom: '1em', gap: '.75em' }}>
        <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
          这里只管理 AI 润色用的提示词。API 凭证（key / 模型 / base URL）在上面的「LLM API 配置」section 里填一次。
        </div>

        <div>
          <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.25em' }}>
            全局基线
          </div>
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', marginBottom: '.4em' }}>
            会作为通用前缀拼到下面三个功能特定提示词的前面（用 ↓ 双换行 + "以下是用户的修改提示" 分隔）。
          </div>
          <PromptManager
            prompts={llmPromptsGlobal.value}
            activeIndex={llmActivePromptGlobal.value}
            onPromptsChange={p => {
              llmPromptsGlobal.value = p
            }}
            onActiveIndexChange={i => {
              llmActivePromptGlobal.value = i
            }}
            placeholder='全局基线，例如：你是直播间弹幕优化助手，结尾不带句号，单条 ≤40 字…'
          />
        </div>

        <div>
          <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.25em' }}>
            手动发送
          </div>
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', marginBottom: '.4em' }}>
            手动输入框 / 偷 / +1 等手动发送场景的修改提示。空 = 跳过 LLM。
          </div>
          <PromptManager
            prompts={llmPromptsNormalSend.value}
            activeIndex={llmActivePromptNormalSend.value}
            onPromptsChange={p => {
              llmPromptsNormalSend.value = p
            }}
            onActiveIndexChange={i => {
              llmActivePromptNormalSend.value = i
            }}
            placeholder='例如：把我输入的话改写成更礼貌的中文弹幕'
          />
        </div>

        <div>
          <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.25em' }}>
            自动跟车
          </div>
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', marginBottom: '.4em' }}>
            触发跟车后，把命中的弹幕用 LLM 润色一遍再发的修改提示。
          </div>
          <PromptManager
            prompts={llmPromptsAutoBlend.value}
            activeIndex={llmActivePromptAutoBlend.value}
            onPromptsChange={p => {
              llmPromptsAutoBlend.value = p
            }}
            onActiveIndexChange={i => {
              llmActivePromptAutoBlend.value = i
            }}
            placeholder='例如：把要跟的弹幕换个说法但保留意思，更像观众随口说出来的'
          />
        </div>

        <div>
          <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.25em' }}>
            独轮车
          </div>
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', marginBottom: '.4em' }}>
            循环里每条非表情消息发送前用 LLM 润色的修改提示。配置不全会自动停车。
          </div>
          <PromptManager
            prompts={llmPromptsAutoSend.value}
            activeIndex={llmActivePromptAutoSend.value}
            onPromptsChange={p => {
              llmPromptsAutoSend.value = p
            }}
            onActiveIndexChange={i => {
              llmActivePromptAutoSend.value = i
            }}
            placeholder='例如：把模板里的话改成有梗的中文弹幕，每次表达不重复'
          />
        </div>
      </div>
    </details>
  )
}
