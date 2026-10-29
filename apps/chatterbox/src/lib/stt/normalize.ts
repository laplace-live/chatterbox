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

// Han, kana and CJK/fullwidth punctuation; Hangul is left out since Korean spaces separate words.
const CJK_CHAR = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u30fc\uff00-\uffef]`
const CJK_GAP = new RegExp(String.raw`(?<=${CJK_CHAR})\s+(?=${CJK_CHAR})`, 'gu')

/** Drop the spaces Gemini sometimes emits between Chinese/Japanese characters (`今 天 我 们`), and lead Latin-script text with a space so consecutive utterances don't glue. */
export function tidyGeminiText(text: string): string {
  const tidy = text.replace(CJK_GAP, '')
  return /^[\p{Script=Latin}\d]/u.test(tidy) ? ` ${tidy}` : tidy
}

/** The parts of a Gemini Live server message the transcription engine acts on; texts pass through {@link tidyGeminiText}. */
export interface GeminiLiveMessage {
  setupComplete: boolean
  goAway: boolean
  /** `inputTranscription`: authoritative text of a finished utterance; '' if the server sent none. */
  final?: string
  /** `interimInputTranscription`: the whole running hypothesis for the utterance in progress, not a delta. */
  interim?: string
}

/** Parse a Gemini Live server message; unrelated or malformed messages parse to all-empty. */
export function parseGeminiLiveMessage(value: unknown): GeminiLiveMessage {
  const content = readField(value, 'serverContent')
  const input = readField(content, 'inputTranscription')
  const interim = readStringField(readField(content, 'interimInputTranscription'), 'text')
  return {
    setupComplete: readField(value, 'setupComplete') !== undefined,
    goAway: readField(value, 'goAway') !== undefined,
    final:
      typeof input === 'object' && input !== null ? tidyGeminiText(readStringField(input, 'text') ?? '') : undefined,
    interim: interim === undefined ? undefined : tidyGeminiText(interim),
  }
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

/**
 * Whisper's stock hallucinations on near-silence: subtitle credits, sign-offs,
 * and Amara.org attributions. Anchored to the whole segment on purpose — a
 * substring test would eat legitimate speech that merely mentions 字幕 or 观看.
 */
const WHISPER_HALLUCINATIONS: RegExp[] = [
  /^字幕(由|製作|制作|志願者?|志愿者?)[^。！？]{0,24}(提供|製作|制作|社[區区群])$/,
  /^[^。！？]{0,12}Amara\.org[^。！？]{0,24}$/i,
  /^(請|请)不吝(點贊|点赞|賜教|赐教)[^。！？]{0,24}$/,
  /^(謝謝|谢谢|感謝|感谢)(大家)?(觀看|观看|收看)$/,
  /^thanks?\s+for\s+watching$/i,
  /^(明鏡|明镜)(與|与)?(點點|点点)?(欄目|栏目)$/,
]

/** Whether a transcript segment is entirely a known Whisper hallucination (or empty). */
export function isWhisperHallucination(text: string): boolean {
  const normalized = text.trim().replace(/[\s。．.!！?？、,，~～]+$/u, '')
  if (!normalized) return true
  return WHISPER_HALLUCINATIONS.some(pattern => pattern.test(normalized))
}
