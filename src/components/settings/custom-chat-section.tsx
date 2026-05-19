import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { CUSTOM_CHAT_CSS_MAX_LENGTH, sanitizeCustomChatCss } from '../../lib/custom-chat-css-sanitize'
import { MIDNIGHT_INDIGO_IMESSAGE_CSS, MILK_GREEN_IMESSAGE_CSS } from '../../lib/custom-chat-presets'
import {
  customChatCss,
  customChatEnabled,
  customChatFoldMode,
  customChatHideNative,
  customChatPerfDebug,
  customChatTheme,
  customChatUseWs,
} from '../../lib/store'
import { showConfirm } from '../ui/alert-dialog'
import { matchesSearchQuery } from './search'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} 字符`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export function CustomChatSection({ query = '' }: { query?: string }) {
  const cssDraft = useSignal(customChatCss.value)
  const cssStatus = useSignal<'saved' | 'pending'>('saved')

  useEffect(() => {
    const draft = cssDraft.value
    if (draft === customChatCss.value) {
      cssStatus.value = 'saved'
      return undefined
    }
    cssStatus.value = 'pending'
    const timer = setTimeout(() => {
      customChatCss.value = draft
      cssStatus.value = 'saved'
    }, 400)
    return () => clearTimeout(timer)
  }, [cssDraft.value])

  if (
    !matchesSearchQuery(
      'Chatterbox Chat 评论区 WS DOM 主题 theme iMessage Compact bubble 浅色 深色 dark light CSS 自定义样式 去重 折叠 合并 重复 独轮车 防刷屏 ×N gift sc 礼物 同传',
      query
    )
  )
    return null

  return (
    <details className='cb-settings-accordion' open>
      <summary className='cb-module-summary'>
        <span className='cb-accordion-title'>Chatterbox Chat</span>
        <span className='cb-module-state' data-active={customChatEnabled.value ? 'true' : 'false'}>
          {customChatEnabled.value ? '接管' : '关闭'}
        </span>
      </summary>
      <div
        className='cb-section cb-stack'
        style={{ margin: '.5em 0', paddingBottom: '1em', borderBottom: '1px solid var(--Ga2, #eee)' }}
      >
        <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          Chatterbox Chat
        </div>
        <div className='cb-setting-block cb-setting-primary'>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='customChatEnabled'
              type='checkbox'
              checked={customChatEnabled.value}
              onInput={e => {
                customChatEnabled.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='customChatEnabled'>接管 B 站聊天区（Chatterbox Chat）</label>
          </span>
        </div>
        <div
          className='cb-setting-block cb-dependent-group'
          data-enabled={customChatEnabled.value ? 'true' : 'false'}
          data-reason='先开启 Chatterbox Chat'
        >
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='customChatHideNative'
              type='checkbox'
              checked={customChatHideNative.value}
              disabled={!customChatEnabled.value}
              onInput={e => {
                customChatHideNative.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='customChatHideNative' style={{ color: customChatEnabled.value ? undefined : '#999' }}>
              隐藏 B 站原评论列表和原发送框
            </label>
          </span>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='customChatUseWs'
              type='checkbox'
              checked={customChatUseWs.value}
              disabled={!customChatEnabled.value}
              onInput={e => {
                customChatUseWs.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='customChatUseWs' style={{ color: customChatEnabled.value ? undefined : '#999' }}>
              直连 WebSocket 获取礼物、醒目留言、进场等事件（DOM 兜底）
            </label>
          </span>
          <div className='cb-row cb-setting-row'>
            <label htmlFor='customChatTheme'>评论区主题</label>
            <select
              id='customChatTheme'
              value={customChatTheme.value}
              disabled={!customChatEnabled.value}
              onChange={e => {
                customChatTheme.value = e.currentTarget.value as typeof customChatTheme.value
              }}
            >
              <option value='laplace'>iMessage Dark</option>
              <option value='light'>iMessage Light</option>
              <option value='compact'>Compact Bubble</option>
            </select>
          </div>
          <details className='cb-subdetails'>
            <summary>自定义评论区 CSS</summary>
            <div className='cb-body cb-stack'>
              <div className='cb-row'>
                <button
                  type='button'
                  disabled={!customChatEnabled.value}
                  onClick={() => {
                    cssDraft.value = MILK_GREEN_IMESSAGE_CSS
                  }}
                >
                  奶绿 iMessage
                </button>
                <button
                  type='button'
                  disabled={!customChatEnabled.value}
                  onClick={() => {
                    cssDraft.value = MIDNIGHT_INDIGO_IMESSAGE_CSS
                  }}
                  title='深夜直播 / 二次元房间适用:深色基底 + 高对比 SC + 渐变 guard'
                >
                  午夜深蓝 iMessage
                </button>
                <button
                  type='button'
                  disabled={!customChatEnabled.value || !cssDraft.value.trim()}
                  onClick={() => {
                    const draftSize = cssDraft.value.length
                    if (draftSize === 0) return
                    void showConfirm({
                      title: '清空自定义 CSS？',
                      body: `这会删除当前 ${draftSize} 字符的自定义 CSS（包含奶绿 iMessage 预设等）。删除后无法撤销。继续吗？`,
                      confirmText: '清空',
                      cancelText: '取消',
                    }).then(ok => {
                      if (ok) cssDraft.value = ''
                    })
                  }}
                >
                  清空 CSS
                </button>
              </div>
              <textarea
                value={cssDraft.value}
                disabled={!customChatEnabled.value}
                onInput={e => {
                  cssDraft.value = e.currentTarget.value
                }}
                placeholder={'#laplace-custom-chat .lc-chat-message { ... }'}
                style={{ minHeight: '90px', resize: 'vertical', width: '100%' }}
              />
              <div className='cb-note' style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>
                  可覆盖 #laplace-custom-chat 的 --lc-chat-* 变量，以及
                  .lc-chat-bubble、.lc-chat-medal、.lc-chat-name、.lc-chat-action、.lc-chat-card-event、[data-kind]、[data-card]、[data-guard]
                  等选择器。
                </span>
                <span
                  style={{
                    flexShrink: 0,
                    marginLeft: '8px',
                    color: cssStatus.value === 'pending' ? '#ff9500' : '#34c759',
                  }}
                >
                  {cssStatus.value === 'pending' ? '有待保存更改' : '已保存'}
                </span>
              </div>
              {(() => {
                const draft = cssDraft.value
                if (!draft.trim()) return null
                const r = sanitizeCustomChatCss(draft)
                const issues: string[] = []
                if (r.truncated) {
                  issues.push(
                    `已截断到 ${formatBytes(CUSTOM_CHAT_CSS_MAX_LENGTH)}（原文 ${formatBytes(r.originalLength)}）`
                  )
                }
                if (r.removedImports > 0) issues.push(`剔除 ${r.removedImports} 条 @import`)
                if (r.removedUrlSchemes > 0) issues.push(`中和 ${r.removedUrlSchemes} 条不安全 url()`)
                if (r.removedLegacyHooks > 0) issues.push(`移除 ${r.removedLegacyHooks} 条 expression/behavior`)
                if (issues.length === 0) {
                  return (
                    <span className='cb-note' style={{ fontSize: '0.8em', color: '#6e6e73' }}>
                      当前大小 {formatBytes(r.originalLength)} / 上限 {formatBytes(CUSTOM_CHAT_CSS_MAX_LENGTH)}
                    </span>
                  )
                }
                return (
                  <span
                    role='status'
                    aria-live='polite'
                    className='cb-note'
                    style={{ fontSize: '0.8em', color: 'var(--cb-warning-text)' }}
                  >
                    ⚠️ 注入前会自动处理：{issues.join('；')}
                  </span>
                )
              })()}
            </div>
          </details>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='customChatFoldMode'
              type='checkbox'
              checked={customChatFoldMode.value}
              disabled={!customChatEnabled.value}
              onInput={e => {
                customChatFoldMode.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='customChatFoldMode' style={{ color: customChatEnabled.value ? undefined : '#999' }}>
              去重折叠（合并 9 秒内的重复弹幕，显示 ×N）
            </label>
          </span>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='customChatPerfDebug'
              type='checkbox'
              checked={customChatPerfDebug.value}
              disabled={!customChatEnabled.value}
              onInput={e => {
                customChatPerfDebug.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='customChatPerfDebug' style={{ color: customChatEnabled.value ? undefined : '#999' }}>
              显示 Chatterbox 性能调试信息
            </label>
          </span>
        </div>
      </div>
    </details>
  )
}
