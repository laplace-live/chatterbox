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

      // Pull lines out of the template once so YOLO and the legacy
      // path share the same parsed input — keeps the two branches
      // diff-able and avoids re-running the split twice.
      const rawLines = currentTemplate
        .split('\n')
        .map(l => l?.trim() ?? '')
        .filter(l => l.length > 0)

      // Unified task representation so the send loop has one shape
      // for both YOLO and non-YOLO. A 'direct' task ships its text
      // straight to chat; a 'polish' task asks the LLM to rewrite the
      // text just-in-time (right before the send), then ships the
      // result. Tasks are pre-built upfront so the per-send `[i+1/N]`
      // label has a stable denominator — only the polish CALLS are
      // deferred, not the iteration plan.
      type SendTask = { kind: 'direct'; text: string } | { kind: 'polish'; text: string }

      const tasks: SendTask[] = []
      if (autoSendYolo.value) {
        // YOLO bail is LOUD, not silent: if the user opted into
        // "polish before send" but the LLM can't deliver, we stop
        // the loop entirely rather than fall back to raw sending
        // the unpolished template. Same contract as 常规发送 /
        // 自动融入 YOLO — silent fallback would surprise the user
        // who explicitly enabled polish. Checked once here at round
        // start so we fail fast rather than mid-round; per-segment
        // failures inside the loop are still recoverable.
        if (!isLlmReady('autoSend')) {
          appendLog('❌ 独轮车 YOLO 模式已开启，但 LLM 配置不完整，已自动停止运行')
          sendMsg.value = false
          currentAbort = null
          continue
        }
        // Pre-split into the same length-bounded chunks that 超过xx
        // 字自动分段 produces — each chunk becomes a polish task and
        // fires its own LLM call. randomChar (soft-hyphen dedup
        // marker) is SUPPRESSED on this input split: the LLM would
        // either ignore the U+00AD hyphen or "fix" it as a typo,
        // and either way the dedup intent gets lost on the polished
        // output. We re-apply randomChar on the OUTPUT side when the
        // polish completes — see the polish branch below.
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
        // Non-YOLO: pre-split with randomChar applied (existing
        // behaviour, exactly equivalent to the previous Msg-build).
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
      // Labelled break target for the inner sub-segment loop —
      // when polish lengthens text past `maxLength`, one polish task
      // can produce 2+ send items and the inner loop needs a way to
      // bail out of BOTH loops on abort/stop.
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
              // Empty polish counts as a refusal — same call as the
              // other YOLO surfaces. Sleep before the next iteration
              // so a streak of empty polishes doesn't spin past the
              // user's configured cadence.
              appendLog(`⚠️ 独轮车 AI 返回为空，跳过本段：${task.text}`)
              const offset = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
              const ok = await abortableSleep(interval * 1000 - offset, signal)
              if (!ok) {
                completed = false
                break
              }
              continue
            }
            appendLog(`✨ 独轮车 AI 润色：${task.text} → ${polished}`)
            // Re-process polished output: it may exceed `maxLength`
            // (LLM lengthened it), and randomChar (suppressed on the
            // LLM-input pass) needs to apply now so the transmitted
            // text retains its dedup-bypass marker. Most polishes
            // produce 1 item; only longer-than-maxLength outputs
            // hit the inner loop multiple times.
            sendItems = processMessages(polished, maxLength.value, enableRandomChar)
          } catch (err) {
            // AbortError = user clicked 停车 mid-polish. Propagate
            // as "round aborted" so the success log doesn't fire.
            if (err instanceof DOMException && err.name === 'AbortError') {
              completed = false
              break
            }
            // Per-segment failure isolation: a transient LLM error
            // shouldn't burn the whole round — log + skip THIS
            // segment and keep going. Sleep first so a broken LLM
            // doesn't make the loop spin past the user's cadence.
            const msg = err instanceof Error ? err.message : String(err)
            appendLog(`🔴 独轮车 AI 润色失败，跳过本段：${msg}`)
            const offset = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
            const ok = await abortableSleep(interval * 1000 - offset, signal)
            if (!ok) {
              completed = false
              break
            }
            continue
          }
        } else {
          sendItems = [task.text]
        }

        // Send each result item from this task — typically 1, but
        // can be 2+ when polish lengthened a segment past maxLength.
        // All sub-items share the same `[i+1/total]` label since
        // they're conceptually one "polish unit"; the round counter
        // reflects polish units, not sub-items.
        for (let j = 0; j < sendItems.length; j++) {
          if (signal.aborted) {
            completed = false
            break outer
          }
          if (!sendMsg.value) break outer

          const message = sendItems[j]

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
              break outer
            }
            continue
          }

          // Cross-room emote ID (e.g. `room_1713546334_108382` copied from
          // another streamer's template). B站 would happily echo it back as
          // plain text, surfacing the raw ID in chat — block it instead.
          // Same per-iteration sleep so the round's cadence stays intact.
          if (isUnavailableEmoticon(message)) {
            const skipLabel = total > 1 ? `自动表情 [${i + 1}/${total}]` : '自动表情'
            appendLog(formatUnavailableEmoticonReject(message, skipLabel))
            const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
            const ok = await abortableSleep(interval * 1000 - resolvedRandomInterval, signal)
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

          const resolvedRandomInterval = enableRandomInterval ? Math.floor(Math.random() * 500) : 0
          const ok = await abortableSleep(interval * 1000 - resolvedRandomInterval, signal)
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
