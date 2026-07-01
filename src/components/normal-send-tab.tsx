import { useSignal } from '@preact/signals'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from '../lib/emoticon'
import { describeLlmGap, isLlmApiConfigured, polishWithLlm } from '../lib/llm-tasks'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import {
  aiEvasion,
  fasongText,
  llmActivePromptNormalSend,
  llmPromptsNormalSend,
  maxLength,
  normalSendPanelOpen,
  normalSendWrapBrackets,
  normalSendYolo,
} from '../lib/store'
import { processMessages } from '../lib/utils'
import { wrapSegment, wrapSplitLen } from '../lib/wrap'
import { EmoteSelector } from './emote-selector'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'

export function NormalSendTab() {
  // Disables the textarea so keystrokes can't be clobbered by the completing polish write.
  const polishing = useSignal(false)

  const llmGap = describeLlmGap('normalSend')
  const llmReady = llmGap === null

  // Shown even when the active draft is empty (llmReady false), so the user can switch to a non-empty draft.
  const showPromptPicker = isLlmApiConfigured() && llmPromptsNormalSend.value.length > 0

  /** Polish the textarea content in place; returns whether it succeeded. */
  const polishCurrentInput = async (): Promise<boolean> => {
    if (polishing.value) return false
    const original = fasongText.value.trim()
    if (!original) {
      appendLog('⚠️ 消息内容不能为空')
      return false
    }
    polishing.value = true
    try {
      const polished = await polishWithLlm('normalSend', original)
      if (!polished) {
        appendLog('⚠️ AI 返回为空，已保留原文')
        return false
      }
      // Write to the signal so the textarea visibly shows the polished result before send.
      fasongText.value = polished
      appendLog(`✨ AI 润色：${original} → ${polished}`)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`❌ AI 润色失败：${msg}`)
      return false
    } finally {
      polishing.value = false
    }
  }

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

    // Cross-room emote ID (e.g. `room_..._...`): B站 echoes it back as plain text, so reject.
    if (isUnavailableEmoticon(originalMessage)) {
      appendLog(formatUnavailableEmoticonReject(originalMessage, '手动表情'))
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

      // Never wrap emotes (【】 breaks the ID); for text, reserve wrapper graphemes so each segment still fits maxLength.
      const wrap = !isEmote && normalSendWrapBrackets.value
      const segments = isEmote
        ? [processedMessage]
        : processMessages(processedMessage, wrapSplitLen(maxLength.value, wrap)).map(s => wrapSegment(s, wrap))
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
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  /** Enter-key handler; in YOLO mode polishes first and refuses to send if the LLM is unusable. */
  const handleSubmit = async () => {
    if (normalSendYolo.value) {
      if (!llmReady) {
        appendLog(`❌ YOLO 模式已开启，但 ${llmGap}。请检查配置或先关闭 YOLO 模式。`)
        return
      }
      const ok = await polishCurrentInput()
      if (!ok) return
    }
    await sendMessage()
  }

  return (
    <AccordionItem
      open={normalSendPanelOpen.value}
      onOpenChange={v => {
        normalSendPanelOpen.value = v
      }}
    >
      <AccordionTrigger>常规发送{normalSendYolo.value ? ' ⚡️' : ''}</AccordionTrigger>
      <AccordionContent>
        <div class='relative my-2'>
          <Textarea
            value={fasongText.value}
            // Locked during polish so the completing write can't clobber fresh keystrokes.
            disabled={polishing.value}
            onInput={e => {
              fasongText.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                void handleSubmit()
              }
            }}
            placeholder={
              normalSendYolo.value && llmReady
                ? 'YOLO 模式：输入后 Enter 会自动 AI 润色并发送'
                : '输入弹幕内容… (Enter 发送)'
            }
            className='h-14'
          />
          <div class='pointer-events-none absolute right-2 bottom-1.5 text-ga6'>{fasongText.value.length}</div>
        </div>

        <div class='my-2 flex items-center gap-1'>
          <EmoteSelector />
          <Button
            variant='outline'
            size='sm'
            disabled={!llmReady || polishing.value || !fasongText.value.trim()}
            onClick={() => void polishCurrentInput()}
          >
            {polishing.value ? '润色中…' : 'AI 润色'}
          </Button>
          <Button
            variant={normalSendYolo.value ? 'default' : 'outline'}
            size='sm'
            disabled={!llmReady}
            onClick={() => {
              normalSendYolo.value = !normalSendYolo.value
            }}
          >
            YOLO
          </Button>
          {showPromptPicker && (
            <PromptPicker
              className='min-w-10 truncate'
              title='切换 AI 润色 / YOLO 使用的常规发送提示词'
              prompts={llmPromptsNormalSend.value}
              activeIndex={llmActivePromptNormalSend.value}
              onActiveIndexChange={v => {
                llmActivePromptNormalSend.value = v
              }}
              previewGraphemes={16}
            />
          )}
        </div>

        <div class='my-2 flex flex-wrap items-center gap-3'>
          <Checkbox
            id='aiEvasion'
            checked={aiEvasion.value}
            onInput={e => {
              aiEvasion.value = e.currentTarget.checked
            }}
            label='AI规避（发送失败时自动检测敏感词并重试）'
          />
          <Checkbox
            id='normalSendWrapBrackets'
            checked={normalSendWrapBrackets.value}
            onInput={e => {
              normalSendWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹弹幕内容'
          />
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}
