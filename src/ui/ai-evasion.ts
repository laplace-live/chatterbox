import { GM_getValue } from '$'
import { sendDanmaku } from '../api.js'
import { BASE_URL } from '../const.js'
import { appendToLimitedLog, getGraphemes } from '../utils.js'

interface DetectionResult {
  hasSensitiveContent?: boolean
  sensitiveWords?: string[]
  severity?: string
  categories?: string[]
}

/**
 * Calls Laplace chat-audit API to detect sensitive words.
 */
export async function detectSensitiveWords(
  text: string,
  msgLogs: HTMLTextAreaElement,
  maxLogLines: number
): Promise<DetectionResult> {
  try {
    const resp = await fetch(BASE_URL.LAPLACE_CHAT_AUDIT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        completionMetadata: { input: text },
      }),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: { completion?: DetectionResult } = await resp.json()
    return data.completion ?? { hasSensitiveContent: false }
  } catch (err) {
    console.error('AI detection error:', err)
    const msg = err instanceof Error ? err.message : String(err)
    appendToLimitedLog(msgLogs, `⚠️ AI检测服务出错：${msg}`, maxLogLines)
    return { hasSensitiveContent: false }
  }
}

function insertInvisibleChars(word: string): string {
  const graphemes = getGraphemes(word)
  return graphemes.join('­')
}

export function replaceSensitiveWords(text: string, sensitiveWords: string[]): string {
  let result = text
  for (const word of sensitiveWords) {
    result = result.split(word).join(insertInvisibleChars(word))
  }
  return result
}

export interface TryAiEvasionResult {
  success: boolean
  evadedMessage?: string
  error?: string
}

/**
 * Attempts AI evasion for a failed message by detecting and replacing sensitive words, then resending.
 */
export async function tryAiEvasion(
  message: string,
  roomId: number,
  csrfToken: string,
  logPrefix: string,
  msgLogs: HTMLTextAreaElement,
  maxLogLines: number
): Promise<TryAiEvasionResult> {
  const aiEvasionEnabled = GM_getValue<boolean>('aiEvasion', false)
  if (!aiEvasionEnabled) return { success: false }

  appendToLimitedLog(msgLogs, `🤖 ${logPrefix}AI规避：正在检测敏感词…`, maxLogLines)

  const detection = await detectSensitiveWords(message, msgLogs, maxLogLines)

  if (detection.hasSensitiveContent && detection.sensitiveWords && detection.sensitiveWords.length > 0) {
    appendToLimitedLog(
      msgLogs,
      `🤖 ${logPrefix}检测到敏感词：${detection.sensitiveWords.join(', ')}，正在尝试规避…`,
      maxLogLines
    )

    const evadedMessage = replaceSensitiveWords(message, detection.sensitiveWords)
    const retryResult = await sendDanmaku(evadedMessage, roomId, csrfToken)

    if (retryResult.success) {
      appendToLimitedLog(msgLogs, `✅ ${logPrefix}AI规避成功: ${evadedMessage}`, maxLogLines)
      return { success: true, evadedMessage }
    }

    appendToLimitedLog(msgLogs, `❌ ${logPrefix}AI规避失败: ${evadedMessage}，原因：${retryResult.error}`, maxLogLines)
    return { success: false, evadedMessage, error: retryResult.error }
  }

  appendToLimitedLog(msgLogs, `⚠️ ${logPrefix}无法检测到敏感词，请手动检查`, maxLogLines)
  return { success: false }
}
