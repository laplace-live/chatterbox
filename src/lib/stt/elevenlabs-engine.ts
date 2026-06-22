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
 *   3. On open, capture the mic through an AudioContext pinned to 16 kHz and a
 *      ScriptProcessor (no AudioWorklet blob → no CSP surprises on the host
 *      page), and stream base64 PCM16 `input_audio_chunk` messages.
 *   4. Map server messages onto normalized events:
 *      - `partial_transcript`   → a non-final original chunk
 *      - `committed_transcript` → a final original chunk, then `endpoint`
 *        (VAD decides the boundary)
 *      - fatal `*_error`        → error
 *      - socket close           → finished
 *
 * Scribe is transcription-only (no translation), so every chunk is 'original'
 * and `params.translation` is ignored. `pause`/`resume` gate chunk sending;
 * `finalize` is a no-op (VAD auto-commits, and the UI doesn't call it).
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { ELEVENLABS_WS_URL } from '../const'
import { floatTo16, int16ToBase64 } from './audio'
import { mintElevenLabsToken } from './elevenlabs-token'
import { elevenLabsTextToChunk, readStringField } from './normalize'

const DEFAULT_MODEL = 'scribe_v2_realtime'
const TARGET_SAMPLE_RATE = 16000
// 4096 frames ≈ 256 ms at 16 kHz — a good latency/overhead balance, and a
// valid ScriptProcessor buffer size.
const SCRIPT_PROCESSOR_BUFFER = 4096

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
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let zeroGain: GainNode | null = null

  const stopAudio = (): void => {
    if (processor) processor.onaudioprocess = null
    processor?.disconnect()
    sourceNode?.disconnect()
    zeroGain?.disconnect()
    processor = null
    sourceNode = null
    zeroGain = null
    for (const track of mediaStream?.getTracks() ?? []) track.stop()
    mediaStream = null
    void audioContext?.close().catch(() => {})
    audioContext = null
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    stopAudio()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (err: unknown): void => {
    if (settled || aborted) return
    settled = true
    stopAudio()
    try {
      ws?.close()
    } catch {
      // closing a socket that never opened can throw — nothing to do
    }
    onEvent({ type: 'error', error: toError(err) })
  }

  const startAudioCapture = async (): Promise<void> => {
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(params.audioDeviceId ? { deviceId: { exact: params.audioDeviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    if (aborted || settled) {
      for (const track of stream.getTracks()) track.stop()
      return
    }
    mediaStream = stream
    // Pinning the context to 16 kHz makes the browser resample the mic input
    // for us, so the ScriptProcessor frames are already at the rate Scribe
    // expects.
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
    audioContext = context
    sourceNode = context.createMediaStreamSource(stream)
    processor = context.createScriptProcessor(SCRIPT_PROCESSOR_BUFFER, 1, 1)
    // A muted sink: ScriptProcessor only fires while connected to a
    // destination, and routing through a zero gain avoids playing the mic back.
    zeroGain = context.createGain()
    zeroGain.gain.value = 0
    processor.onaudioprocess = event => {
      if (paused || !ws || ws.readyState !== WebSocket.OPEN) return
      const samples = event.inputBuffer.getChannelData(0)
      ws.send(
        JSON.stringify({
          message_type: 'input_audio_chunk',
          audio_base_64: int16ToBase64(floatTo16(samples)),
          sample_rate: TARGET_SAMPLE_RATE,
        })
      )
    }
    sourceNode.connect(processor)
    processor.connect(zeroGain)
    zeroGain.connect(context.destination)
    // A context created several awaits after the click gesture can start
    // suspended under the autoplay policy, which would stop the
    // ScriptProcessor from firing. Resume it; harmless if already running.
    void context.resume().catch(() => {})
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
        // session_started carries no transcript; the timestamped variant is
        // only sent when include_timestamps is set, which we don't request.
        break
      default: {
        if (FATAL_MESSAGE_TYPES.has(messageType)) {
          const detail = readStringField(message, 'error')
          fail(new Error(detail ? `${messageType}: ${detail}` : messageType))
        }
        // Non-fatal messages (transient warnings) are ignored.
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
          void startAudioCapture().catch(err => fail(err))
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
    // Stop sending audio; closing the socket lets any final committed
    // transcript still in flight arrive before onclose → finish().
    stopAudio()
    try {
      ws?.close()
    } catch {
      // ignore
    }
  }

  const cancel = (): void => {
    aborted = true
    settled = true
    stopAudio()
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

  // VAD commits automatically and the STT tab never calls finalize, so there's
  // nothing to force here.
  const finalize = (): void => {}

  return { start, stop, cancel, pause, resume, finalize }
}
