/** Soniox `SttEngine` — direct WebSocket realtime STT/translation over 16 kHz mono PCM16. */

import type { SttEngine, SttEngineEventHandler, SttFinalizeOptions, SttSessionParams } from './types'

import { SONIOX_DEFAULT_MODEL, SONIOX_WS_URL, STT_STOP_TIMEOUT_MS } from '../const'
import { parseSonioxMessage } from './normalize'
import { PCM_FRAME_SAMPLES, PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

const CONNECT_TIMEOUT_MS = 20_000
const KEEPALIVE_INTERVAL_MS = 5000
const STOP_GRACE_MS = STT_STOP_TIMEOUT_MS - 2000
const MAX_PREOPEN_FRAMES = Math.ceil(((CONNECT_TIMEOUT_MS / 1000) * PCM_SAMPLE_RATE) / PCM_FRAME_SAMPLES)

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function createSonioxEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  let settled = false
  let stopping = false
  let started = false
  let paused = false
  let opened = false
  let hasNonFinal = false
  let ws: WebSocket | null = null
  let capture: PcmCapture | null = null
  let connectTimer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null
  const captureAbort = new AbortController()
  const preopenFrames: Int16Array<ArrayBuffer>[] = []

  let resolveStopped: () => void = () => {}
  const stoppedPromise = new Promise<void>(resolve => {
    resolveStopped = resolve
  })

  const stopKeepalive = (): void => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer)
      keepaliveTimer = null
    }
  }

  const syncKeepalive = (): void => {
    if (!opened || !paused || stopping || settled) {
      stopKeepalive()
      return
    }
    if (keepaliveTimer) return
    keepaliveTimer = setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ type: 'keepalive' }))
      } catch {}
    }, KEEPALIVE_INTERVAL_MS)
  }

  const clearTimers = (): void => {
    if (connectTimer) {
      clearTimeout(connectTimer)
      connectTimer = null
    }
    if (stopTimer) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
    stopKeepalive()
  }

  const stopCapture = (): void => {
    captureAbort.abort()
    capture?.stop()
    capture = null
  }

  const cleanup = (): void => {
    clearTimers()
    stopCapture()
    preopenFrames.length = 0
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      try {
        ws.close()
      } catch {}
      ws = null
    }
    resolveStopped()
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

  const handleMessage = (raw: string): void => {
    if (settled) return
    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseSonioxMessage(message)
    if (!parsed) return
    if (parsed.error) {
      fail(new Error(parsed.error))
      return
    }
    if (parsed.chunks.length > 0 || (parsed.hasTokens && hasNonFinal)) {
      hasNonFinal = parsed.chunks.some(c => !c.isFinal)
      onEvent({ type: 'transcript', chunks: parsed.chunks })
    }
    if (parsed.endpoint) {
      onEvent({ type: 'endpoint' })
    }
    if (parsed.finished) {
      finish()
    }
  }

  const openSocket = (): void => {
    connectTimer = setTimeout(() => fail(new Error('Soniox 连接超时')), CONNECT_TIMEOUT_MS)

    try {
      // Auth via subprotocol (['soniox-api-key', key]) — no header, no CORS.
      const socket = new WebSocket(SONIOX_WS_URL, ['soniox-api-key', params.apiKey])
      ws = socket

      socket.onopen = () => {
        if (connectTimer) {
          clearTimeout(connectTimer)
          connectTimer = null
        }
        opened = true
        if (settled || stopping) {
          socket.close()
          return
        }
        socket.send(
          JSON.stringify({
            model: params.model || SONIOX_DEFAULT_MODEL,
            audio_format: 'pcm_s16le',
            sample_rate: PCM_SAMPLE_RATE,
            num_channels: 1,
            language_hints: params.languageHints,
            enable_endpoint_detection: true,
            // Range 0-3; level 1 is the mildest speedup without aggressively splitting utterances.
            endpoint_latency_adjustment_level: 1,
            ...(params.translation
              ? { translation: { type: 'one_way', target_language: params.translation.targetLanguage } }
              : {}),
          })
        )
        for (const frame of preopenFrames.splice(0)) {
          if (!paused) socket.send(frame)
        }
        onEvent({ type: 'state', state: paused ? 'paused' : 'running' })
        onEvent({ type: 'connected' })
        syncKeepalive()
      }
      socket.onmessage = event => {
        if (typeof event.data === 'string') handleMessage(event.data)
      }
      socket.onclose = () => {
        if (settled) return
        if (!opened) {
          fail(new Error('连接失败，请检查 Soniox API Key 或网络'))
          return
        }
        fail(new Error(stopping ? 'Soniox 连接在返回最终结果前关闭' : 'Soniox 连接意外关闭'))
      }
    } catch (err) {
      fail(err)
    }
  }

  const start = (): void => {
    if (started || settled) return
    started = true
    onEvent({ type: 'state', state: 'connecting' })
    void startPcmCapture({
      deviceId: params.audioDeviceId,
      signal: captureAbort.signal,
      onFrame: frame => {
        if (settled || stopping || paused) return
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(frame)
          return
        }
        preopenFrames.push(frame)
        if (preopenFrames.length > MAX_PREOPEN_FRAMES) preopenFrames.shift()
      },
    })
      .then(cap => {
        if (settled || stopping) {
          cap.stop()
          return
        }
        capture = cap
        openSocket()
      })
      .catch(err => {
        if (!stopping && !settled) fail(err)
      })
  }

  const finalize = (options?: SttFinalizeOptions): void => {
    if (settled || !opened || !ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'finalize', trailing_silence_ms: options?.trailingSilenceMs }))
    } catch {}
  }

  const stop = async (): Promise<void> => {
    if (settled) return
    if (stopping) return stoppedPromise
    stopping = true
    onEvent({ type: 'state', state: 'stopping' })
    clearTimers()
    stopCapture()
    if (!opened || !ws || ws.readyState !== WebSocket.OPEN) {
      finish()
      return
    }
    try {
      // Empty text frame signals graceful EOF; Soniox flushes final tokens and replies `{ finished: true }`.
      ws.send('')
    } catch (err) {
      fail(err)
      return
    }
    stopTimer = setTimeout(() => fail(new Error('等待 Soniox 最终结果超时')), STOP_GRACE_MS)
    return stoppedPromise
  }

  const cancel = (): void => {
    if (settled) return
    settled = true
    cleanup()
  }

  const pause = (): void => {
    if (settled || stopping || paused) return
    paused = true
    finalize()
    syncKeepalive()
    if (opened) onEvent({ type: 'state', state: 'paused' })
  }

  const resume = (): void => {
    if (settled || stopping || !paused) return
    paused = false
    syncKeepalive()
    if (opened) onEvent({ type: 'state', state: 'running' })
  }

  return { start, stop, cancel, pause, resume, finalize }
}
