import type { DanmakuConfigResponse } from './types'

import { ensureRoomId, fetchEmoticons, getCsrfToken, getSpmPrefix, sendDanmaku } from './api'
import { BASE_URL } from './const'
import { applyReplacements, buildReplacementMap } from './replacement'
import {
  activeTemplateIndex,
  appendLog,
  availableDanmakuColors,
  cachedRoomId,
  forceScrollDanmaku,
  isEmoticonUnique,
  maxLength,
  msgSendInterval,
  msgTemplates,
  randomChar,
  randomColor,
  randomInterval,
  restoreSendState,
  sendMsg,
} from './store'
import { formatDanmakuError, processMessages } from './utils'
import { cachedWbiKeys, encodeWbi, waitForWbiKeys } from './wbi'

const DEFAULT_COLORS = [
  '0xe33fff',
  '0x54eed8',
  '0x58c1de',
  '0x455ff6',
  '0x975ef9',
  '0xc35986',
  '0xff8c21',
  '0x00fffc',
  '0x7eff00',
  '0xffed4f',
  '0xff9800',
]

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
          const initConfigForm = new FormData()
          initConfigForm.append('room_id', String(cachedRoomId.value))
          initConfigForm.append('mode', '1')
          initConfigForm.append('csrf_token', initCsrfToken)
          initConfigForm.append('csrf', initCsrfToken)
          initConfigForm.append('visit_id', '')
          try {
            await fetch(BASE_URL.BILIBILI_MSG_CONFIG, {
              method: 'POST',
              credentials: 'include',
              body: initConfigForm,
            })
          } catch {
            // non-critical
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLog(`❌ 获取房间ID失败: ${message}`)
      await new Promise(r => setTimeout(r, 5000))
      return
    }

    restoreSendState()
  }

  const csrfToken = getCsrfToken()

  while (true) {
    if (sendMsg.value) {
      const currentTemplate = msgTemplates.value[activeTemplateIndex.value] ?? ''
      if (!currentTemplate.trim()) {
        appendLog('⚠️ 当前模板为空，已自动停止运行')
        sendMsg.value = false
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
      for (let i = 0; i < total; i++) {
        const message = Msg[i]
        if (sendMsg.value) {
          const isEmote = isEmoticonUnique(message)
          const originalMessage = message
          const processedMessage = isEmote ? message : applyReplacements(message)
          const wasReplaced = !isEmote && originalMessage !== processedMessage

          if (enableRandomColor) {
            const colorSet = availableDanmakuColors.value ?? DEFAULT_COLORS
            const rndColor = colorSet[Math.floor(Math.random() * colorSet.length)] ?? '0xffffff'
            const configForm = new FormData()
            configForm.append('room_id', String(roomId))
            configForm.append('color', rndColor)
            configForm.append('csrf_token', csrfToken ?? '')
            configForm.append('csrf', csrfToken ?? '')
            configForm.append('visit_id', '')
            try {
              await fetch(BASE_URL.BILIBILI_MSG_CONFIG, {
                method: 'POST',
                credentials: 'include',
                body: configForm,
              })
            } catch {
              // non-critical
            }
          }

          const result = await sendDanmaku(processedMessage, roomId, csrfToken ?? '')
          const displayMsg = wasReplaced ? `${originalMessage} → ${processedMessage}` : processedMessage
          const baseLabel = result.isEmoticon ? '自动表情' : '自动'
          const label = total > 1 ? `${baseLabel} [${i + 1}/${total}]` : baseLabel
          const logMessage = result.success
            ? `✅ ${label}: ${displayMsg}`
            : `❌ ${label}: ${displayMsg}，原因：${formatDanmakuError(result.error)}。`
          appendLog(logMessage)

          const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
          await new Promise(r => setTimeout(r, interval * 1000 - resolvedRandomInterval))
        }
      }

      count += 1
      appendLog(`🔵第 ${count} 轮发送完成`)
    } else {
      count = 0
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}
