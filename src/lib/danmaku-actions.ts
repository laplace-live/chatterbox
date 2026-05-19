import { showConfirm } from '../components/ui/alert-dialog'
import { tryAiEvasion } from './ai-evasion'
import { ensureRoomId, getCsrfToken } from './api'
import { copyTextToClipboard } from './clipboard'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { classifyRiskEvent, syncGuardRoomRiskEvent } from './guard-room-sync'
import { describeLlmGap, polishWithLlm } from './llm-polish'
import { appendLog } from './log'
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import { verifyBroadcast } from './send-verification'
import {
  activeTab,
  aiEvasion,
  customChatEnabled,
  dialogOpen,
  fasongText,
  maxLength,
  msgSendInterval,
  normalSendYolo,
} from './store'
import { processMessages } from './utils'

/**
 * @deprecated Use `copyTextToClipboard` from `./clipboard` directly. This
 * thin wrapper exists only to preserve the existing import surface for
 * `danmaku-actions` consumers that already import `copyText`.
 */
export const copyText = copyTextToClipboard

export async function stealDanmaku(msg: string): Promise<void> {
  const copied = await copyText(msg)
  fasongText.value = msg
  if (!focusCustomChatComposer()) {
    activeTab.value = 'fasong'
    dialogOpen.value = true
  }
  appendLog(copied ? `🥷 偷并复制: ${msg}` : `🥷 偷: ${msg}`)
}

function focusCustomChatComposer(): boolean {
  if (!customChatEnabled.value) return false
  const input = document.querySelector<HTMLTextAreaElement>('#laplace-custom-chat textarea')
  if (!input) return false

  input.value = fasongText.value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
  return true
}

/**
 * Try to populate the user's danmaku composer with `text` WITHOUT sending it.
 * The user reviews the suggestion and can hit Enter / Send themselves.
 *
 * Order of preference:
 *   1. Chatterbox custom chat textarea (when the feature is on)
 *   2. The Send tab's textarea (`fasongText` signal — opens the panel)
 *   3. Bilibili's native chat input (best-effort DOM query)
 *
 * Returns the first target that succeeded, or `null` if no composer was
 * reachable. Always sets `fasongText` as a side-effect so the user can paste
 * from the Send tab even when both DOM targets fail.
 */
export function fillIntoComposer(text: string): 'custom-chat' | 'native' | 'send-tab' | null {
  fasongText.value = text
  if (focusCustomChatComposer()) return 'custom-chat'

  // Bilibili's native chat input. The page has rearranged its DOM many times
  // — this query covers the layouts we've seen across the 2024–2025 versions.
  const native = document.querySelector<HTMLTextAreaElement>(
    [
      '.chat-control-panel-vm textarea',
      '.bottom-actions textarea',
      '.brush-input textarea',
      'textarea.chat-input',
    ].join(', ')
  )
  if (native) {
    native.value = text
    native.dispatchEvent(new Event('input', { bubbles: true }))
    native.focus()
    try {
      native.setSelectionRange(text.length, text.length)
    } catch {
      // Some implementations of <textarea> don't support setSelectionRange when
      // the field is hidden / not yet rendered. Ignore.
    }
    return 'native'
  }

  // Fallback: pop the panel open so the user can see the prefilled Send tab.
  activeTab.value = 'fasong'
  dialogOpen.value = true
  return 'send-tab'
}

