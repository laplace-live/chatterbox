/**
 * Soniox `SttEngine`: owns one lazy-loaded `@soniox/client` `Recording` per
 * session. The `AbortController` tears down an in-flight CDN load if the
 * session is cancelled before the bundle lands.
 */

import type { AudioSource, Recording, SonioxClient } from '@soniox/client'

import type { SttEngine, SttEngineEventHandler, SttFinalizeOptions, SttSessionParams } from './types'

import { loadSoniox } from '../soniox'
import { sonioxResultToChunks } from './normalize'
import { WEB_AUDIO_DEVICE_ID } from './page-audio'
import { PCM_SAMPLE_RATE, type PcmCapture, startPcmCapture } from './pcm-capture'

/** Raw mono 16 kHz, DSP off: Soniox wants untouched audio, and pinning a `deviceId` must not silently re-enable browser echo-cancel/noise-suppress/AGC. */
function buildMicConstraints(deviceId: string): MediaTrackConstraints | undefined {
  if (!deviceId) return undefined
  return {
    deviceId: { exact: deviceId },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: 1,
    sampleRate: 16000,
  }
}

/** Custom Soniox `AudioSource` streaming 16 kHz mono s16le frames from the live-player AudioWorklet. */
function createPageAudioSource(parentSignal: AbortSignal): AudioSource {
  let capture: PcmCapture | null = null
  let sourceAbort: AbortController | null = null
  let paused = false
  let stopped = false

  return {
    async start(handlers) {
      stopped = false
      paused = false
      const ac = new AbortController()
      sourceAbort = ac
      const onParentAbort = () => ac.abort(parentSignal.reason)
      if (parentSignal.aborted) ac.abort(parentSignal.reason)
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        const next = await startPcmCapture({
          deviceId: WEB_AUDIO_DEVICE_ID,
          signal: ac.signal,
          onFrame: frame => {
            if (!paused && !stopped) handlers.onData(frame.buffer)
          },
        })
        if (stopped) {
          next.stop()
          return
        }
        capture = next
      } finally {
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    },
    stop() {
      stopped = true
      sourceAbort?.abort()
      sourceAbort = null
      capture?.stop()
      capture = null
    },
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
  }
}

export function createSonioxEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  const controller = new AbortController()
  let recording: Recording | null = null

  const start = (): void => {
    void loadSoniox()
      .then(Soniox => {
        if (controller.signal.aborted) return

        const client: SonioxClient = new Soniox.SonioxClient({ config: { api_key: params.apiKey } })
        const isPageAudio = params.audioDeviceId === WEB_AUDIO_DEVICE_ID
        const constraints = isPageAudio ? undefined : buildMicConstraints(params.audioDeviceId)
        const source = isPageAudio
          ? createPageAudioSource(controller.signal)
          : constraints
            ? new Soniox.MicrophoneSource({ constraints })
            : undefined

        recording = client.realtime.record({
          model: params.model,
          language_hints: params.languageHints,
          enable_endpoint_detection: true,
          // Range 0-3; level 1 is the mildest speedup. Higher finalizes sooner but can split utterances and lower accuracy.
          endpoint_latency_adjustment_level: 1,
          ...(isPageAudio
            ? {
                audio_format: 'pcm_s16le',
                sample_rate: PCM_SAMPLE_RATE,
                num_channels: 1,
              }
            : {}),
          ...(params.translation
            ? { translation: { type: 'one_way', target_language: params.translation.targetLanguage } }
            : {}),
          ...(source ? { source } : {}),
          session_options: { signal: controller.signal },
        })

        recording.on('state_change', ({ new_state }) => onEvent({ type: 'state', state: new_state }))
        recording.on('result', result => onEvent({ type: 'transcript', chunks: sonioxResultToChunks(result) }))
        recording.on('endpoint', () => onEvent({ type: 'endpoint' }))
        recording.on('error', err => onEvent({ type: 'error', error: err }))
        recording.on('finished', () => onEvent({ type: 'finished' }))
        recording.on('connected', () => onEvent({ type: 'connected' }))
      })
      .catch(err => {
        if (controller.signal.aborted) return
        onEvent({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) })
      })
  }

  const stop = async (): Promise<void> => {
    await recording?.stop()
  }

  const cancel = (): void => {
    recording?.cancel()
    controller.abort()
  }

  const pause = (): void => {
    recording?.pause()
  }

  const resume = (): void => {
    recording?.resume()
  }

  const finalize = (options?: SttFinalizeOptions): void => {
    recording?.finalize(
      options?.trailingSilenceMs !== undefined ? { trailing_silence_ms: options.trailingSilenceMs } : undefined
    )
  }

  return { start, stop, cancel, pause, resume, finalize }
}
