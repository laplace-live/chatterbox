/**
 * Gladia realtime `SttEngine` — raw WebSocket implementation.
 *
 * Gladia's realtime flow needs a one-shot HTTP init before the socket (see
 * `gladia-session.ts`): POST the audio config, get back a per-session WebSocket
 * URL with an embedded token, then stream audio to it. Like ElevenLabs (and
 * unlike Deepgram's raw-binary protocol) audio rides as base64 inside JSON
 * `audio_chunk` messages, so we reuse the shared PCM pipeline + `int16ToBase64`.
 *
 * Flow:
 *   1. `POST /v2/live` → a session WebSocket URL (token embedded).
 *   2. Open the WS.
 *   3. On open, capture the mic via the shared PCM pipeline and stream base64
 *      PCM16 `audio_chunk` messages.
 *   4. Map `transcript` messages: non-final → a non-final chunk; final → a final
 *      chunk then `endpoint` (Gladia finalizes per its silence endpointing).
 *   5. `stop` sends `stop_recording` and lets Gladia flush its last transcript
 *      and close; a short fallback force-closes so a missing close can't hang.
 *
 * Gladia realtime is transcription-only here, so every chunk is 'original' and
 * `params.translation` is ignored. `pause`/`resume` gate sending; `finalize` is
 * a no-op (endpointing auto-commits, and the UI doesn't call it).
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { GLADIA_DEFAULT_MODEL } from '../const'
import { int16ToBase64 } from './audio'
import { initGladiaSession } from './gladia-session'
import { parseGladiaResult } from './normalize'
import { type PcmCapture, startPcmCapture } from './pcm-capture'

// After `stop_recording`, Gladia flushes a final transcript and closes the
// socket itself; force-close after this long if that close never arrives.
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
      // closing a socket that never opened can throw — nothing to do
    }
    onEvent({ type: 'error', error: toError(err) })
  }

  const beginAudio = async (): Promise<void> => {
    const cap = await startPcmCapture({
      deviceId: params.audioDeviceId,
      onFrame: frame => {
        // Gladia takes base64 PCM16 wrapped in a JSON `audio_chunk` (like ElevenLabs).
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
          // Never opened ⇒ the session URL was rejected (expired/invalid token);
          // surface a hint rather than a silent "stopped".
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
    // Ask Gladia to flush the last transcript, then let it close the socket.
    try {
      ws?.send(JSON.stringify({ type: 'stop_recording' }))
    } catch {
      // ignore
    }
    const socket = ws
    setTimeout(() => {
      try {
        socket?.close()
      } catch {
        // ignore
      }
    }, STOP_GRACE_MS)
  }

  const cancel = (): void => {
    aborted = true
    settled = true
    stopCapture()
    try {
      ws?.close()
    } catch {
      // ignore
    }
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