export async function repeatDanmaku(
  msg: string,
  options: { confirm?: boolean; anchor?: { x: number; y: number } } = {}
): Promise<void> {
  if (options.confirm) {
    const confirmed = await showConfirm({
      title: '确认发送以下弹幕？',
      body: msg,
      confirmText: '发送',
      anchor: options.anchor,
    })
    if (!confirmed) return
  }

  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ 未找到登录信息，请先登录 Bilibili')
      return
    }
    const processed = applyReplacements(msg)
    if (isLockedEmoticon(processed)) {
      appendLog(formatLockedEmoticonReject(processed, '+1 表情'))
      return
    }
    if (isUnavailableEmoticon(processed)) {
      appendLog(formatUnavailableEmoticonReject(processed, '+1 表情'))
      return
    }
    const result = await enqueueDanmaku(processed, roomId, csrfToken, SendPriority.MANUAL)
    const display = msg !== processed ? `${msg} → ${processed}` : processed
    appendLog(result, '+1', display)
    if (result.success && !result.cancelled) {
      void verifyBroadcast({
        text: processed,
        label: '+1',
        display,
        sinceTs: result.startedAt ?? Date.now(),
        isEmoticon: result.isEmoticon,
        enableAiEvasion: true,
        roomId,
        csrfToken,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 +1 出错：${message}`)
  }
}

export async function sendManualDanmaku(originalMessage: string): Promise<boolean> {
  const trimmed = originalMessage.trim()
  if (!trimmed) {
    appendLog('⚠️ 消息内容不能为空')
    return false
  }

  const isEmote = isEmoticonUnique(trimmed)
  if (isLockedEmoticon(trimmed)) {
    appendLog(formatLockedEmoticonReject(trimmed, '手动表情'))
    return false
  }
  if (isUnavailableEmoticon(trimmed)) {
    appendLog(formatUnavailableEmoticonReject(trimmed, '手动表情'))
    return false
  }

  // AI 润色（原代号 YOLO；手动发送的 LLM 改写）：开启后把用户输入用 LLM 改写一遍再走原管道。
  // - 表情类 unique ID 不送 LLM（改写无意义）
  // - 配置不全或 LLM 失败：保留原文继续走，让用户的本次发送不被阻塞——这是
  //   "立刻发出去"的手动场景,不像独轮车循环可以悄悄停下；任何 AI 润色副作用
  //   都会出现在日志里,用户能看见即可。
  // - signal 名仍叫 `normalSendYolo`（GM 持久化键），保留以避免用户配置迁移。
  let polishedMessage = trimmed
  if (normalSendYolo.value && !isEmote) {
    const gap = describeLlmGap('normalSend')
    if (gap) {
      appendLog(`🤖 手动发送 AI 润色 跳过：${gap}（已发送原文）`)
    } else {
      try {
        const out = (await polishWithLlm('normalSend', trimmed)).trim()
        if (out) {
          polishedMessage = out
          appendLog(`🤖 手动发送 AI 润色：${trimmed} → ${polishedMessage}`)
        } else {
          appendLog('🤖 手动发送 AI 润色 跳过：LLM 返回为空（已发送原文）')
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        appendLog(`🤖 手动发送 AI 润色 跳过：${errMsg}（已发送原文）`)
      }
    }
  }

  const processedMessage = isEmote ? polishedMessage : applyReplacements(polishedMessage)
  const wasReplaced = !isEmote && trimmed !== processedMessage

  try {
    const roomId = await ensureRoomId()
    const csrfToken = getCsrfToken()
    if (!csrfToken) {
      appendLog('❌ 未找到登录信息，请先登录 Bilibili')
      void syncGuardRoomRiskEvent({
        kind: 'login_missing',
        source: 'manual',
        level: 'observe',
        roomId,
        reason: '未找到登录信息',
        advice: '先登录 Bilibili，再发送弹幕。',
      })
      return false
    }

    const segments = isEmote ? [processedMessage] : processMessages(processedMessage, maxLength.value)
    let allSuccess = true

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]
      const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL)
      const baseLabel = result.isEmoticon ? '手动表情' : '手动'
      const label = segments.length > 1 ? `${baseLabel} [${i + 1}/${segments.length}]` : baseLabel
      const displayMsg = wasReplaced && segments.length === 1 ? `${trimmed} → ${segment}` : segment

      appendLog(result, label, displayMsg)
      if (!result.success) {
        allSuccess = false
        const risk = classifyRiskEvent(result.error)
        void syncGuardRoomRiskEvent({
          ...risk,
          source: 'manual',
          roomId,
          errorCode: result.errorCode,
          reason: result.error,
        })
        if (aiEvasion.value) {
          await tryAiEvasion(segment, roomId, csrfToken, '')
        }
      } else if (!result.cancelled) {
        void verifyBroadcast({
          text: segment,
          label,
          display: displayMsg,
          sinceTs: result.startedAt ?? Date.now(),
          isEmoticon: result.isEmoticon,
          enableAiEvasion: true,
          roomId,
          csrfToken,
        })
      }

      if (i < segments.length - 1) {
        await new Promise(r => setTimeout(r, msgSendInterval.value * 1000))
      }
    }

    return allSuccess
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    appendLog(`🔴 发送出错：${msg}`)
    return false
  }
}
