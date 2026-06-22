/**
 * Pure transcript mappers + the ElevenLabs token-response guard.
 *
 * Deliberately free of any provider SDK or `$` (Greasemonkey) import so this
 * file is the unit-testable core of the STT layer — Bun can import it directly.
 * The engines depend on these functions; the functions depend on nothing that
 * needs a browser.
 */

import type { SttChunk } from './types'

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
 * Reads a string property off an unknown value (e.g. a parsed JSON WebSocket
 * message) without an `as` cast. `Object.getOwnPropertyDescriptor` lets us read
 * a dynamic key while keeping the result `unknown` until it's type-checked.
 */
export function readStringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value
  return typeof field === 'string' ? field : undefined
}
