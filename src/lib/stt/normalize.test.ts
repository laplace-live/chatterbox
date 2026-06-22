import { describe, expect, test } from 'bun:test'

import type { SttChunk } from './types'

import {
  elevenLabsTextToChunk,
  isGladiaLiveResponse,
  isSingleUseTokenResponse,
  parseDeepgramModels,
  parseDeepgramResult,
  parseGladiaResult,
  readStringField,
  reduceChunks,
  sonioxResultToChunks,
} from './normalize'

/**
 * These pure mappers are the seam that lets one consumer handle both
 * providers. `sonioxResultToChunks` must preserve Soniox's final/non-final
 * and original/translation distinctions; `reduceChunks` must pick exactly the
 * stream the user is listening to (translation when on, original when off);
 * `isSingleUseTokenResponse` guards the ElevenLabs token mint against a
 * malformed response without an `as` cast.
 */
describe('sonioxResultToChunks', () => {
  test('maps text + is_final and defaults kind to original', () => {
    const chunks = sonioxResultToChunks({
      tokens: [
        { text: 'hello', is_final: true },
        { text: ' world', is_final: false },
      ],
    })
    expect(chunks).toEqual([
      { text: 'hello', isFinal: true, kind: 'original' },
      { text: ' world', isFinal: false, kind: 'original' },
    ])
  })

  test('marks translation_status === "translation" tokens as translation', () => {
    const chunks = sonioxResultToChunks({
      tokens: [
        { text: '你好', is_final: true, translation_status: 'original' },
        { text: 'hello', is_final: true, translation_status: 'translation' },
      ],
    })
    expect(chunks[0]?.kind).toBe('original')
    expect(chunks[1]?.kind).toBe('translation')
  })

  test('tolerates a missing tokens array', () => {
    expect(sonioxResultToChunks({})).toEqual([])
  })
})

describe('reduceChunks', () => {
  const chunks: SttChunk[] = [
    { text: 'a', isFinal: true, kind: 'original' },
    { text: 'b', isFinal: false, kind: 'original' },
    { text: 'X', isFinal: true, kind: 'translation' },
    { text: 'Y', isFinal: false, kind: 'translation' },
  ]

  test('keeps only original chunks when translation is off', () => {
    expect(reduceChunks(chunks, false)).toEqual({ newFinal: 'a', nonFinal: 'b' })
  })

  test('keeps only translation chunks when translation is on', () => {
    expect(reduceChunks(chunks, true)).toEqual({ newFinal: 'X', nonFinal: 'Y' })
  })

  test('concatenates multiple finals in order', () => {
    expect(
      reduceChunks(
        [
          { text: 'foo', isFinal: true, kind: 'original' },
          { text: 'bar', isFinal: true, kind: 'original' },
        ],
        false
      )
    ).toEqual({ newFinal: 'foobar', nonFinal: '' })
  })
})

describe('elevenLabsTextToChunk', () => {
  test('wraps text as a single original chunk with the given finality', () => {
    expect(elevenLabsTextToChunk('hi', false)).toEqual({ text: 'hi', isFinal: false, kind: 'original' })
    expect(elevenLabsTextToChunk('done', true)).toEqual({ text: 'done', isFinal: true, kind: 'original' })
  })
})

describe('isSingleUseTokenResponse', () => {
  test('accepts an object with a string token', () => {
    expect(isSingleUseTokenResponse({ token: 'abc' })).toBe(true)
  })

  test('rejects non-objects, null, and missing/non-string token', () => {
    expect(isSingleUseTokenResponse(null)).toBe(false)
    expect(isSingleUseTokenResponse('abc')).toBe(false)
    expect(isSingleUseTokenResponse({})).toBe(false)
    expect(isSingleUseTokenResponse({ token: 123 })).toBe(false)
  })
})

