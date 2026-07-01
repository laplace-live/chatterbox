/**
 * Deepgram `SttEngine` — raw WebSocket realtime STT. Key rides the
 * `Sec-WebSocket-Protocol` subprotocol (`['token', key]`), so no auth header and
 * no CORS. Continuous audio keeps the socket alive, so no KeepAlive needed.
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { DEEPGRAM_DEFAULT_MODEL, DEEPGRAM_WS_URL } from '../const'
import { parseDeepgramResult } from './normalize'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

// Silence ms before speech_final; default 10 ms fragments too aggressively.
const ENDPOINTING_MS = '300'

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createDeepgramEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  let aborted = false
  let settled = false
  let paused = false
  let opened = false
  let ws: WebSocket | null = null
  let capture: PcmCapture | null = null

  const stopCapture = (): void => {
    capture?.stop()
    capture = null
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    stopCapture()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (err: unknown): void => {
    if (settled || aborted) return
    settled = true
    stopCapture()
    try {
      ws?.close()
    } catch {
      // closing a socket that never opened can throw
    }
    onEvent({ type: 'error', error: toError(err) })
  }

  const beginAudio = async (): Promise<void> => {
    const cap = await startPcmCapture({
      deviceId: params.audioDeviceId,
      onFrame: frame => {
        // Deepgram takes raw binary PCM16 frames — no base64, no JSON wrapper.
        if (paused || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(frame)
      },
    })
    if (aborted || settled) {
      cap.stop()
      return
    }
    capture = cap
  }

  const handleMessage = (raw: string): void => {
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    const result = parseDeepgramResult(message)
    if (!result) return
    if (result.transcript) {
      onEvent({ type: 'transcript', chunks: [{ text: result.transcript, isFinal: result.isFinal, kind: 'original' }] })
    }
    if (result.speechFinal) onEvent({ type: 'endpoint' })
  }

  const start = (): void => {
    try {
      const url = new URL(DEEPGRAM_WS_URL)
      url.searchParams.set('model', params.model || DEEPGRAM_DEFAULT_MODEL)
      url.searchParams.set('encoding', 'linear16')
      url.searchParams.set('sample_rate', String(PCM_SAMPLE_RATE))
      url.searchParams.set('channels', '1')
      url.searchParams.set('interim_results', 'true')
      url.searchParams.set('smart_format', 'true')
      url.searchParams.set('endpointing', ENDPOINTING_MS)
      const language = params.languageHints[0]
      if (language) url.searchParams.set('language', language)

      // Auth via subprotocol (['token', key]) — no header, no CORS.
      const socket = new WebSocket(url.toString(), ['token', params.apiKey])
      ws = socket

      socket.onopen = () => {
        opened = true
        if (aborted || settled) {
          socket.close()
          return
        }
        onEvent({ type: 'state', state: 'running' })
        onEvent({ type: 'connected' })
        void beginAudio().catch(err => fail(err))
      }
      socket.onmessage = event => {
        if (typeof event.data === 'string') handleMessage(event.data)
      }
      socket.onerror = () => fail(new Error('WebSocket 连接错误'))
      socket.onclose = () => {
        if (aborted || settled) return
        // Never opened ⇒ handshake/auth failure; browser surfaces it only as a close.
        if (!opened) {
          fail(new Error('连接失败，请检查 Deepgram API Key 或网络'))
          return
        }
        finish()
      }
    } catch (err) {
      fail(err)
    }
  }

  const stop = async (): Promise<void> => {
    onEvent({ type: 'state', state: 'stopping' })
    stopCapture()
    // Ask Deepgram to flush any final transcript before we close.
    try {
      ws?.send(JSON.stringify({ type: 'CloseStream' }))
    } catch {}
    try {
      ws?.close()
    } catch {}
  }

  const cancel = (): void => {
    aborted = true
    settled = true
    stopCapture()
    try {
      ws?.close()
    } catch {}
  }

  const pause = (): void => {
    paused = true
  }

  const resume = (): void => {
    paused = false
  }

  const finalize = (): void => {
    try {
      ws?.send(JSON.stringify({ type: 'Finalize' }))
    } catch {}
  }

  return { start, stop, cancel, pause, resume, finalize }
}
