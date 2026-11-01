/**
 * Preact-native multi-provider STT recording hook: shared state/callback/teardown shell
 * around per-provider engines, snapshotting `params` per `start()` and reading callbacks via ref.
 */

import { type Signal, signal } from '@preact/signals'
import { useEffect, useMemo, useRef } from 'preact/hooks'

import type {
  SttChunk,
  SttEngine,
  SttEngineFactory,
  SttFinalizeOptions,
  SttProvider,
  SttRecordingState,
  SttSessionParams,
} from './stt/types'

import { ELEVENLABS_TRANSLATION_MODE } from './const'
import { createDeepgramEngine } from './stt/deepgram-engine'
import { createElevenLabsEngine } from './stt/elevenlabs-engine'
import { createElevenLabsTranslationEngine } from './stt/elevenlabs-translation-engine'
import { createGeminiEngine } from './stt/gemini-engine'
import { createGladiaEngine } from './stt/gladia-engine'
import { createOpenAiCompatEngine } from './stt/openai-compat-engine'
import { createOpenAiTranslationEngine } from './stt/openai-translation-engine'
import { createSonioxEngine } from './stt/soniox-engine'

export interface UseSttRecordingConfig {
  provider: SttProvider
  /** Snapshotted at `start()` time, not at hook mount. */
  params: SttSessionParams
  /** Fired for every transcript frame (partial + final chunks). */
  onTranscript?: (chunks: SttChunk[]) => void
  /** Fired when the provider signals an utterance endpoint. */
  onEndpoint?: () => void
  /** Fired on any error (audio capture, network, server, token mint). */
  onError?: (err: Error) => void
  /** Fired when the session has finished and the socket closed. */
  onFinished?: () => void
  /** Fired when the realtime connection opens. */
  onConnected?: () => void
}

export interface UseSttRecordingReturn {
  /** Reactive recording lifecycle state. */
  state: Signal<SttRecordingState>
  /** `true` whenever a session is in any non-terminal state. */
  isActive: Signal<boolean>
  start: () => void
  stop: () => Promise<void>
  cancel: () => void
  pause: () => void
  resume: () => void
  finalize: (options?: SttFinalizeOptions) => void
}

const TERMINAL_STATES = new Set<SttRecordingState>(['idle', 'stopped', 'canceled', 'error'])

const ENGINE_FACTORIES: Record<SttProvider, SttEngineFactory> = {
  soniox: createSonioxEngine,
  elevenlabs: (params, onEvent) =>
    params.model === ELEVENLABS_TRANSLATION_MODE
      ? createElevenLabsTranslationEngine(params, onEvent)
      : createElevenLabsEngine(params, onEvent),
  deepgram: createDeepgramEngine,
  gladia: createGladiaEngine,
  gemini: createGeminiEngine,
  openai: createOpenAiTranslationEngine,
  'openai-compat': createOpenAiCompatEngine,
}

export function useSttRecording(config: UseSttRecordingConfig): UseSttRecordingReturn {
  const state = useMemo<Signal<SttRecordingState>>(() => signal<SttRecordingState>('idle'), [])
  const isActive = useMemo<Signal<boolean>>(() => signal(false), [])

  // Latest callbacks/params without rebinding engine listeners each render.
  const configRef = useRef(config)
  configRef.current = config

  const engineRef = useRef<SttEngine | null>(null)
  // Bumped on start/cancel/unmount so late events from a superseded engine are dropped.
  const generationRef = useRef(0)

  const updateState = (next: SttRecordingState): void => {
    state.value = next
    isActive.value = !TERMINAL_STATES.has(next)
  }

  const start = (): void => {
    // Tear down any in-flight session first (impatient double-click / restart).
    engineRef.current?.cancel()
    engineRef.current = null
    const generation = ++generationRef.current

    // Optimistic transition for UI feedback until engine state events take over.
    updateState('starting')

    const cfg = configRef.current
    const engine = ENGINE_FACTORIES[cfg.provider](cfg.params, event => {
      if (generationRef.current !== generation) return
      switch (event.type) {
        case 'state':
          updateState(event.state)
          break
        case 'transcript':
          configRef.current.onTranscript?.(event.chunks)
          break
        case 'endpoint':
          configRef.current.onEndpoint?.()
          break
        case 'connected':
          configRef.current.onConnected?.()
          break
        case 'finished':
          configRef.current.onFinished?.()
          break
        case 'error':
          updateState('error')
          configRef.current.onError?.(event.error)
          break
      }
    })
    engineRef.current = engine
    engine.start()
  }

  const stop = async (): Promise<void> => {
    const engine = engineRef.current
    if (!engine) {
      if (state.value === 'starting') updateState('idle')
      return
    }
    await engine.stop()
  }

  const cancel = (): void => {
    generationRef.current++
    engineRef.current?.cancel()
    engineRef.current = null
    if (state.value === 'starting') updateState('canceled')
  }

  const pause = (): void => {
    engineRef.current?.pause()
  }

  const resume = (): void => {
    engineRef.current?.resume()
  }

  const finalize = (options?: SttFinalizeOptions): void => {
    engineRef.current?.finalize(options)
  }

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      generationRef.current++
      engineRef.current?.cancel()
      engineRef.current = null
    }
  }, [])

  return { state, isActive, start, stop, cancel, pause, resume, finalize }
}
