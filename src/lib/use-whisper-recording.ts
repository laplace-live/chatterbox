/**
 * Preact-native wrapper around the v2 in-browser Whisper engine.
 *
 * Mirrors the *shape* of `useSonioxRecording` (same lifecycle
 * states, same start/stop/cancel surface) so `stt-tab.tsx` can
 * branch on the active engine with minimal divergent code.
 *
 * **Semantic differences vs. Soniox / vs. v1 Whisper:**
 *
 * - **Append-only segments.** v2 Whisper commits one ~3 s chunk
 *   per pass. Each `onSegment` event carries a fresh chunk's
 *   transcription — consumers should append, not replace.
 *   (v1 emitted full 30 s re-transcriptions every pass, which is
 *   what we're moving away from.)
 *
 * - **No per-token streaming.** Whisper does emit per-token
 *   intermediate text, but dogfood measurements showed users
 *   couldn't read sub-100 ms text changes — perceived as
 *   "flashing". The worker now skips TextStreamer entirely and
 *   posts one event per completed pass.
 *
 * - **No translation.** Whisper-base supports `task: 'translate'`
 *   to English only; not exposed by product decision.
 *
 * Cleanup on unmount is unconditional: we stop the engine but
 * leave the (singleton) worker alive so the next mount resumes
 * without re-downloading the model.
 */

import { type Signal, signal } from '@preact/signals'
import { useEffect, useMemo, useRef } from 'preact/hooks'

import {
  isWebGpuAvailable,
  startWhisperEngine,
  type WhisperEngine,
  type WhisperLanguage,
  type WhisperModelKey,
  type WhisperProgress,
  type WhisperState,
} from './whisper'

export type { WhisperLanguage, WhisperModelKey, WhisperState }

export interface UseWhisperRecordingConfig {
  language: WhisperLanguage
  /** Optional microphone deviceId. Empty = system default. */
  deviceId?: string
  /** Which Whisper model to load. Defaults to the engine's default
   *  (currently `turbo-hq`). Changing across sessions terminates the
   *  warm worker so the new model actually takes effect. */
  model?: WhisperModelKey
  /** Per-file download progress during model load. */
  onLoadProgress?: (p: WhisperProgress) => void
  /** High-level loading status strings (载入模型 / 编译着色器 / …). */
  onLoadStatus?: (message: string) => void
  /** Worker is warm and ready to transcribe. */
  onReady?: () => void
  /**
   * Fired exactly once per committed pass with the decoded text
   * for a fresh ~3 s of audio. Append to your transcript log;
   * **do not replace** — successive events carry new audio, not
   * a revised view of the same audio.
   *
   * `elapsedMs` is the worker's measured GPU + decode time for
   * the pass, useful for surfacing "model is keeping up" / "model
   * is falling behind" telemetry to the UI.
   */
  onSegment?: (text: string, elapsedMs: number) => void
  /**
   * Fired when Silero VAD rejects a chunk as non-speech (music,
   * silence, crowd noise). No transcription was attempted —
   * useful for surfacing a "🎵 跳过" hint so the user knows the
   * mic is still live, just nothing speech-like is happening.
   */
  onVadSkipped?: (speechProb: number, elapsedMs: number) => void
  onError?: (err: Error) => void
  /**
   * Silero VAD gate. When `enabled`, each rolling audio chunk
   * runs through Silero before Whisper. Changes propagate live —
   * toggling at runtime takes effect on the next pass without
   * restarting the engine.
   */
  vad?: { enabled: boolean; threshold: number }
}

export interface UseWhisperRecordingReturn {
  state: Signal<WhisperState>
  isActive: Signal<boolean>
  start: () => void
  stop: () => Promise<void>
  cancel: () => void
}

const NON_RUNNING_STATES = new Set<WhisperState>(['idle', 'stopped', 'error'])

export function useWhisperRecording(config: UseWhisperRecordingConfig): UseWhisperRecordingReturn {
  const state = useMemo<Signal<WhisperState>>(() => signal<WhisperState>('idle'), [])
  const isActive = useMemo<Signal<boolean>>(() => signal(false), [])

  // Refs so worker callbacks (which fire over the lifetime of the
  // engine, well past the current render) read the freshest props.
  const configRef = useRef(config)
  configRef.current = config

  const engineRef = useRef<WhisperEngine | null>(null)

  const updateState = (next: WhisperState) => {
    state.value = next
    isActive.value = !NON_RUNNING_STATES.has(next)
  }

  const start = (): void => {
    if (!isWebGpuAvailable()) {
      const err = new Error('当前浏览器不支持 WebGPU')
      updateState('error')
      configRef.current.onError?.(err)
      return
    }
    if (engineRef.current) {
      // Already started — no-op rather than re-spawning, which
      // would race the mic acquisition.
      return
    }

    updateState('loading')

    void startWhisperEngine(
      {
        language: configRef.current.language,
        deviceId: configRef.current.deviceId,
        model: configRef.current.model,
        vad: configRef.current.vad,
      },
      {
        onLoadProgress: p => {
          configRef.current.onLoadProgress?.(p)
        },
        onLoadStatus: msg => {
          configRef.current.onLoadStatus?.(msg)
        },
        onReady: () => {
          // 'starting' = "model warm, waiting for first segment".
          // We flip to 'running' on the first onSegment so the UI
          // can show a different status during the initial silence
          // / model-warm-up gap.
          updateState('starting')
          configRef.current.onReady?.()
        },
        onSegment: (text, elapsedMs) => {
          if (state.value === 'starting') updateState('running')
          configRef.current.onSegment?.(text, elapsedMs)
        },
        onVadSkipped: (speechProb, elapsedMs) => {
          configRef.current.onVadSkipped?.(speechProb, elapsedMs)
        },
        onError: err => {
          updateState('error')
          configRef.current.onError?.(err)
        },
      }
    )
      .then(engine => {
        engineRef.current = engine
      })
      .catch(err => {
        const error = err instanceof Error ? err : new Error(String(err))
        updateState('error')
        configRef.current.onError?.(error)
      })
  }

  const stop = async (): Promise<void> => {
    const engine = engineRef.current
    if (!engine) {
      if (state.value !== 'idle' && state.value !== 'stopped') updateState('stopped')
      return
    }
    updateState('stopping')
    engineRef.current = null
    await engine.stop()
    updateState('stopped')
  }

  const cancel = (): void => {
    const engine = engineRef.current
    engineRef.current = null
    if (engine) {
      void engine.stop()
    }
    updateState('stopped')
  }

  // Push language changes through to a live engine without
  // restarting — Whisper's `language` is a per-pass parameter,
  // not a session-level config, so this is free.
  useEffect(() => {
    engineRef.current?.setLanguage(config.language)
  }, [config.language])

  // Same story for the VAD gate: `vad` is read per pass inside
  // the engine, so flipping it (or sliding the threshold) takes
  // effect on the very next chunk with no model reload.
  useEffect(() => {
    if (config.vad) engineRef.current?.setVad(config.vad)
  }, [config.vad?.enabled, config.vad?.threshold])

  useEffect(() => {
    return () => {
      const engine = engineRef.current
      engineRef.current = null
      if (engine) void engine.stop()
    }
  }, [])

  return { state, isActive, start, stop, cancel }
}