describe('readStringField', () => {
  test('returns the string value for a present string key', () => {
    expect(readStringField({ message_type: 'partial_transcript' }, 'message_type')).toBe('partial_transcript')
  })

  test('returns undefined for non-objects, missing keys, and non-string values', () => {
    expect(readStringField(null, 'x')).toBeUndefined()
    expect(readStringField('str', 'x')).toBeUndefined()
    expect(readStringField({}, 'x')).toBeUndefined()
    expect(readStringField({ x: 5 }, 'x')).toBeUndefined()
  })
})

describe('parseDeepgramResult', () => {
  const build = (transcript: string, isFinal: boolean, speechFinal: boolean) => ({
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript, confidence: 0.9 }] },
  })

  test('reads an interim result', () => {
    expect(parseDeepgramResult(build('hello', false, false))).toEqual({
      transcript: 'hello',
      isFinal: false,
      speechFinal: false,
    })
  })

  test('reads a final + speech_final result', () => {
    expect(parseDeepgramResult(build('done', true, true))).toEqual({
      transcript: 'done',
      isFinal: true,
      speechFinal: true,
    })
  })

  test('ignores non-Results messages and malformed shapes', () => {
    expect(parseDeepgramResult({ type: 'Metadata' })).toBeNull()
    expect(parseDeepgramResult({ type: 'Results', channel: { alternatives: [] } })).toBeNull()
    expect(parseDeepgramResult({ type: 'Results', channel: { alternatives: [{ confidence: 1 }] } })).toBeNull()
    expect(parseDeepgramResult(null)).toBeNull()
  })
})

describe('parseDeepgramModels', () => {
  test('keeps only streaming models, ids from canonical_name, sorted', () => {
    const models = parseDeepgramModels({
      stt: [
        { canonical_name: 'nova-3', name: 'nova-3', streaming: true, batch: true },
        { canonical_name: 'whisper-cloud', name: 'Whisper Cloud', streaming: false, batch: true },
        { canonical_name: 'nova-2-general', name: 'Nova 2 General', streaming: true, batch: true },
      ],
    })
    expect(models).toEqual([{ id: 'nova-2-general', name: 'Nova 2 General' }, { id: 'nova-3' }])
  })

  test('returns [] for a missing/non-array stt list', () => {
    expect(parseDeepgramModels({})).toEqual([])
    expect(parseDeepgramModels({ stt: 'nope' })).toEqual([])
    expect(parseDeepgramModels(null)).toEqual([])
  })
})

describe('parseGladiaResult', () => {
  const build = (text: string, isFinal: boolean) => ({
    type: 'transcript',
    session_id: 's',
    data: { id: 'u1', is_final: isFinal, utterance: { text, start: 0.1, end: 1.2, language: 'en' } },
  })

  test('reads a partial transcript', () => {
    expect(parseGladiaResult(build('hello', false))).toEqual({ transcript: 'hello', isFinal: false })
  })

  test('reads a final transcript', () => {
    expect(parseGladiaResult(build('done', true))).toEqual({ transcript: 'done', isFinal: true })
  })

  test('ignores non-transcript messages and malformed shapes', () => {
    expect(parseGladiaResult({ type: 'speech_start' })).toBeNull()
    expect(parseGladiaResult({ type: 'transcript', data: { is_final: true, utterance: {} } })).toBeNull()
    expect(parseGladiaResult({ type: 'transcript', data: { is_final: true } })).toBeNull()
    expect(parseGladiaResult({ type: 'transcript' })).toBeNull()
    expect(parseGladiaResult(null)).toBeNull()
  })
})

describe('isGladiaLiveResponse', () => {
  test('accepts an object with a string url', () => {
    expect(isGladiaLiveResponse({ id: 'x', url: 'wss://api.gladia.io/v2/live/abc' })).toBe(true)
  })

  test('rejects non-objects, null, and missing/non-string url', () => {
    expect(isGladiaLiveResponse(null)).toBe(false)
    expect(isGladiaLiveResponse('wss://x')).toBe(false)
    expect(isGladiaLiveResponse({})).toBe(false)
    expect(isGladiaLiveResponse({ url: 123 })).toBe(false)
  })
})
