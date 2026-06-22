/**
 * Provider-agnostic speech-to-text contract.
 *
 * The 同传 tab supports more than one STT backend (Soniox, ElevenLabs). Rather
 * than teach the UI each provider's SDK, every backend is wrapped in an
 * `SttEngine` that speaks this one normalized event vocabulary. The recording
 * hook and the transcript consumer in `stt-tab.tsx` then work identically no
 * matter which provider produced the words.
 *
 * Nothing here imports a provider SDK — these are plain types + a factory
 * shape, so the contract stays the single source of truth and the file is safe
 * to import from anywhere (including Bun tests).
 */

export type SttProvider = 'soniox' | 'elevenlabs' | 'deepgram'

/**
 * A selectable STT model in a picker. `id` is the value sent to the provider
 * (e.g. Soniox model id, Deepgram `canonical_name`); `name` is an optional
 * friendlier label. Shared by the providers that expose a fetchable model list.
 */
export interface SttModelOption {
  id: string
  name?: string
}

/**
 * Recording lifecycle state. A superset of Soniox's own `RecordingState`
 * (`idle | starting | connecting | recording | paused | reconnecting |
 * stopping | stopped | error | canceled`, forwarded from the SDK's
 * `state_change` verbatim) plus `running`, the synthetic state the ElevenLabs
 * engine emits on socket open. Kept as a local string union so no provider
 * package leaks into the shared contract. The STT tab drives its own UI state
 * machine off the callbacks, so consumers rarely read this directly.
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

/**
 * One transcribed fragment. `kind` separates a Soniox translation token from
 * the original transcript; ElevenLabs only ever emits `'original'` (Scribe
 * realtime is transcription-only — no translation).
 */
export interface SttChunk {
  text: string
  isFinal: boolean
  kind: 'original' | 'translation'
}

/**
 * Normalized events every engine emits. A discriminated union so consumers
 * `switch (event.type)` with full type-narrowing and zero casts.
 */
export type SttEngineEvent =
  | { type: 'state'; state: SttRecordingState }
  | { type: 'transcript'; chunks: SttChunk[] }
  | { type: 'endpoint' }
  | { type: 'connected' }
  | { type: 'finished' }
  | { type: 'error'; error: Error }

/**
 * Session parameters captured at `start()` time (a snapshot — later settings
 * edits don't reconfigure a live session).
 */
export interface SttSessionParams {
  apiKey: string
  model: string
  /**
   * Soniox language hints (multiple). ElevenLabs uses only the first entry as
   * its single `languageCode`; an empty array means auto-detect.
   */
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
 * Imperative control surface returned by every engine. `pause`/`resume`/
 * `cancel`/`finalize` exist for parity and future UI; today the STT tab only
 * drives `start`/`stop`. An engine that can't honor an operation makes it a
 * safe no-op rather than throwing.
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
