import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import { copyTextToClipboard } from '../lib/clipboard'
import { logLines, maxLogLines, notifyUser } from '../lib/log'
import { logPanelFocusRequest, logPanelOpen } from '../lib/store'

export function LogPanel() {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  const copiedFlash = useSignal(false)

  const scrollToBottom = () => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }

  useEffect(() => {
    scrollToBottom()
  }, [logLines.value])

  useEffect(() => {
    if (logPanelFocusRequest.value <= 0) return
    detailsRef.current?.scrollIntoView({ block: 'nearest' })
    scrollToBottom()
    ref.current?.focus()
  }, [logPanelFocusRequest.value])

  const handleCopyAll = async () => {
    const text = logLines.value.join('\n')
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (ok) {
      copiedFlash.value = true
      window.setTimeout(() => {
        copiedFlash.value = false
      }, 1400)
    } else {
      notifyUser('error', '复制日志失败，请手动选择文本复制')
    }
  }

  const handleClear = () => {
    logLines.value = []
  }

  const isEmpty = logLines.value.length === 0

  return (
    <details
      ref={detailsRef}
      open={logPanelOpen.value}
      onToggle={e => {
        logPanelOpen.value = e.currentTarget.open
      }}
      style={{ marginTop: '.25em' }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>
        日志
        {logLines.value.length > 0 && (
          <span className='cb-soft' style={{ fontWeight: 400, marginLeft: '.4em', fontSize: '0.9em' }}>
            · {logLines.value.length} 条
          </span>
        )}
      </summary>
      <div className='cb-body'>
        <div
          className='cb-row'
          style={{
            display: 'flex',
            gap: '.4em',
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: '.5em',
          }}
        >
          <button
            type='button'
            className='cb-btn'
            onClick={() => {
              void handleCopyAll()
            }}
            disabled={isEmpty}
            title='把整段日志复制到剪贴板（便于反馈 bug）'
            style={{ fontSize: '11px', padding: '2px 8px' }}
          >
            复制全部
          </button>
          <button
            type='button'
            className='cb-btn'
            onClick={handleClear}
            disabled={isEmpty}
            title='清空当前会话日志（不影响已发出的弹幕）'
            style={{ fontSize: '11px', padding: '2px 8px' }}
          >
            清空
          </button>
          {copiedFlash.value && (
            <span
              role='status'
              aria-live='polite'
              style={{ color: 'var(--cb-success-text)', fontSize: '11px', fontWeight: 650 }}
            >
              ✓ 已复制
            </span>
          )}
          <span className='cb-soft' style={{ marginLeft: 'auto', fontSize: '11px' }}>
            {logLines.value.length}/{maxLogLines.value}
          </span>
        </div>
        <textarea
          ref={ref}
          readOnly
          value={logLines.value.join('\n')}
          placeholder={`活动日志会在这里显示（自动发送、跟车、同传、错误等；最多保留 ${maxLogLines.value} 条）`}
          style={{
            boxSizing: 'border-box',
            height: '60px',
            width: '100%',
            resize: 'vertical',
            marginTop: '.4em',
          }}
        />
      </div>
    </details>
  )
}
