import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import { formatLockedEmoticonReject, isEmoticonUnique, isLockedEmoticon } from '../lib/emoticon'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { aiEvasion, fasongText, maxLength, msgSendInterval, normalSendPanelOpen } from '../lib/store'
import { processMessages } from '../lib/utils'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'

export function NormalSendTab() {
  const sendMessage = async () => {
    const originalMessage = fasongText.value.trim()
    if (!originalMessage) {
      appendLog('⚠️ 消息内容不能为空')
      return
    }

    if (isLockedEmoticon(originalMessage)) {
      appendLog(formatLockedEmoticonReject(originalMessage, '手动表情'))
      fasongText.value = ''
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
        const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL)
        const baseLabel = result.isEmoticon ? '手动表情' : '手动'
        const label = total > 1 ? `${baseLabel} [${i + 1}/${total}]` : baseLabel
        const displayMsg = wasReplaced && total === 1 ? `${originalMessage} → ${segment}` : segment

        appendLog(result, label, displayMsg)
        if (!result.success) {
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
    <AccordionItem
      open={normalSendPanelOpen.value}
      onOpenChange={v => {
        normalSendPanelOpen.value = v
      }}
    >
      <AccordionTrigger>常规发送</AccordionTrigger>
      <AccordionContent>
        <div style={{ margin: '.5em 0', position: 'relative' }}>
          <Textarea
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
            style={{ height: '50px' }}
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
          <Checkbox
            id='aiEvasion'
            checked={aiEvasion.value}
            onInput={e => {
              aiEvasion.value = e.currentTarget.checked
            }}
            label='AI规避（发送失败时自动检测敏感词并重试）'
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
