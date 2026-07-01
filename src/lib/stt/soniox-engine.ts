/**
 * Soniox `SttEngine`: owns one lazy-loaded `@soniox/client` `Recording` per
 * session. The `AbortController` tears down an in-flight CDN load if the
 * session is cancelled before the bundle lands.
 */

import type { Recording, SonioxClient } from '@soniox/client'

import type { SttEngine, SttEngineEventHandler, SttFinalizeOptions, SttSessionParams } from './types'

import { loadSoniox } from '../soniox'
import { sonioxResultToChunks } from './normalize'

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

export function createSonioxEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  const controller = new AbortController()
  let recording: Recording | null = null

  const start = (): void => {
    void loadSoniox()
      .then(Soniox => {
        // The session may have been cancelled while the CDN bundle loaded.
        if (controller.signal.aborted) return

        const client: SonioxClient = new Soniox.SonioxClient({ config: { api_key: params.apiKey } })
        const constraints = buildMicConstraints(params.audioDeviceId)
        const source = constraints ? new Soniox.MicrophoneSource({ constraints }) : undefined

        recording = client.realtime.record({
          model: params.model,
          language_hints: params.languageHints,
          enable_endpoint_detection: true,
          // Range 0-3; level 1 is the mildest speedup. Higher finalizes sooner but can split utterances and lower accuracy.
          endpoint_latency_adjustment_level: 1,
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
