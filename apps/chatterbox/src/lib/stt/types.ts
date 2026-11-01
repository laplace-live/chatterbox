/**
 * Provider-agnostic speech-to-text contract: every backend is wrapped in an
 * `SttEngine` speaking one normalized event vocabulary. Imports no provider
 * SDK, so it's safe to import anywhere (including Bun tests).
 */

export type SttProvider = 'soniox' | 'elevenlabs' | 'deepgram' | 'gladia' | 'gemini' | 'openai' | 'openai-compat'
export type SttTranslationApi = 'openai' | 'whisper-cpp'

/** A selectable STT model; `id` is the value sent to the provider (e.g. Deepgram `canonical_name`). */
export interface SttModelOption {
  id: string
  name?: string
}

/** Normalized STT/translation session lifecycle state emitted across all engines. */
export type SttRecordingState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'recording'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'canceled'
  | 'error'

/** A fragment of source-language transcription or translated text. */
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
  /** Present only when the selected model/API supports translation. */
  translation?: { targetLanguage: string; voiceId?: string; authorizationToken?: string }
  /** Explicit backend contract for Whisper translation requests. */
  translationApi?: SttTranslationApi
  /** Microphone device id, `''` for system default, or `WEB_AUDIO_DEVICE_ID` for live-player audio. */
  audioDeviceId: string
  /** API root: required by `openai-compat`; optional for Gemini and OpenAI. */
  baseUrl?: string
}

/** Optional knobs for `finalize()` (used by Soniox trailing-silence endpointing). */
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
