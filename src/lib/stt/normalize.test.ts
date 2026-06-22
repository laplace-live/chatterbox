import { describe, expect, test } from 'bun:test'

import type { SttChunk } from './types'

import {
  elevenLabsTextToChunk,
  isSingleUseTokenResponse,
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
