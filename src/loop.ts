import type { DanmakuConfigResponse } from './types.js'

import { GM_getValue } from '$'
import { ensureRoomId, getCsrfToken, getSpmPrefix, sendDanmaku } from './api.js'
import { BASE_URL } from './const.js'
import { applyReplacements, buildReplacementMap } from './replacement.js'
import {
  activeTemplateIndex,
  availableDanmakuColors,
  cachedRoomId,
  MsgTemplates,
  onRoomIdReadyCallback,
  sendMsg,
  setAvailableDanmakuColors,
  setSendMsg,
} from './state.js'
import { appendToLimitedLog, processMessages } from './utils.js'
import { cachedWbiKeys, encodeWbi, waitForWbiKeys } from './wbi.js'

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
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLines = GM_getValue<number>('maxLogLines')

  let roomId = cachedRoomId
  if (roomId === null) {
    try {
      roomId = await ensureRoomId()
      buildReplacementMap()
      if (onRoomIdReadyCallback) {
        onRoomIdReadyCallback()
      }

      await waitForWbiKeys()
      if (cachedWbiKeys) {
        try {
          const configQuery = encodeWbi(
            {
              room_id: String(cachedRoomId),
              web_location: getSpmPrefix(),
            },
            cachedWbiKeys
          )
          const configUrl = `${BASE_URL.BILIBILI_GET_DM_CONFIG}?${configQuery}`
          const configResp = (await fetch(configUrl, {
            method: 'GET',
            credentials: 'include',
          }).then(r => r.json())) as DanmakuConfigResponse

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
              setAvailableDanmakuColors(colors)
              console.log('[LAPLACE Chatterbox Helper] Available colors:', colors)
            }
          }
        } catch {
          // non-critical
        }
      }

      const forceScrollDanmaku = GM_getValue<boolean>('forceScrollDanmaku')
      if (forceScrollDanmaku) {
        const initCsrfToken = getCsrfToken()
        if (initCsrfToken) {
          const initConfigForm = new FormData()
          initConfigForm.append('room_id', String(cachedRoomId))
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
      appendToLimitedLog(msgLogs, `❌ 获取房间ID失败: ${message}`, maxLogLines)
      await new Promise(r => setTimeout(r, 5000))
      return
    }
  }

  const csrfToken = getCsrfToken()

  while (true) {
    if (sendMsg) {
      const currentTemplate = MsgTemplates[activeTemplateIndex] ?? ''
      if (!currentTemplate.trim()) {
        appendToLimitedLog(msgLogs, '⚠️ 当前模板为空，已自动停止运行', maxLogLines)
        setSendMsg(false)
        const sendBtn = document.getElementById('sendBtn')
        const toggleBtn = document.getElementById('toggleBtn')
        if (sendBtn) sendBtn.textContent = '开启独轮车'
        if (toggleBtn) (toggleBtn as HTMLElement).style.background = 'rgb(166 166 166)'
        continue
      }

      const msgSendInterval = GM_getValue<number>('msgSendInterval')
      const enableRandomColor = GM_getValue<boolean>('randomColor')
      const enableRandomInterval = GM_getValue<boolean>('randomInterval')
      const enableRandomChar = GM_getValue<boolean>('randomChar')
      const Msg = processMessages(currentTemplate, GM_getValue<number>('maxLength'), enableRandomChar)

      for (const message of Msg) {
        if (sendMsg) {
          const originalMessage = message
          const processedMessage = applyReplacements(message)
          const wasReplaced = originalMessage !== processedMessage

          if (enableRandomColor) {
            const colorSet = availableDanmakuColors ?? DEFAULT_COLORS
            const randomColor = colorSet[Math.floor(Math.random() * colorSet.length)] ?? '0xffffff'
            const configForm = new FormData()
            configForm.append('room_id', String(roomId))
            configForm.append('color', randomColor)
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
          const logMessage = result.success
            ? `✅ 自动: ${displayMsg}`
            : `❌ 自动: ${displayMsg}，原因：${result.error}。`
          appendToLimitedLog(msgLogs, logMessage, maxLogLines)

          const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
          await new Promise(r => setTimeout(r, msgSendInterval * 1000 - resolvedRandomInterval))
        }
      }

      count += 1
      appendToLimitedLog(msgLogs, `🔵第 ${count} 轮发送完成`, maxLogLines)
    } else {
      count = 0
      await new Promise(r => setTimeout(r, 1000))
    }
  }
}
