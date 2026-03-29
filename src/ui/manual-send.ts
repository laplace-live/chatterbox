import { GM_getValue, GM_setValue } from '$'
import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { applyReplacements } from '../replacement.js'
import { appendToLimitedLog } from '../utils.js'
import { tryAiEvasion } from './ai-evasion.js'

export function setupManualSend(): void {
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLines = GM_getValue<number>('maxLogLines', 1000)
  const fasongInput = document.getElementById('fasongInput') as HTMLTextAreaElement
  const aiEvasionInput = document.getElementById('aiEvasion') as HTMLInputElement

  async function sendMessage(): Promise<void> {
    const originalMessage = fasongInput.value.trim()
    if (!originalMessage) {
      appendToLimitedLog(msgLogs, '⚠️ 消息内容不能为空', maxLogLines)
      return
    }

    const processedMessage = applyReplacements(originalMessage)
    const wasReplaced = originalMessage !== processedMessage
    fasongInput.value = ''

    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()

      if (!csrfToken) {
        appendToLimitedLog(msgLogs, '❌ 未找到登录信息，请先登录 Bilibili', maxLogLines)
        return
      }

      const result = await sendDanmaku(processedMessage, roomId, csrfToken)

      if (result.success) {
        const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
        appendToLimitedLog(msgLogs, `✅ 手动: ${displayMsg}`, maxLogLines)
      } else {
        let errorMsg = result.error ?? '未知错误'
        if (result.error?.includes('f')) errorMsg = 'f - 包含全局屏蔽词'
        else if (result.error?.includes('k')) errorMsg = 'k - 包含房间屏蔽词'

        const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
        appendToLimitedLog(msgLogs, `❌ 手动: ${displayMsg}，原因：${errorMsg}`, maxLogLines)
        await tryAiEvasion(processedMessage, roomId, csrfToken, '', msgLogs, maxLogLines)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendToLimitedLog(msgLogs, `🔴 发送出错：${msg}`, maxLogLines)
    }
  }

  aiEvasionInput?.addEventListener('input', () => {
    GM_setValue('aiEvasion', aiEvasionInput.checked)
  })

  fasongInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      void sendMessage()
    }
  })
}
