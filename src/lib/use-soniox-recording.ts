/**
 * Preact-native wrapper around @soniox/client's `Recording`.
 *
 * Why this exists: Soniox ships an official `@soniox/react` hook
 * package, but it depends on React's `useSyncExternalStore` and
 * `useContext` against the real React runtime. Our project uses
 * Preact (the `@preact/preset-vite` alias points `react` →
 * `preact/compat` at runtime, so @soniox/react *would* technically
 * work), but routing through the compat shim:
 *   1. Pulls react-compat into the userscript bundle for no reason
 *      other than to satisfy one hook's import declaration.
 *   2. Hides Preact-specific niceties (we want `@preact/signals`
 *      reactivity, not React's `useState` pattern).
 *
 * Instead we port the minimum useful surface of `useRecording` onto
 * Preact hooks directly. Behaviour mirrors the official hook's
 * contract — same field names (`state`, `isActive`, `start`,
 * `stop`, `pause`, etc.) so swapping back to @soniox/react later
 * would be a near-mechanical change.
 *
 * The hook handles the lazy `loadSoniox()` round-trip internally:
 * `start()` returns synchronously and the actual `Recording`
 * instance is wired in once the CDN bundle has landed. Callers
 * don't need to think about the loader — they just call `start()`.
 *
 * Key behavioural choices kept from the official hook:
 * - Callbacks routed through a ref so updates between renders
 *   never see stale closures inside Recording event listeners.
 * - `start()` aborts any in-flight Recording before creating the
 *   next one (Preact dev double-mount / impatient click safety).
 * - Cleanup on unmount via an AbortController shared with the
 *   in-flight Recording.
 *
 * Behaviour intentionally NOT ported (chatterbox doesn't need it):
 * - SonioxProvider / context plumbing — we accept the api key
 *   inline per call. There's only ever one client in this app.
 * - Token grouping, utterance buffers, segments — consumers use
 *   the raw `result` event for fine-grained control over when text
 *   enters their own buffers (e.g. the danmaku send queue).
 * - Reconnect introspection (`isReconnecting`, `reconnectAttempt`) —
 *   no UI for it yet. Re-add if/when we surface reconnect state.
 */

import { type Signal, signal } from '@preact/signals'
import type {
  AudioSource,
  RealtimeResult,
  Recording,
  RecordingState,
  SonioxClient,
  SttSessionConfig,
} from '@soniox/client'
import { useEffect, useMemo, useRef } from 'preact/hooks'

import { loadSoniox } from './soniox'

export type UseSonioxRecordingConfig = SttSessionConfig & {
  /**
   * Soniox API key. Required at `start()` time, not at hook mount —
   * so consumers can mount the hook before the user has entered a key.
   */
  apiKey: string
  /**
   * Optional custom AudioSource. Mutually exclusive with
   * `microphoneConstraints` — if both are set, `source` wins.
   */
  source?: AudioSource
  /**
   * MediaTrackConstraints forwarded to a lazily-constructed
   * `MicrophoneSource`. Use this to pin a specific input device
   * without having to import `MicrophoneSource` yourself (the SDK
   * is loaded on demand by the hook).
   */
  microphoneConstraints?: MediaTrackConstraints
  /** Fired for every result frame from the server. */
  onResult?: (result: RealtimeResult) => void
  /** Fired when the server signals an utterance endpoint. */
  onEndpoint?: () => void
  /** Fired on any error (audio, network, server). */
  onError?: (err: Error) => void
  /** Fired when the server has flushed all final results and stopped. */
  onFinished?: () => void
  /** Fired when the WebSocket opens. */
  onConnected?: () => void
}

export interface UseSonioxRecordingReturn {
  /** Reactive Recording lifecycle state. */
  state: Signal<RecordingState>
  /** `true` whenever a session is actively in any non-terminal state. */
  isActive: Signal<boolean>
  /** Start a new recording. Aborts any in-flight session first. */
  start: () => void
  /** Gracefully stop — waits for the server to flush final results. */
  stop: () => Promise<void>
  /** Immediately cancel without waiting for final results. */
  cancel: () => void
  /** Pause (audio source stops, WebSocket kept alive with keepalive). */
  pause: () => void
  /** Resume after pause. */
  resume: () => void
  /** Ask the server to finalize any current non-final tokens. */
  finalize: (options?: { trailing_silence_ms?: number }) => void
}

// Lifecycle states that mean "nothing live, safe to start fresh".
const TERMINAL_STATES = new Set<RecordingState>(['idle', 'stopped', 'canceled', 'error'])

