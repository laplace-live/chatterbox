/**
 * Pure transcript mappers + the ElevenLabs token-response guard.
 *
 * Deliberately free of any provider SDK or `$` (Greasemonkey) import so this
 * file is the unit-testable core of the STT layer — Bun can import it directly.
 * The engines depend on these functions; the functions depend on nothing that
 * needs a browser.
 */

import type { SttChunk, SttModelOption } from './types'

/**
 * Structural shape of the Soniox tokens we read. Narrower than the SDK's
 * `RealtimeResult` on purpose: a real `RealtimeResult` is assignable to it (it
 * has these fields plus more), but tests can construct one with a plain
 * literal and we never couple this module to `@soniox/client`.
 */
export interface SonioxTokenLike {
  text: string
  is_final: boolean
  translation_status?: string
}

export interface SonioxResultLike {
  tokens?: SonioxTokenLike[]
}

/** Map a Soniox realtime result frame onto normalized chunks. */
export function sonioxResultToChunks(result: SonioxResultLike): SttChunk[] {
  const chunks: SttChunk[] = []
  for (const token of result.tokens ?? []) {
    chunks.push({
      text: token.text,
      isFinal: token.is_final,
      kind: token.translation_status === 'translation' ? 'translation' : 'original',
    })
  }
  return chunks
}

/** Wrap an ElevenLabs partial/committed transcript string as one chunk. */
export function elevenLabsTextToChunk(text: string, isFinal: boolean): SttChunk {
  return { text, isFinal, kind: 'original' }
}

/**
 * Collapse a frame's chunks into the new final text and the current non-final
 * text for the stream the user is listening to. When translation is on we keep
 * only `translation` chunks; otherwise only `original` — so the two streams
 * never bleed into each other (Soniox sends both interleaved when translating).
 */
export function reduceChunks(chunks: SttChunk[], translationEnabled: boolean): { newFinal: string; nonFinal: string } {
  let newFinal = ''
  let nonFinal = ''
  for (const chunk of chunks) {
    const isTranslation = chunk.kind === 'translation'
    if (translationEnabled !== isTranslation) continue
    if (chunk.isFinal) newFinal += chunk.text
    else nonFinal += chunk.text
  }
  return { newFinal, nonFinal }
}

/**
 * Type guard for the ElevenLabs single-use-token response (`{ token: string }`).
 * Uses `in`-narrowing instead of a cast so it stays sound under the no-`as`
 * rule.
 */
export function isSingleUseTokenResponse(value: unknown): value is { token: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('token' in value)) return false
  return typeof value.token === 'string'
}

/**
 * Type guard for the Gladia `POST /v2/live` init response. The only field the
 * engine needs is the session `url` (the per-session WebSocket URL with an
 * embedded token). `in`-narrowing keeps it sound under the no-`as` rule.
 */
export function isGladiaLiveResponse(value: unknown): value is { url: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('url' in value)) return false
  return typeof value.url === 'string'
}

/**
 * Reads a property off an unknown value (e.g. a parsed JSON WebSocket message)
 * as `unknown`, without an `as` cast. `Object.getOwnPropertyDescriptor` lets us
 * read a dynamic key while keeping the result typed `unknown` until checked.
 */
export function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** `readField` narrowed to a string (or `undefined` if absent / not a string). */
export function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' ? field : undefined
}

/**
 * Parse a Deepgram realtime `Results` message into the transcript text plus its
 * finality flags. Returns `null` for non-Results messages (Metadata,
 * UtteranceEnd, SpeechStarted) or malformed shapes. The transcript lives at
 * `channel.alternatives[0].transcript`; `is_final` marks a finalized segment,
 * `speech_final` marks the utterance boundary (our endpoint).
 */
export function parseDeepgramResult(
  value: unknown
): { transcript: string; isFinal: boolean; speechFinal: boolean } | null {
  if (readStringField(value, 'type') !== 'Results') return null
  const alternatives = readField(readField(value, 'channel'), 'alternatives')
  if (!Array.isArray(alternatives) || alternatives.length === 0) return null
  const first: unknown = alternatives[0]
  const transcript = readStringField(first, 'transcript')
  if (transcript === undefined) return null
  return {
    transcript,
    isFinal: readField(value, 'is_final') === true,
    speechFinal: readField(value, 'speech_final') === true,
  }
}

/**
 * Parse a Gladia realtime `transcript` message into the utterance text plus its
 * finality flag. Returns `null` for non-transcript messages (speech_start,
 * speech_end, lifecycle) or malformed shapes. The text lives at
 * `data.utterance.text`; `data.is_final` marks a finalized utterance, which the
 * engine also treats as the endpoint.
 */
export function parseGladiaResult(value: unknown): { transcript: string; isFinal: boolean } | null {
  if (readStringField(value, 'type') !== 'transcript') return null
  const data = readField(value, 'data')
  const transcript = readStringField(readField(data, 'utterance'), 'text')
  if (transcript === undefined) return null
  return { transcript, isFinal: readField(data, 'is_final') === true }
}

/**
 * Parse Deepgram's `GET /v1/models` response (`{ stt: [...] }`) into picker
 * options, keeping only realtime models (`streaming: true`) — the analogue of
 * Soniox's `transcription_mode === 'real_time'` filter. Ids come from
 * `canonical_name` (falling back to `name`); sorted, de-duplicated.
 */
export function parseDeepgramModels(value: unknown): SttModelOption[] {
  const stt = readField(value, 'stt')
  if (!Array.isArray(stt)) return []
  const models: SttModelOption[] = []
  const seen = new Set<string>()
  for (const raw of stt) {
    const entry: unknown = raw
    if (readField(entry, 'streaming') !== true) continue
    const id = (readStringField(entry, 'canonical_name') ?? readStringField(entry, 'name'))?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: SttModelOption = { id }
    const name = readStringField(entry, 'name')?.trim()
    if (name && name !== id) model.name = name
    models.push(model)
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return models
}
