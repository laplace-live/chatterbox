import type { DanmakuConfigResponse } from '../types'

import { ensureRoomId, fetchEmoticons, getCsrfToken, getSpmPrefix, setDanmakuMode, setRandomDanmakuColor } from './api'
import { BASE_URL } from './const'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isEmoticonUnique,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from './emoticon'
import { isLlmReady, polishWithLlm } from './llm-tasks'
import { appendLog } from './log'
import { applyReplacements, buildReplacementMap } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeTemplateIndex,
  autoSendYolo,
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
import { processMessages, resolveSendDelayMs } from './utils'
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

/** Main loop: auto-send (独轮车), room init, danmaku config, message sending. */
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

      // Parsed once so both YOLO and legacy paths share the same input.
      const rawLines = currentTemplate
        .split('\n')
        .map(l => l?.trim() ?? '')
        .filter(l => l.length > 0)

      // Pre-built upfront so `[i+1/N]` has a stable denominator; only the polish CALLS are deferred (just-in-time, right before send).
      type SendTask = { kind: 'direct'; text: string } | { kind: 'polish'; text: string }

      const tasks: SendTask[] = []
      if (autoSendYolo.value) {
        // Loud bail, not silent fallback to unpolished text: the user opted into polish. Checked once at round start to fail fast; per-segment failures below stay recoverable.
        if (!isLlmReady('autoSend')) {
          appendLog('❌ 独轮车 YOLO 模式已开启，但 LLM 配置不完整，已自动停止运行')
          sendMsg.value = false
          currentAbort = null
          continue
        }
        // randomChar (U+00AD dedup marker) suppressed on LLM input — the LLM would ignore or "fix" it; re-applied on output in the polish branch below.
        for (const line of rawLines) {
          if (isEmoticonUnique(line)) {
            tasks.push({ kind: 'direct', text: line })
          } else {
            for (const chunk of processMessages(line, maxLength.value, false)) {
              tasks.push({ kind: 'polish', text: chunk })
            }
          }
        }
      } else {
        // Non-YOLO: randomChar applied here at split time.
        for (const line of rawLines) {
          if (isEmoticonUnique(line)) {
            tasks.push({ kind: 'direct', text: line })
          } else {
            for (const chunk of processMessages(line, maxLength.value, enableRandomChar)) {
              tasks.push({ kind: 'direct', text: chunk })
            }
          }
        }
      }

      const total = tasks.length
      let completed = true
      // Labelled so the inner sub-segment loop can bail out of both loops on abort/stop.
      outer: for (let i = 0; i < total; i++) {
        if (signal.aborted) {
          completed = false
          break
        }
        if (!sendMsg.value) break

        const task = tasks[i]
        let sendItems: string[]

        if (task.kind === 'polish') {
          try {
            const polished = await polishWithLlm('autoSend', task.text, { signal })
            if (!polished.trim()) {
              // Empty polish = refusal; sleep first so a streak doesn't spin past the configured cadence.
              appendLog(`⚠️ 独轮车 AI 返回为空，跳过本段：${task.text}`)
              const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
              if (!ok) {
                completed = false
                break
              }
              continue
            }
            appendLog(`✨ 独轮车 AI 润色：${task.text} → ${polished}`)
            // Re-process: output may exceed maxLength, and randomChar (suppressed on input) applies now.
            sendItems = processMessages(polished, maxLength.value, enableRandomChar)
          } catch (err) {
            // AbortError = 停车 mid-polish; propagate as "round aborted" so the success log doesn't fire.
            if (err instanceof DOMException && err.name === 'AbortError') {
              completed = false
              break
            }
            // Skip this segment, keep the round; sleep first so a broken LLM doesn't spin past cadence.
            const msg = err instanceof Error ? err.message : String(err)
            appendLog(`🔴 独轮车 AI 润色失败，跳过本段：${msg}`)
            const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
            if (!ok) {
              completed = false
              break
            }
            continue
          }
        } else {
          sendItems = [task.text]
        }

        // Sub-items (2+ when polish overran maxLength) share one `[i+1/total]` label as one polish unit.
        for (let j = 0; j < sendItems.length; j++) {
          if (signal.aborted) {
            completed = false
            break outer
          }
          if (!sendMsg.value) break outer

          const message = sendItems[j]

          // Skip locked emotes client-side rather than let Bilibili reject them; still sleep to keep cadence.
          if (isLockedEmoticon(message)) {
            const skipLabel = total > 1 ? `自动表情 [${i + 1}/${total}]` : '自动表情'
            appendLog(formatLockedEmoticonReject(message, skipLabel))
            const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
            if (!ok) {
              completed = false
              break outer
            }
            continue
          }

          // Cross-room emote ID: B站 echoes it back as raw text in chat, so block it; still sleep to keep cadence.
          if (isUnavailableEmoticon(message)) {
            const skipLabel = total > 1 ? `自动表情 [${i + 1}/${total}]` : '自动表情'
            appendLog(formatUnavailableEmoticonReject(message, skipLabel))
            const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
            if (!ok) {
              completed = false
              break outer
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

          const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
          if (!ok) {
            completed = false
            break outer
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
