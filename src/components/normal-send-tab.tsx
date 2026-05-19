import { signal } from '@preact/signals'

import { sendManualDanmaku } from '../lib/danmaku-actions'
import {
  aiEvasion,
  customChatEnabled,
  fasongText,
  llmActivePromptNormalSend,
  llmPromptsNormalSend,
  normalSendYolo,
} from '../lib/store'
import { PromptPicker } from './prompt-picker'
import { SendActions } from './send-actions'
import { YoloCallout } from './yolo-callout'

// Module-scope signal (not `useSignal`) so that calling `NormalSendTab()`
// outside a preact render context — as the VNode-tree presence tests do —
// doesn't blow up on a missing hook context. There's only ever one mounted
// NormalSendTab, so a singleton signal is functionally equivalent here.
const flashOk = signal(false)

export function NormalSendTab() {
  // When Chatterbox Chat is on, B站's native composer is hidden and our own
  // floating input lives inside the chat panel. The send-tab textarea would
  // be a duplicate, but disappearing it entirely confuses users who come
  // looking for it. Show a one-line pointer instead of a blank panel.
  if (customChatEnabled.value) {
    return (
      <details open data-cb-normal-send-redirected>
        <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
          <span>手动发送</span>
        </summary>
        <div className='cb-body cb-note' style={{ color: '#666', fontSize: '0.9em', padding: '.25em 0' }}>
          Chatterbox Chat 已接管聊天区——请直接在右侧自定义聊天面板的输入框里发送弹幕。
          要恢复这里的「手动发送」框，可以到「设置 → Chatterbox Chat」关闭该功能。
        </div>
      </details>
    )
  }

  const sendMessage = async () => {
    const sent = await sendManualDanmaku(fasongText.value)
    if (sent) {
      fasongText.value = ''
      flashOk.value = true
      window.setTimeout(() => {
        flashOk.value = false
      }, 1400)
    }
  }

  return (
    <details open>
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
        <span>手动发送</span>
      </summary>
      <div className='cb-body cb-stack'>
        <div style={{ position: 'relative' }} data-cb-send-tab-anchor>
          <textarea
            data-cb-send-tab-textarea
            value={fasongText.value}
            onInput={e => {
              fasongText.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                void sendMessage()
              }
            }}
            placeholder='输入弹幕内容... (Enter 发送)'
            style={{
              boxSizing: 'border-box',
              height: '50px',
              minHeight: '40px',
              width: '100%',
              resize: 'vertical',
            }}
          />
          <div
            style={{
              position: 'absolute',
              right: '8px',
              bottom: '6px',
              color: '#999',
              pointerEvents: 'none',
            }}
          >
            {fasongText.value.length}
          </div>
        </div>
        <div className='cb-row' style={{ display: 'flex', alignItems: 'center', gap: '.5em' }}>
          <SendActions onSend={msg => void sendManualDanmaku(msg)} />
          {flashOk.value && (
            <span
              role='status'
              aria-live='polite'
              style={{ color: 'var(--cb-success-text)', fontWeight: 650, fontSize: '11px', marginLeft: 'auto' }}
            >
              ✓ 已发送
            </span>
          )}
          <button
            type='button'
            className='cb-primary'
            onClick={() => void sendMessage()}
            style={{ marginLeft: flashOk.value ? '.5em' : 'auto' }}
          >
            发送
          </button>
        </div>
        <div className='cb-row' style={{ display: 'flex', flexDirection: 'column', gap: '.15em' }}>
          <span className='cb-row'>
            <input
              id='aiEvasion'
              type='checkbox'
              checked={aiEvasion.value}
              onInput={e => {
                aiEvasion.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='aiEvasion'
              title='发送失败时，弹幕文本会发到 edge-workers.laplace.cn 进行敏感词检测和改写，再尝试重新发送。详见 关于 → 隐私说明。'
            >
              AI规避（发送失败时自动检测敏感词并重试）
            </label>
          </span>
          {aiEvasion.value && (
            <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', paddingLeft: '1.4em' }}>
              开启后，发送失败的弹幕文本会发到 edge-workers.laplace.cn 改写。详见 关于 → 隐私说明。
            </div>
          )}

          <span className='cb-row' style={{ flexWrap: 'wrap', gap: '.25em' }}>
            <input
              id='normalSendYolo'
              type='checkbox'
              checked={normalSendYolo.value}
              onInput={e => {
                normalSendYolo.value = e.currentTarget.checked
              }}
            />
            <label
              htmlFor='normalSendYolo'
              title='AI 润色（原 YOLO）：手动发送的文本先送 LLM 改写再发。失败时回退原文。LLM 凭证在「设置 → LLM」里集中配置。'
            >
              🤖 AI 润色（LLM 改写后再发）
            </label>
            <PromptPicker
              prompts={llmPromptsNormalSend.value}
              activeIndex={llmActivePromptNormalSend.value}
              onActiveIndexChange={i => {
                llmActivePromptNormalSend.value = i
              }}
              previewGraphemes={12}
              className='lc-min-w-[120px] lc-max-w-[180px] lc-truncate'
              title='当前提示词（在「设置 → LLM 提示词 → 手动发送」里管理）'
              emptyText='暂无提示词，请到设置里添加'
              disabled={!normalSendYolo.value}
            />
          </span>
          <YoloCallout
            feature='normalSend'
            enabled={normalSendYolo.value}
            readyText='已就绪：手动发送的文本会先用 LLM 润色（产生 token 消耗）。'
          />
        </div>
      </div>
    </details>
  )
}
