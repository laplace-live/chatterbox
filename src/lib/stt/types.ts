/**
 * Provider-agnostic speech-to-text contract: every backend is wrapped in an
 * `SttEngine` speaking one normalized event vocabulary. Imports no provider
 * SDK, so it's safe to import anywhere (including Bun tests).
 */

export type SttProvider = 'soniox' | 'elevenlabs' | 'deepgram' | 'gladia'

/** A selectable STT model; `id` is the value sent to the provider (e.g. Deepgram `canonical_name`). */
export interface SttModelOption {
  id: string
  name?: string
}

/**
 * Recording lifecycle state: superset of Soniox's own `RecordingState` plus
 * `running` (synthetic, emitted by the ElevenLabs engine on socket open). Local
 * union so no provider package leaks into the shared contract.
 */
export type SttRecordingState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'recording'
  | 'running'
  | 'paused'
  | 'reconnecting'
  | 'stopping'
  | 'stopped'
  | 'canceled'
  | 'error'

/** One transcribed fragment; ElevenLabs only ever emits `'original'` (Scribe realtime has no translation). */
export interface SttChunk {
  text: string
  isFinal: boolean
  kind: 'original' | 'translation'
}

/** Normalized events every engine emits; discriminated union for `switch (event.type)` narrowing. */
export type SttEngineEvent =
  | { type: 'state'; state: SttRecordingState }
  | { type: 'transcript'; chunks: SttChunk[] }
  | { type: 'endpoint' }
  | { type: 'connected' }
  | { type: 'finished' }
  | { type: 'error'; error: Error }

/** Session params snapshotted at `start()`; later settings edits don't reconfigure a live session. */
export interface SttSessionParams {
  apiKey: string
  model: string
  /** ElevenLabs uses only the first entry as its `languageCode`; empty = auto-detect. */
  languageHints: string[]
  /** Soniox-only realtime translation target. ElevenLabs ignores this. */
  translation?: { targetLanguage: string }
  /** Resolved microphone device id; `''` = system default. */
  audioDeviceId: string
}

/** Optional knobs for `finalize()`. Provider-agnostic; Soniox maps it onto its SDK. */
export interface SttFinalizeOptions {
  trailingSilenceMs?: number
}

/**
 * Imperative control surface returned by every engine. An engine that can't
 * honor an operation makes it a safe no-op rather than throwing.
 */
export interface SttEngine {
  start: () => void
  stop: () => Promise<void>
  cancel: () => void
  pause: () => void
  resume: () => void
  finalize: (options?: SttFinalizeOptions) => void
}

export type SttEngineEventHandler = (event: SttEngineEvent) => void

/** Builds an engine bound to a single session's params + event sink. */
export type SttEngineFactory = (params: SttSessionParams, onEvent: SttEngineEventHandler) => SttEngine
