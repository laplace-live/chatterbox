import { signal } from '@preact/signals'

import { tryAiEvasion } from './ai-evasion'
import { ensureRoomId, getCsrfToken } from './api'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { describeLlmGap, polishWithLlm } from './llm-tasks'
import { appendLog } from './log'
import { applyReplacements } from './replacement'
import { applyRoadRageOnSend, previewRoadRageText } from './road-rage'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  danmakuMaxUnits,
  fasongText,
  invisibleChar,
  normalSendRoadRage,
  normalSendWrapBrackets,
  normalSendYolo,
} from './store'
import { countDanmakuMessages, processDanmakuMessages } from './utils'
import { wrapSegment, wrapSplitUnits } from './wrap'

/** Shared lock across 常规发送 and the floating input box while an LLM polish is in flight. */
export const normalSendPolishing = signal(false)

/** Estimate how many danmaku segments `raw` will split into after replacements, Road Rage, and bracket wrapping. */
export function previewNormalSendCount(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  if (isEmoticonUnique(trimmed) || isUnavailableEmoticon(trimmed)) return 1
  const replaced = applyReplacements(trimmed)
  const trimmedPreview = replaced.trim()
  if (!trimmedPreview) return 0
  if (isEmoticonUnique(trimmedPreview) || isUnavailableEmoticon(trimmedPreview)) return 1
  const preview = previewRoadRageText(trimmed, replaced, invisibleChar.value, normalSendRoadRage.value)
  return countDanmakuMessages(preview, wrapSplitUnits(danmakuMaxUnits.value, normalSendWrapBrackets.value))
}

/** Polish the shared `fasongText` input in place; returns whether it succeeded. */
export async function polishNormalSendInput(): Promise<boolean> {
  if (normalSendPolishing.value) return false
  const original = fasongText.value.trim()
  if (!original) {
    appendLog('⚠️ 消息内容不能为空')
    return false
  }
  normalSendPolishing.value = true
  try {
    const polished = await polishWithLlm('normalSend', original)
    if (!polished) {
      appendLog('⚠️ AI 返回为空，已保留原文')
      return false
    }
    fasongText.value = polished
    appendLog(`✨ AI 润色：${original} → ${polished}`)
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`❌ AI 润色失败：${msg}`)
    return false
  } finally {
    normalSendPolishing.value = false
  }
}

/** Validate, apply replacements and Road Rage dedup, split into segments, and enqueue the manual send. */
export async function sendNormalDanmaku(): Promise<void> {
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

  const wasOriginalEmote = isEmoticonUnique(originalMessage)
  let processedMessage = wasOriginalEmote ? originalMessage : applyReplacements(originalMessage)
  const trimmedProcessed = processedMessage.trim()
  if (!trimmedProcessed) {
    appendLog(`⚠️ 消息替换后为空，未发送：${originalMessage}`)
    fasongText.value = ''
    return
  }
  if (!wasOriginalEmote && isLockedEmoticon(trimmedProcessed)) {
    appendLog(formatLockedEmoticonReject(trimmedProcessed, '手动表情'))
    fasongText.value = ''
    return
  }
  if (!wasOriginalEmote && isUnavailableEmoticon(trimmedProcessed)) {
    appendLog(formatUnavailableEmoticonReject(trimmedProcessed, '手动表情'))
    fasongText.value = ''
    return
  }
  const isEmote = wasOriginalEmote || isEmoticonUnique(trimmedProcessed)
  if (isEmote) processedMessage = trimmedProcessed
  const wasReplaced = !wasOriginalEmote && originalMessage !== processedMessage
  fasongText.value = ''

  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ 未找到登录信息，请先登录 Bilibili')
      return
    }

    const {
      text: roadRageMessage,
      roadRaged,
      settle: settleRoadRage,
    } = applyRoadRageOnSend({
      original: originalMessage,
      processed: processedMessage,
      char: invisibleChar.value,
      enabled: normalSendRoadRage.value,
      isEmote,
    })
    processedMessage = roadRageMessage

    // Never wrap emotes (【】 breaks the ID); reserve wrapper units for text segments.
    const wrap = !isEmote && normalSendWrapBrackets.value
    const segments = isEmote
      ? [processedMessage]
      : processDanmakuMessages(processedMessage, wrapSplitUnits(danmakuMaxUnits.value, wrap)).map(s =>
          wrapSegment(s, wrap)
        )
    const total = segments.length

    let delivered = false
    try {
      for (let i = 0; i < total; i++) {
        const segment = segments[i]
        const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL, 'manual')
        if (result.success) delivered = true
        const baseLabel = result.isEmoticon ? '手动表情' : roadRaged ? '手动·路怒' : '手动'
        const label = total > 1 ? `${baseLabel} [${i + 1}/${total}]` : baseLabel
        const displayMsg = wasReplaced && total === 1 ? `${originalMessage} → ${segment}` : segment

        appendLog(result, label, displayMsg)
        if (!result.success) {
          const evaded = await tryAiEvasion(segment, roomId, csrfToken, '', 'manual')
          if (evaded.success) delivered = true
        }
      }
    } finally {
      settleRoadRage(delivered)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 发送出错：${msg}`)
  }
}

/** Enter-key / manual submit handler; in YOLO mode polishes first and aborts if the LLM is unusable. */
export async function submitNormalSend(): Promise<void> {
  if (normalSendYolo.value) {
    const llmGap = describeLlmGap('normalSend')
    if (llmGap !== null) {
      appendLog(`❌ YOLO 模式已开启，但 ${llmGap}。请检查配置或先关闭 YOLO 模式。`)
      return
    }
    const ok = await polishNormalSendInput()
    if (!ok) return
  }
  await sendNormalDanmaku()
}
