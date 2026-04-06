import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api'
import { applyReplacements } from '../replacement'
import { aiEvasion, appendLog, fasongText } from '../store'
import { tryAiEvasion } from './ai-evasion'

export function NormalSendTab() {
  const sendMessage = async () => {
    const originalMessage = fasongText.value.trim()
    if (!originalMessage) {
      appendLog('⚠️ 消息内容不能为空')
      return
    }

    const processedMessage = applyReplacements(originalMessage)
    const wasReplaced = originalMessage !== processedMessage
    fasongText.value = ''

    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }

      const result = await sendDanmaku(processedMessage, roomId, csrfToken)

      if (result.success) {
        const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
        appendLog(`✅ 手动: ${displayMsg}`)
      } else {
        let errorMsg = result.error ?? '未知错误'
        if (result.error === 'f' || result.error?.includes('f')) errorMsg = 'f - 包含全局屏蔽词'
        else if (result.error === 'k' || result.error?.includes('k')) errorMsg = 'k - 包含房间屏蔽词'
        const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
        appendLog(`❌ 手动: ${displayMsg}，原因：${errorMsg}`)
        await tryAiEvasion(processedMessage, roomId, csrfToken, '')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  return (
    <>
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
    </>
  )
}
