/** Pure transcript mappers + response guards; no SDK/browser deps so Bun can import it. */

import type { SttChunk, SttModelOption } from './types'

/** Structural subset of Soniox tokens; `RealtimeResult` is assignable, avoids coupling to `@soniox/client`. */
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

/** Collapse chunks into new-final + non-final text; keeps only translation or original so Soniox's interleaved streams don't bleed. */
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

/** Type guard for the ElevenLabs single-use-token response (`{ token: string }`). */
export function isSingleUseTokenResponse(value: unknown): value is { token: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('token' in value)) return false
  return typeof value.token === 'string'
}

/** Type guard for the Gladia `POST /v2/live` init response; `url` is the per-session WebSocket URL with embedded token. */
export function isGladiaLiveResponse(value: unknown): value is { url: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('url' in value)) return false
  return typeof value.url === 'string'
}

/** Read a dynamic key off an unknown value as `unknown` (no `as` cast). */
export function readField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** `readField` narrowed to a string (or `undefined` if absent / not a string). */
export function readStringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' ? field : undefined
}

/** Parse a Deepgram `Results` message; `null` for other/malformed messages. `speech_final` marks the utterance boundary (our endpoint). */
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

/** Parse a Gladia `transcript` message; `null` for other/malformed messages. `data.is_final` is also the endpoint. */
export function parseGladiaResult(value: unknown): { transcript: string; isFinal: boolean } | null {
  if (readStringField(value, 'type') !== 'transcript') return null
  const data = readField(value, 'data')
  const transcript = readStringField(readField(data, 'utterance'), 'text')
  if (transcript === undefined) return null
  return { transcript, isFinal: readField(data, 'is_final') === true }
}

/** Parse Deepgram's `GET /v1/models` response into picker options; keeps only `streaming: true`, ids from `canonical_name` (fallback `name`), sorted + de-duped. */
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
