import type { DanmakuConfigResponse } from '../types'

import {
  ensureRoomId,
  fetchDanmakuMaxLength,
  fetchEmoticons,
  getCsrfToken,
  getSpmPrefix,
  setDanmakuMode,
  setRandomDanmakuColor,
} from './api'
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
import { applyReplacements } from './replacement'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  activeTemplateIndex,
  autoSendYolo,
  availableDanmakuColors,
  cachedRoomId,
  effectiveAutoSendMaxUnits,
  forceScrollDanmaku,
  invisibleChar,
  msgSendInterval,
  msgTemplates,
  randomChar,
  randomColor,
  randomInterval,
  roomDanmakuUnits,
  sendMsg,
} from './store'
import {
  abortableSleep,
  getDanmakuUnits,
  processDanmakuMessages,
  resolveSendDelayMs,
  trimDanmakuByUnits,
} from './utils'
import { cachedWbiKeys, encodeWbi, waitForWbiKeys } from './wbi'

const CAP_LOOKUP_RETRY_MS = 30_000

let currentAbort: AbortController | null = null

export function cancelLoop(): void {
  currentAbort?.abort()
  currentAbort = null
}

/** Main loop: auto-send (独轮车), room init, danmaku config, message sending. */
export async function loop(): Promise<void> {
  let count = 0

  let roomId = cachedRoomId.value
  if (roomId === null) {
    try {
      roomId = await ensureRoomId()

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

  let capLookupRoomId: number | null = null
  let capLookupInFlight = false
  let capLookupRetryAfter = 0
  const csrfToken = getCsrfToken()

  while (true) {
    const activeRoomId = cachedRoomId.value
    if (activeRoomId !== null) roomId = activeRoomId
    if (capLookupRoomId !== roomId) {
      capLookupRoomId = roomId
      capLookupInFlight = false
      capLookupRetryAfter = 0
    }
    if (roomDanmakuUnits.value === null && !capLookupInFlight && Date.now() >= capLookupRetryAfter && getCsrfToken()) {
      const lookupRoomId = roomId
      capLookupInFlight = true
      void fetchDanmakuMaxLength(lookupRoomId)
        .catch(() => {})
        .finally(() => {
          if (capLookupRoomId === lookupRoomId) {
            capLookupInFlight = false
            capLookupRetryAfter = Date.now() + CAP_LOOKUP_RETRY_MS
          }
        })
    }

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
      const randomCharToInsert = randomChar.value ? invisibleChar.value : undefined

      // Parsed once so both YOLO and legacy paths share the same input.
      const rawLines = currentTemplate
        .split('\n')
        .map(l => l?.trim() ?? '')
        .filter(l => l.length > 0)

      // Pre-built upfront so `[i+1/N]` has a stable denominator; only the polish CALLS are deferred (just-in-time, right before send).
      type SendItem = { text: string; replacedFrom?: string }
      type SendTask = { kind: 'direct'; item: SendItem } | { kind: 'polish'; text: string }

      const maxUnits = effectiveAutoSendMaxUnits.value
      const tasks: SendTask[] = []
      if (autoSendYolo.value) {
        // Loud bail, not silent fallback to unpolished text: the user opted into polish. Checked once at round start to fail fast; per-segment failures below stay recoverable.
        if (!isLlmReady('autoSend')) {
          appendLog('❌ 独轮车 YOLO 模式已开启，但 LLM 配置不完整，已自动停止运行')
          sendMsg.value = false
          currentAbort = null
          continue
        }
        // randomChar (dedup marker) suppressed on LLM input — the LLM would ignore or "fix" it; re-applied on output in the polish branch below.
        for (const line of rawLines) {
          if (isEmoticonUnique(line) || isUnavailableEmoticon(line)) {
            tasks.push({ kind: 'direct', item: { text: line } })
          } else {
            for (const chunk of processDanmakuMessages(line, maxUnits)) {
              tasks.push({ kind: 'polish', text: chunk })
            }
          }
        }
      } else {
        // Non-YOLO: replace before randomChar + unit splitting so expanded replacements never overrun maxUnits.
        for (const line of rawLines) {
          if (isEmoticonUnique(line) || isUnavailableEmoticon(line)) {
            tasks.push({ kind: 'direct', item: { text: line } })
          } else {
            const replaced = applyReplacements(line)
            const wasReplaced = replaced !== line
            const trimmedReplaced = replaced.trim()
            if (isEmoticonUnique(trimmedReplaced) || isUnavailableEmoticon(trimmedReplaced)) {
              tasks.push({
                kind: 'direct',
                item: { text: trimmedReplaced, replacedFrom: wasReplaced ? line : undefined },
              })
            } else {
              const chunks = processDanmakuMessages(replaced, maxUnits, randomCharToInsert)
              const replacedFrom = wasReplaced && chunks.length === 1 ? line : undefined
              for (const text of chunks) {
                tasks.push({ kind: 'direct', item: { text, replacedFrom } })
              }
            }
          }
        }
      }

      if (tasks.length === 0) {
        appendLog('⚠️ 当前模板替换后为空，已自动停止运行')
        sendMsg.value = false
        currentAbort = null
        continue
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
        let sendItems: SendItem[]

        if (task.kind === 'polish') {
          try {
            const polished = await polishWithLlm('autoSend', task.text, { signal })
            const trimmedPolished = polished.trim()
            if (!trimmedPolished) {
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
            if (isEmoticonUnique(trimmedPolished) || isUnavailableEmoticon(trimmedPolished)) {
              sendItems = [{ text: trimmedPolished }]
            } else {
              const replaced = applyReplacements(polished)
              const wasReplaced = replaced !== polished
              const trimmedReplaced = replaced.trim()
              if (isEmoticonUnique(trimmedReplaced) || isUnavailableEmoticon(trimmedReplaced)) {
                sendItems = [{ text: trimmedReplaced, replacedFrom: wasReplaced ? polished : undefined }]
              } else {
                // Re-process: replaced polish output may exceed effectiveAutoSendMaxUnits, and randomChar applies now.
                const chunks = processDanmakuMessages(replaced, effectiveAutoSendMaxUnits.value, randomCharToInsert)
                if (chunks.length === 0) {
                  appendLog(`⚠️ 独轮车替换后为空，跳过本段：${polished}`)
                  const ok = await abortableSleep(resolveSendDelayMs(interval, enableRandomInterval), signal)
                  if (!ok) {
                    completed = false
                    break
                  }
                  continue
                }
                const replacedFrom = wasReplaced && chunks.length === 1 ? polished : undefined
                sendItems = chunks.map(text => ({ text, replacedFrom }))
              }
            }
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
          sendItems = [task.item]
        }

        // Sub-items (2+ when polish or mid-round cap drop splits a task) share one `[i+1/total]` label.
        for (let j = 0; j < sendItems.length; j++) {
          if (signal.aborted) {
            completed = false
            break outer
          }
          if (!sendMsg.value) break outer

          let item = sendItems[j]
          const liveMaxUnits = effectiveAutoSendMaxUnits.value
          if (
            liveMaxUnits > 0 &&
            !isEmoticonUnique(item.text) &&
            !isUnavailableEmoticon(item.text) &&
            getDanmakuUnits(item.text) > liveMaxUnits
          ) {
            const resplit = trimDanmakuByUnits(item.text, liveMaxUnits).filter(c => c.trim().length > 0)
            if (resplit.length === 0) continue
            const nextItems = resplit.map(chunk => ({
              text: chunk,
              replacedFrom: resplit.length === 1 ? item.replacedFrom : undefined,
            }))
            sendItems.splice(j, 1, ...nextItems)
            item = nextItems[0]
          }
          const { text: message, replacedFrom } = item

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

          if (enableRandomColor) {
            await setRandomDanmakuColor(roomId, csrfToken ?? '')
          }

          const result = await enqueueDanmaku(
            message,
            roomId,
            csrfToken ?? '',
            SendPriority.AUTO,
            'loop',
            () => !signal.aborted
          )
          const displayMsg = replacedFrom ? `${replacedFrom} → ${message}` : message
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
