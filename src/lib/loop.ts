import type { DanmakuConfigResponse } from '../types'

import { ensureRoomId, fetchEmoticons, getCsrfToken, getSpmPrefix, setDanmakuMode, setRandomDanmakuColor } from './api'
import { BASE_URL } from './const'
import { formatLockedEmoticonReject, isEmoticonUnique, isLockedEmoticon } from './emoticon'
import { appendLog } from './log'
import { applyReplacements, buildReplacementMap } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeTemplateIndex,
  availableDanmakuColors,
  cachedRoomId,
  forceScrollDanmaku,
  maxLength,
  msgSendInterval,
  msgTemplates,
  randomChar,
  randomColor,
  randomInterval,
  sendMsg,
} from './store'
import { processMessages } from './utils'
import { cachedWbiKeys, encodeWbi, waitForWbiKeys } from './wbi'

let currentAbort: AbortController | null = null

export function cancelLoop(): void {
  currentAbort?.abort()
  currentAbort = null
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => resolve(true), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true }
    )
  })
}

/**
 * Main loop: handles auto-send (独轮车), room init, danmaku config, and message sending.
 */
export async function loop(): Promise<void> {
  let count = 0

  let roomId = cachedRoomId.value
  if (roomId === null) {
    try {
      roomId = await ensureRoomId()
      buildReplacementMap()

      await waitForWbiKeys()
      if (cachedWbiKeys) {
        try {
          const configQuery = encodeWbi(
            {
              room_id: String(cachedRoomId.value),
              web_location: getSpmPrefix(),
            },
            cachedWbiKeys
          )
          const configUrl = `${BASE_URL.BILIBILI_GET_DM_CONFIG}?${configQuery}`
          const configResp: DanmakuConfigResponse = await fetch(configUrl, {
            method: 'GET',
            credentials: 'include',
          }).then(r => r.json())

          if (configResp?.data?.group) {
            const colors: string[] = []
            for (const group of configResp.data.group) {
              for (const color of group.color) {
                if (color.status === 1) {
                  colors.push(`0x${color.color_hex}`)
                }
              }
            }
            if (colors.length > 0) {
              availableDanmakuColors.value = colors
              console.log('[LAPLACE Chatterbox] Available colors:', colors)
            }
          }
        } catch {
          // non-critical
        }
      }

      try {
        await fetchEmoticons(roomId)
      } catch {
        // non-critical
      }

      if (forceScrollDanmaku.value) {
        const initCsrfToken = getCsrfToken()
        if (initCsrfToken) {
          await setDanmakuMode(roomId, initCsrfToken, '1')
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLog(`❌ 获取房间ID失败: ${message}`)
      await new Promise(r => setTimeout(r, 5000))
      return
    }
  }

  const csrfToken = getCsrfToken()

  while (true) {
    if (sendMsg.value) {
      currentAbort = new AbortController()
      const { signal } = currentAbort

      const currentTemplate = msgTemplates.value[activeTemplateIndex.value] ?? ''
      if (!currentTemplate.trim()) {
        appendLog('⚠️ 当前模板为空，已自动停止运行')
        sendMsg.value = false
        currentAbort = null
        continue
      }

      const interval = msgSendInterval.value
      const enableRandomColor = randomColor.value
      const enableRandomInterval = randomInterval.value
      const enableRandomChar = randomChar.value

      const Msg: string[] = []
      for (const line of currentTemplate.split('\n').filter(l => l?.trim())) {
        if (isEmoticonUnique(line.trim())) {
          Msg.push(line.trim())
        } else {
          Msg.push(...processMessages(line, maxLength.value, enableRandomChar))
        }
      }

      const total = Msg.length
      let completed = true
      for (let i = 0; i < total; i++) {
        if (signal.aborted) {
          completed = false
          break
        }
        const message = Msg[i]
        if (sendMsg.value) {
          // Skip locked emotes inside the template instead of letting Bilibili
          // reject them server-side. We still observe the same per-iteration
          // sleep so the user-configured cadence is preserved across the rest
          // of the round.
          if (isLockedEmoticon(message)) {
            const skipLabel = total > 1 ? `自动表情 [${i + 1}/${total}]` : '自动表情'
            appendLog(formatLockedEmoticonReject(message, skipLabel))
            const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
            const ok = await abortableSleep(interval * 1000 - resolvedRandomInterval, signal)
            if (!ok) {
              completed = false
              break
            }
            continue
          }

          const isEmote = isEmoticonUnique(message)
          const originalMessage = message
          const processedMessage = isEmote ? message : applyReplacements(message)
          const wasReplaced = !isEmote && originalMessage !== processedMessage

          if (enableRandomColor) {
            await setRandomDanmakuColor(roomId, csrfToken ?? '')
          }

          const result = await enqueueDanmaku(processedMessage, roomId, csrfToken ?? '', SendPriority.AUTO)
          const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
          const baseLabel = result.isEmoticon ? '自动表情' : '自动'
          const label = total > 1 ? `${baseLabel} [${i + 1}/${total}]` : baseLabel
          appendLog(result, label, displayMsg)

          const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
          const ok = await abortableSleep(interval * 1000 - resolvedRandomInterval, signal)
          if (!ok) {
            completed = false
            break
          }
        }
      }

      currentAbort = null

      if (completed) {
        count += 1
        appendLog(`🔵第 ${count} 轮发送完成`)
      }
    } else {
      count = 0
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}
