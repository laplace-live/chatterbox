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
  msgSendInterval,
  normalSendPanelOpen,
  normalSendYolo,
} from '../lib/store'
import { processMessages } from '../lib/utils'
import { EmoteSelector } from './emote-selector'
import { PromptPicker } from './prompt-picker'
import { AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Textarea } from './ui/textarea'

export function NormalSendTab() {
  // In-flight indicator for the polish call. Drives both the AI button
  // label ("润色中…") and the textarea's disabled state, since we don't
  // want the user mutating `fasongText` while a polish is racing to
  // overwrite it on completion.
  const polishing = useSignal(false)

  const llmGap = describeLlmGap('normalSend')
  const llmReady = llmGap === null

  // Inline prompt picker visibility. We surface the picker as soon as
  // the API itself is wired up (base + key + model) and there's at
  // least one normalSend prompt to pick from — even when the
  // currently-active draft is empty (which makes `llmReady` false).
  // Showing it in that case is the whole point: it lets the user
  // recover by switching to a non-empty draft without round-tripping
  // through Settings. Index clamping for out-of-range persisted values
  // is handled inside `PromptPicker`.
  const showPromptPicker = isLlmApiConfigured() && llmPromptsNormalSend.value.length > 0

  /**
   * Run the LLM polish on whatever's currently in the textarea, replace
   * the textarea content with the polished result, and return whether
   * we succeeded. Shared between the AI button (manual) and the YOLO
   * Enter handler (auto) so both paths apply identical validation /
   * cleanup / logging.
   */
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
      // Mutate `fasongText` rather than passing through a temporary so
      // the textarea visibly shows the polished result — both for the
      // manual AI flow (user reviews + sends) AND the YOLO flow (the
      // user briefly sees what was polished before sendMessage clears
      // the field).
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

    // Cross-room emote ID (e.g. `room_1713546334_108382` pasted from another
    // streamer's room). B站 would echo the raw ID back into chat as plain
    // text, so reject before sending.
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

  /**
   * Submit handler for the textarea's Enter key. In YOLO mode this
   * polishes BEFORE handing off to `sendMessage`; otherwise it forwards
   * straight through. YOLO refuses to send when the LLM isn't usable
   * (rather than silently falling back to raw send) — the user
   * explicitly opted into "polish before send", and a silent skip
   * would surprise them.
   */
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
        <div class='lc-my-2 lc-relative'>
          <Textarea
            value={fasongText.value}
            // Locked while a polish is racing — without this the user
            // could keep typing past the moment we apply the polished
            // result, and our `fasongText.value = polished` write would
            // clobber their fresh keystrokes.
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
            className='lc-h-[50px]'
          />
          <div class='lc-absolute lc-right-2 lc-bottom-1.5 lc-text-ga6 lc-pointer-events-none'>
            {fasongText.value.length}
          </div>
        </div>

        {/* Action row sits directly under the textarea. The emote picker
            leads because it's a separate concern from the AI cluster
            (LLM polish / YOLO toggle / prompt picker) — putting it
            first in reading order makes the "insert an emote" path
            equally discoverable. The disabled-when-not-ready states on
            the AI buttons keep the UI honest: users can SEE the buttons
            (good for discovery) but can't trigger them until the LLM
            is wired up. */}
        <div class='lc-my-2 lc-flex lc-items-center  lc-gap-1'>
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
            // Variant flip is the primary "is this on?" signal —
            // brand-coloured fill when active, neutral outline when
            // off. Same affordance pattern as the 独轮车 / 自动融入
            // toggle buttons.
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
            // Inline switcher for the active 常规发送 prompt. The
            // PromptManager in Settings is still the place to author
            // / edit / reorder the list; this picker is purely for
            // hot-swapping which one feeds the AI 润色 / YOLO calls
            // without leaving the send tab. Smaller grapheme cap than
            // the Settings picker because the dropdown sits inline
            // with two buttons and we want the row to stay readable
            // in the narrowest dialog width.
            <PromptPicker
              className='lc-min-w-[40px] lc-truncate'
              title='切换 AI 润色 / YOLO 使用的常规发送提示词'
              prompts={llmPromptsNormalSend.value}
              activeIndex={llmActivePromptNormalSend.value}
              onActiveIndexChange={v => {
                llmActivePromptNormalSend.value = v
              }}
              previewGraphemes={16}
            />
          )}
          {!llmReady && <span class='lc-text-ga6 lc-text-[.85em] lc-ml-1'>AI 功能需配置 LLM 后启用</span>}
        </div>

        <div class='lc-my-2'>
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