export function useSonioxRecording(config: UseSonioxRecordingConfig): UseSonioxRecordingReturn {
  // One signal pair per hook instance. `useMemo` (instead of `useRef`) so
  // the same signal identity is reused across renders without forcing
  // consumers to read `.current`.
  const state = useMemo<Signal<RecordingState>>(() => signal<RecordingState>('idle'), [])
  const isActive = useMemo<Signal<boolean>>(() => signal(false), [])

  // Refs let event handlers read the latest callbacks without rebinding
  // listeners on every render. Mirrors @soniox/react's approach to
  // dodging the React `useEffect` deps trap.
  const configRef = useRef(config)
  configRef.current = config

  // The SonioxClient is keyed to the api key — we recreate it whenever
  // the key changes (i.e. user pastes a different key into settings).
  // Cached so back-to-back start/stop cycles reuse the same client.
  const clientRef = useRef<{ key: string; client: SonioxClient } | null>(null)
  const recordingRef = useRef<Recording | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const updateState = (next: RecordingState) => {
    state.value = next
    isActive.value = !TERMINAL_STATES.has(next)
  }

  const start = (): void => {
    // Tear down any in-flight session before opening a new one. Without
    // this, double-clicking the start button would orphan a Recording
    // (its events would still fire into the stale closure).
    abortRef.current?.abort()
    recordingRef.current?.cancel()
    recordingRef.current = null

    const controller = new AbortController()
    abortRef.current = controller

    // Optimistic state transition — gives the UI immediate feedback
    // while the CDN bundle loads. Mirrors what the SDK would set
    // internally once `record()` is called.
    updateState('starting')

    // Snapshot config at the moment of the user's click. Subsequent
    // render-time edits to the config object shouldn't change what
    // *this* recording session is configured with — only the callback
    // refs (read from configRef inside event handlers) should update.
    const cfg = configRef.current

    void loadSoniox()
      .then(Soniox => {
        // The controller may have been aborted in the gap between
        // user click and CDN load (e.g. they hit Stop immediately).
        if (controller.signal.aborted) return

        const cached = clientRef.current
        const client =
          cached && cached.key === cfg.apiKey
            ? cached.client
            : (() => {
                // Sync `config` object is fine here because the SDK
                // never invokes our resolver after construction —
                // it just inlines `api_key` into the WebSocket URL.
                const c = new Soniox.SonioxClient({ config: { api_key: cfg.apiKey } })
                clientRef.current = { key: cfg.apiKey, client: c }
                return c
              })()

        const {
          apiKey: _apiKey,
          source: explicitSource,
          microphoneConstraints,
          onResult: _onResult,
          onEndpoint: _onEndpoint,
          onError: _onError,
          onFinished: _onFinished,
          onConnected: _onConnected,
          ...sttConfig
        } = cfg
        // Touch the destructured callback names so noUnusedLocals
        // doesn't complain — they're pulled out intentionally to keep
        // them off the SDK's session config payload.
        void _apiKey
        void _onResult
        void _onEndpoint
        void _onError
        void _onFinished
        void _onConnected

        // Custom source wins. Otherwise, if the caller supplied any
        // microphone constraints (e.g. a `deviceId: { exact: ... }`
        // selector), build a `MicrophoneSource` here so they don't
        // have to wait on `loadSoniox()` themselves just to grab the
        // class. With neither set, `record()` falls back to its own
        // default `MicrophoneSource` instance.
        const source: AudioSource | undefined =
          explicitSource ??
          (microphoneConstraints ? new Soniox.MicrophoneSource({ constraints: microphoneConstraints }) : undefined)

        const recording = client.realtime.record({
          ...sttConfig,
          ...(source !== undefined ? { source } : {}),
          session_options: { signal: controller.signal },
        })
        recordingRef.current = recording

        recording.on('state_change', ({ new_state }) => updateState(new_state))
        recording.on('result', result => {
          configRef.current.onResult?.(result)
        })
        recording.on('endpoint', () => {
          configRef.current.onEndpoint?.()
        })
        recording.on('error', err => {
          configRef.current.onError?.(err)
        })
        recording.on('finished', () => {
          configRef.current.onFinished?.()
        })
        recording.on('connected', () => {
          configRef.current.onConnected?.()
        })
      })
      .catch(err => {
        if (controller.signal.aborted) return
        const error = err instanceof Error ? err : new Error(String(err))
        updateState('error')
        configRef.current.onError?.(error)
      })
  }

  const stop = async (): Promise<void> => {
    const recording = recordingRef.current
    if (!recording) {
      // Nothing live to stop — but we may still be in 'starting' (CDN
      // load in flight). Abort the load so the .then never wires up
      // a Recording that the user already cancelled.
      abortRef.current?.abort()
      if (state.value === 'starting') updateState('idle')
      return
    }
    await recording.stop()
  }

  const cancel = (): void => {
    // Cancel first (synchronous, sets state to 'canceled'), THEN abort
    // the signal — reversing the order would let the abort handler
    // overwrite the state to 'error' before cancel runs.
    recordingRef.current?.cancel()
    abortRef.current?.abort()
    if (!recordingRef.current && state.value === 'starting') updateState('canceled')
  }

  const pause = (): void => {
    recordingRef.current?.pause()
  }

  const resume = (): void => {
    recordingRef.current?.resume()
  }

  const finalize = (options?: { trailing_silence_ms?: number }): void => {
    recordingRef.current?.finalize(options)
  }

  // Belt-and-suspenders teardown on unmount — covers e.g. the user
  // closes the chatterbox panel while a session is live.
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      recordingRef.current?.cancel()
      recordingRef.current = null
    }
  }, [])

  return { state, isActive, start, stop, cancel, pause, resume, finalize }
}
