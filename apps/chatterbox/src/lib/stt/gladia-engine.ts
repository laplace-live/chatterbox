/** Gladia live transcription and translation share one WebSocket session. */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { GLADIA_DEFAULT_MODEL, STT_STOP_TIMEOUT_MS } from '../const'
import { int16ToBase64 } from './audio'
import { initGladiaSession } from './gladia-session'
import { parseGladiaResult, readField, readStringField } from './normalize'
import { type PcmCapture, startPcmCapture } from './pcm-capture'

const STOP_GRACE_MS = STT_STOP_TIMEOUT_MS - 2000

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createGladiaEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  let settled = false
  let stopping = false
  let started = false
  let paused = false
  let opened = false
  let ws: WebSocket | null = null
  let capture: PcmCapture | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  const controller = new AbortController()
  const translatedIds = new Set<string>()

  const stopCapture = (): void => {
    capture?.stop()
    capture = null
  }

  const cleanup = (): void => {
    stopCapture()
    controller.abort()
    if (stopTimer) clearTimeout(stopTimer)
    stopTimer = null
    try {
      ws?.close()
    } catch {}
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    cleanup()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (err: unknown): void => {
    if (settled) return
    settled = true
    cleanup()
    onEvent({ type: 'error', error: toError(err) })
  }

  const beginAudio = async (): Promise<void> => {
    const cap = await startPcmCapture({
      deviceId: params.audioDeviceId,
      onFrame: frame => {
        if (settled || stopping || paused || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'audio_chunk', data: { chunk: int16ToBase64(frame) } }))
      },
    })
    if (settled || stopping) {
      cap.stop()
      return
    }
    capture = cap
  }

  const handleMessage = (raw: string): void => {
    if (settled) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    const type = readStringField(message, 'type')
    const error = readField(message, 'error')
    if (error != null || type === 'error') {
      fail(new Error(readStringField(error, 'message') ?? readStringField(message, 'message') ?? 'Gladia 处理失败'))
      return
    }
    if (type === 'end_session') {
      finish()
      return
    }
    if (type === 'translation') {
      if (!params.translation) return
      const data = readField(message, 'data')
      const translated = readField(data, 'translated_utterance')
      const text = readStringField(translated, 'text')
      const language = readStringField(translated, 'language') ?? readStringField(data, 'target_language')
      if (text === undefined || (language && language !== params.translation.targetLanguage)) return
      const id = readStringField(data, 'utterance_id')
      if (id && translatedIds.has(id)) return
      if (id) translatedIds.add(id)
      const segment = text && !/\s$/.test(text) ? `${text} ` : text
      onEvent({ type: 'transcript', chunks: [{ text: segment, isFinal: true, kind: 'translation' }] })
      onEvent({ type: 'endpoint' })
      return
    }
    const result = parseGladiaResult(message)
    if (!result) return
    onEvent({ type: 'transcript', chunks: [{ text: result.transcript, isFinal: result.isFinal, kind: 'original' }] })
    if (result.isFinal && !params.translation) onEvent({ type: 'endpoint' })
  }

  const start = (): void => {
    if (started || settled) return
    started = true
    void (async () => {
      try {
        const url = await initGladiaSession({
          apiKey: params.apiKey,
          model: params.model || GLADIA_DEFAULT_MODEL,
          languages: params.languageHints,
          translation: params.translation,
          signal: controller.signal,
        })
        if (settled) return

        const socket = new WebSocket(url)
        ws = socket
        socket.onopen = () => {
          opened = true
          if (settled) {
            socket.close()
            return
          }
          onEvent({ type: 'state', state: 'running' })
          onEvent({ type: 'connected' })
          void beginAudio().catch(fail)
        }
        socket.onmessage = event => {
          if (typeof event.data === 'string') handleMessage(event.data)
        }
        socket.onerror = () => fail(new Error('WebSocket 连接错误'))
        socket.onclose = event => {
          if (settled) return
          if (!opened) fail(new Error('连接失败，请检查 Gladia API Key 或网络'))
          else if (event.code === 1000) finish()
          else fail(new Error('Gladia 连接意外关闭'))
        }
      } catch (err) {
        fail(err)
      }
    })()
  }

  const stop = async (): Promise<void> => {
    if (settled || stopping) return
    stopping = true
    onEvent({ type: 'state', state: 'stopping' })
    stopCapture()
    if (!opened) {
      finish()
      return
    }
    try {
      ws?.send(JSON.stringify({ type: 'stop_recording' }))
    } catch (err) {
      fail(err)
      return
    }
    // Translation can arrive after end_recording; only end_session closes the stream.
    stopTimer = setTimeout(() => fail(new Error('等待 Gladia 最终结果超时')), STOP_GRACE_MS)
  }

  const cancel = (): void => {
    if (settled) return
    settled = true
    cleanup()
  }

  const pause = (): void => {
    paused = true
  }

  const resume = (): void => {
    paused = false
  }

  const finalize = (): void => {}

  return { start, stop, cancel, pause, resume, finalize }
}
