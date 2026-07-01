/**
 * Gladia realtime `SttEngine` — raw WebSocket. Needs a one-shot HTTP init
 * (`gladia-session.ts`) for a per-session WS URL; audio rides as base64 in JSON
 * `audio_chunk` messages. Transcription-only: every chunk is 'original';
 * `finalize` is a no-op since silence endpointing auto-commits.
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { GLADIA_DEFAULT_MODEL } from '../const'
import { int16ToBase64 } from './audio'
import { initGladiaSession } from './gladia-session'
import { parseGladiaResult } from './normalize'
import { type PcmCapture, startPcmCapture } from './pcm-capture'

// Force-close if Gladia's own close never arrives after `stop_recording`.
const STOP_GRACE_MS = 2000

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createGladiaEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
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
        if (paused || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'audio_chunk', data: { chunk: int16ToBase64(frame) } }))
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
    const result = parseGladiaResult(message)
    if (!result) return
    onEvent({ type: 'transcript', chunks: [{ text: result.transcript, isFinal: result.isFinal, kind: 'original' }] })
    if (result.isFinal) onEvent({ type: 'endpoint' })
  }

  const start = (): void => {
    void (async () => {
      try {
        const url = await initGladiaSession({
          apiKey: params.apiKey,
          model: params.model || GLADIA_DEFAULT_MODEL,
          languages: params.languageHints,
        })
        if (aborted || settled) return

        const socket = new WebSocket(url)
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
          // Never opened ⇒ session URL rejected (expired/invalid token).
          if (!opened) {
            fail(new Error('连接失败，请检查 Gladia API Key 或网络'))
            return
          }
          finish()
        }
      } catch (err) {
        fail(err)
      }
    })()
  }

  const stop = async (): Promise<void> => {
    onEvent({ type: 'state', state: 'stopping' })
    stopCapture()
    // Flush Gladia's last transcript, then let it close the socket.
    try {
      ws?.send(JSON.stringify({ type: 'stop_recording' }))
    } catch {}
    const socket = ws
    setTimeout(() => {
      try {
        socket?.close()
      } catch {}
    }, STOP_GRACE_MS)
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

  const finalize = (): void => {}

  return { start, stop, cancel, pause, resume, finalize }
}
