import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api'
import { applyReplacements } from '../replacement'
import {
  aiEvasion,
  appendLog,
  fasongText,
  isEmoticonUnique,
  maxLength,
  msgSendInterval,
  normalSendPanelOpen,
} from '../store'
import { formatDanmakuError, processMessages } from '../utils'
import { tryAiEvasion } from './ai-evasion'

export function NormalSendTab() {
  const sendMessage = async () => {
    const originalMessage = fasongText.value.trim()
    if (!originalMessage) {
      appendLog('⚠️ 消息内容不能为空')
      return
    }

    const isEmote = isEmoticonUnique(originalMessage)
    const processedMessage = isEmote ? originalMessage : applyReplacements(originalMessage)
    const wasReplaced = !isEmote && originalMessage !== processedMessage
    fasongText.value = ''

    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }

      const segments = isEmote ? [processedMessage] : processMessages(processedMessage, maxLength.value)
      const total = segments.length

      for (let i = 0; i < total; i++) {
        const segment = segments[i]
        const result = await sendDanmaku(segment, roomId, csrfToken)
        const baseLabel = result.isEmoticon ? '手动表情' : '手动'
        const label = total > 1 ? `${baseLabel} [${i + 1}/${total}]` : baseLabel

        if (result.success) {
          const displayMsg = wasReplaced && total === 1 ? `${originalMessage} → ${segment}` : segment
          appendLog(`✅ ${label}: ${displayMsg}`)
        } else {
          const displayMsg = wasReplaced && total === 1 ? `${originalMessage} → ${segment}` : segment
          appendLog(`❌ ${label}: ${displayMsg}，原因：${formatDanmakuError(result.error)}`)
          await tryAiEvasion(segment, roomId, csrfToken, '')
        }

        if (i < total - 1) {
          await new Promise(r => setTimeout(r, msgSendInterval.value * 1000))
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  return (
    <details
      open={normalSendPanelOpen.value}
      onToggle={e => {
        normalSendPanelOpen.value = e.currentTarget.open
      }}
    >
      <summary style={{ cursor: 'pointer', userSelect: 'none', fontWeight: 'bold' }}>常规发送</summary>
      <div style={{ margin: '.5em 0', position: 'relative' }}>
        <textarea
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
          placeholder='输入弹幕内容… (Enter 发送)'
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
      <div style={{ margin: '.5em 0' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
          <input
            id='aiEvasion'
            type='checkbox'
            checked={aiEvasion.value}
            onInput={e => {
              aiEvasion.value = e.currentTarget.checked
            }}
          />
          <label for='aiEvasion'>AI规避（发送失败时自动检测敏感词并重试）</label>
        </span>
      </div>
    </details>
  )
}
