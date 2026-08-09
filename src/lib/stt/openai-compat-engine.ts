/**
 * OpenAI-compatible batch STT engine (self-hosted Whisper, Groq, OpenAI…).
 *
 * There is no streaming here: a VAD segmenter cuts the capture on silence and
 * each segment is uploaded as a WAV, one request in flight so transcripts can't
 * land out of order. Every chunk is therefore final — the tab shows nothing
 * between segments.
 */

import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { STT_STOP_TIMEOUT_MS } from '../const'
import { isWhisperHallucination } from './normalize'
import { transcribeSegment } from './openai-compat-transcribe'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'
import { createVadSegmenter } from './vad-segmenter'

/** Backlog bound: a server that can't keep up drops old audio rather than growing lag forever. */
const MAX_PENDING_SEGMENTS = 4
/** HTTP failures tolerated in a row before the session gives up. */
const MAX_CONSECUTIVE_FAILURES = 3
/** How long `stop()` waits for queued segments so the last words still land; derived to stay under the tab's force-cancel. */
const DRAIN_TIMEOUT_MS = STT_STOP_TIMEOUT_MS - 2_000
const DRAIN_POLL_MS = 100

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export function createOpenAiCompatEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  // The tab gates start on a non-empty base URL; missing here is a plumbing bug — fail loudly, never default silently.
  const baseUrl = params.baseUrl ?? ''
  let capture: PcmCapture | null = null
  let settled = false
  let stopping = false
  let paused = false
  let processing = false
  let inflightAbort: (() => void) | null = null
  let consecutiveFailures = 0
  const queue: Int16Array[] = []

  const stopCapture = (): void => {
    capture?.stop()
    capture = null
  }

  const finish = (): void => {
    if (settled) return
    settled = true
    stopCapture()
    inflightAbort?.()
    onEvent({ type: 'state', state: 'stopped' })
    onEvent({ type: 'finished' })
  }

  const fail = (err: unknown): void => {
    if (settled) return
    settled = true
    stopCapture()
    queue.length = 0
    inflightAbort?.()
    onEvent({ type: 'error', error: toError(err) })
  }

  const pump = async (): Promise<void> => {
    if (processing || settled) return
    const segment = queue.shift()
    if (!segment) return

    processing = true
    try {
      const request = transcribeSegment({
        baseUrl,
        apiKey: params.apiKey,
        model: params.model,
        language: params.languageHints[0] ?? '',
        samples: segment,
        sampleRate: PCM_SAMPLE_RATE,
      })
      inflightAbort = request.abort
      const result = await request.promise
      if (settled) return

      if (result.ok) {
        consecutiveFailures = 0
        // Collapse whisper.cpp's '\n' joins, but keep Whisper's leading space so consecutive English finals don't glue in the buffer.
        const text = result.text.replace(/\s+/g, ' ').trimEnd()
        if (text && !isWhisperHallucination(text)) {
          onEvent({ type: 'transcript', chunks: [{ text, isFinal: true, kind: 'original' }] })
          onEvent({ type: 'endpoint' })
        }
      } else if (result.unreachable) {
        fail(new Error(result.message))
        return
      } else {
        consecutiveFailures++
        console.warn('[chatterbox] 语音识别请求失败:', result.message)
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          fail(new Error(`语音识别连续失败 ${MAX_CONSECUTIVE_FAILURES} 次：${result.message}`))
          return
        }
      }
    } catch (err) {
      fail(err)
      return
    } finally {
      inflightAbort = null
      processing = false
    }
    void pump()
  }

  const segmenter = createVadSegmenter({
    sampleRate: PCM_SAMPLE_RATE,
    onSegment: segment => {
      if (settled) return
      queue.push(segment)
      while (queue.length > MAX_PENDING_SEGMENTS) {
        queue.shift()
        console.warn('[chatterbox] 语音识别积压，已丢弃最早的语音片段')
      }
      void pump()
    },
  })

  const start = (): void => {
    if (!baseUrl) {
      fail(new Error('未配置服务地址'))
      return
    }
    onEvent({ type: 'state', state: 'connecting' })
    startPcmCapture({
      deviceId: params.audioDeviceId,
      onFrame: frame => {
        if (paused || settled) return
        segmenter.push(frame)
      },
    })
      .then(cap => {
        // Mic permission can resolve after stop() was pressed; don't flip back to 'recording'.
        if (settled || stopping) {
          cap.stop()
          return
        }
        capture = cap
        onEvent({ type: 'connected' })
        onEvent({ type: 'state', state: 'recording' })
      })
      .catch(err => fail(err))
  }

  const stop = async (): Promise<void> => {
    if (settled) return
    stopping = true
    onEvent({ type: 'state', state: 'stopping' })
    stopCapture()
    // Flush the open segment, then let the queue drain so the last sentence isn't lost.
    segmenter.flush()
    void pump()
    // Wall-clock deadline: background tabs clamp timers to ≥1 s, which would stretch a poll-counted budget past the watchdog.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (!settled && (processing || queue.length > 0) && Date.now() < deadline) {
      await delay(DRAIN_POLL_MS)
    }
    finish()
  }

  const cancel = (): void => {
    settled = true
    queue.length = 0
    stopCapture()
    inflightAbort?.()
  }

  const pause = (): void => {
    paused = true
  }

  const resume = (): void => {
    paused = false
  }

  const finalize = (): void => {
    segmenter.flush()
    void pump()
  }

  return { start, stop, cancel, pause, resume, finalize }
}
