/**
 * Deepgram `SttEngine` — raw WebSocket realtime STT.
 *
 * The simplest of the three providers to authenticate: the API key rides the
 * `Sec-WebSocket-Protocol` subprotocol (`['token', key]`), the browser-blessed
 * way to pass it without an `Authorization` header — so no token mint and no
 * CORS (like Soniox putting the key in the URL).
 *
 * Flow:
 *   1. Open `wss://api.deepgram.com/v1/listen?model=&language=&encoding=linear16
 *      &sample_rate=16000&channels=1&interim_results=true&smart_format=true&
 *      endpointing=300`, authenticating via the subprotocol.
 *   2. On open, capture the mic via the shared PCM pipeline and stream the raw
 *      Int16 PCM frames as binary WebSocket messages (Deepgram wants raw bytes,
 *      not base64).
 *   3. Map `Results` messages: interim → non-final chunk, `is_final` → final
 *      chunk, `speech_final` → `endpoint`.
 *
 * Continuous audio (including silence) keeps the socket alive, so no KeepAlive
 * is needed. `pause`/`resume` gate sending; `finalize` sends `Finalize`.
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { DEEPGRAM_WS_URL } from '../const'
import { parseDeepgramResult } from './normalize'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

const DEFAULT_MODEL = 'nova-3'
// Milliseconds of silence before Deepgram finalizes an utterance (speech_final).
// Deepgram's default (10 ms) fragments aggressively; 300 ms gives utterance-ish
// boundaries that map better to one danmaku per phrase.
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
      // closing a socket that never opened can throw — nothing to do
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
      url.searchParams.set('model', params.model || DEFAULT_MODEL)
      url.searchParams.set('encoding', 'linear16')
      url.searchParams.set('sample_rate', String(PCM_SAMPLE_RATE))
      url.searchParams.set('channels', '1')
      url.searchParams.set('interim_results', 'true')
      url.searchParams.set('smart_format', 'true')
      url.searchParams.set('endpointing', ENDPOINTING_MS)
      const language = params.languageHints[0]
      if (language) url.searchParams.set('language', language)

      // Browser auth: the key rides the Sec-WebSocket-Protocol subprotocol
      // (['token', key]) — no Authorization header, no CORS, no token mint.
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
        // Never opened ⇒ handshake/auth failure (Deepgram rejects the upgrade
        // when the subprotocol key is invalid), which the browser surfaces only
        // as a close. Surface a useful hint rather than a silent "stopped".
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
    } catch {
      // ignore
    }
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

  const finalize = (): void => {
    try {
      ws?.send(JSON.stringify({ type: 'Finalize' }))
    } catch {
      // ignore
    }
  }

  return { start, stop, cancel, pause, resume, finalize }
}
