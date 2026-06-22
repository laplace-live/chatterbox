/**
 * ElevenLabs Scribe v2 Realtime `SttEngine` — raw WebSocket implementation.
 *
 * We deliberately DON'T use `@elevenlabs/client`: it bundles `livekit-client`,
 * whose webrtc-adapter shim runs at import time and throws in the bilibili page
 * context, and Scribe realtime is a plain WebSocket that never needs WebRTC.
 * So we speak the documented protocol directly.
 *
 * Flow:
 *   1. Mint a single-use token over HTTP (browsers can't set `xi-api-key` on a
 *      WebSocket, so it rides the `?token=` query param).
 *   2. Open the WS with `model_id`, `audio_format=pcm_16000`,
 *      `commit_strategy=vad` (+ optional `language_code`).
 *   3. On open, capture the mic via the shared PCM pipeline and stream base64
 *      PCM16 `input_audio_chunk` messages.
 *   4. Map server messages onto normalized events: `partial_transcript` → a
 *      non-final chunk; `committed_transcript` → a final chunk then `endpoint`
 *      (VAD-driven); fatal `*_error` → error; socket close → finished.
 *
 * Scribe is transcription-only, so every chunk is 'original' and
 * `params.translation` is ignored. `pause`/`resume` gate chunk sending;
 * `finalize` is a no-op (VAD auto-commits, and the UI doesn't call it).
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { ELEVENLABS_WS_URL } from '../const'
import { int16ToBase64 } from './audio'
import { mintElevenLabsToken } from './elevenlabs-token'
import { elevenLabsTextToChunk, readStringField } from './normalize'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

const DEFAULT_MODEL = 'scribe_v2_realtime'

// Server message types that should end the session. Transient warnings
// (commit_throttled, rate_limited, insufficient_audio_activity, …) are ignored
// so a hiccup doesn't kill a live stream.
const FATAL_MESSAGE_TYPES = new Set([
  'error',
  'auth_error',
  'quota_exceeded',
  'unaccepted_terms',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'transcriber_error',
])

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createElevenLabsEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  let aborted = false
  let settled = false
  let paused = false
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
        if (paused || !ws || ws.readyState !== WebSocket.OPEN) return
        ws.send(
          JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: int16ToBase64(frame),
            sample_rate: PCM_SAMPLE_RATE,
          })
        )
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
    const messageType = readStringField(message, 'message_type')
    if (!messageType) return
    switch (messageType) {
      case 'partial_transcript': {
        const text = readStringField(message, 'text')
        if (text) onEvent({ type: 'transcript', chunks: [elevenLabsTextToChunk(text, false)] })
        break
      }
      case 'committed_transcript': {
        const text = readStringField(message, 'text')
        if (text) {
          onEvent({ type: 'transcript', chunks: [elevenLabsTextToChunk(text, true)] })
          onEvent({ type: 'endpoint' })
        }
        break
      }
      case 'session_started':
      case 'committed_transcript_with_timestamps':
        break
      default: {
        if (FATAL_MESSAGE_TYPES.has(messageType)) {
          const detail = readStringField(message, 'error')
          fail(new Error(detail ? `${messageType}: ${detail}` : messageType))
        }
      }
    }
  }

  const start = (): void => {
    void (async () => {
      try {
        const token = await mintElevenLabsToken(params.apiKey)
        if (aborted || settled) return

        const url = new URL(ELEVENLABS_WS_URL)
        url.searchParams.set('model_id', params.model || DEFAULT_MODEL)
        url.searchParams.set('audio_format', 'pcm_16000')
        url.searchParams.set('commit_strategy', 'vad')
        const languageCode = params.languageHints[0]
        if (languageCode) url.searchParams.set('language_code', languageCode)
        url.searchParams.set('token', token)

        const socket = new WebSocket(url.toString())
        ws = socket

        socket.onopen = () => {
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
        socket.onclose = () => finish()
      } catch (err) {
        fail(err)
      }
    })()
  }

  const stop = async (): Promise<void> => {
    onEvent({ type: 'state', state: 'stopping' })
    stopCapture()
    try {
      ws?.close()
    } catch {
      // ignore
    }
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
