/**
 * Preact-native multi-provider STT recording hook.
 *
 * Replaces the Soniox-only `useSonioxRecording`. One hook, called
 * unconditionally (rules-of-hooks safe), that on `start()` instantiates the
 * engine for the currently-selected provider and pipes its normalized
 * `SttEngineEvent`s onto the consumer's callbacks + the reactive lifecycle
 * signals. The provider-specific SDK lifecycles live entirely inside the
 * engines (see `stt/soniox-engine.ts`, `stt/elevenlabs-engine.ts`); this hook
 * is the shared shell — state signals, callback refs, teardown.
 *
 * A fresh engine is built per `start()` from a snapshot of `params`, so a
 * settings edit mid-session never reconfigures a live recording. Callbacks are
 * read through a ref so engine event handlers never close over stale versions.
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

import { createElevenLabsEngine } from './stt/elevenlabs-engine'
import { createSonioxEngine } from './stt/soniox-engine'

export interface UseSttRecordingConfig {
  provider: SttProvider
  /** Snapshotted at `start()` time, not at hook mount. */
  params: SttSessionParams
  /** Fired for every transcript frame (partial + final chunks). */
  onTranscript?: (chunks: SttChunk[]) => void
  /** Fired when the provider signals an utterance endpoint. */
  onEndpoint?: () => void
  /** Fired on any error (audio, network, server, SDK load, token mint). */
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
  elevenlabs: createElevenLabsEngine,
}

export function useSttRecording(config: UseSttRecordingConfig): UseSttRecordingReturn {
  const state = useMemo<Signal<SttRecordingState>>(() => signal<SttRecordingState>('idle'), [])
  const isActive = useMemo<Signal<boolean>>(() => signal(false), [])

  // Latest callbacks/params without rebinding engine listeners each render.
  const configRef = useRef(config)
  configRef.current = config

  const engineRef = useRef<SttEngine | null>(null)
  // Bumped on every start/cancel/unmount so late events from a superseded
  // engine (a previous session's socket closing after we've already moved on)
  // are dropped instead of clobbering the current session's state.
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

    // Optimistic transition — immediate UI feedback while the SDK loads / the
    // token mints. The engine's own state events take over once it connects.
    updateState('starting')

    const cfg = configRef.current
    const engine = ENGINE_FACTORIES[cfg.provider](cfg.params, event => {
      // Ignore events from a superseded engine — e.g. the previous session's
      // WebSocket emitting CLOSE/finished after a restart has already begun.
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
      // Nothing live — but we may still be mid-start (SDK load in flight).
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

  // Teardown on unmount (e.g. the user closes the panel mid-session).
  useEffect(() => {
    return () => {
      generationRef.current++
      engineRef.current?.cancel()
      engineRef.current = null
    }
  }, [])

  return { state, isActive, start, stop, cancel, pause, resume, finalize }
}
