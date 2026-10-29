import { describe, expect, test } from 'bun:test'

import type { SttChunk } from './types'

import {
  elevenLabsTextToChunk,
  isGladiaLiveResponse,
  isSingleUseTokenResponse,
  isWhisperHallucination,
  parseDeepgramModels,
  parseDeepgramResult,
  parseGeminiLiveMessage,
  parseGeminiModels,
  parseGladiaResult,
  readStringField,
  reduceChunks,
  sonioxResultToChunks,
  tidyGeminiText,
} from './normalize'

// Pure mappers: the seam that lets one STT consumer handle both providers.
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

describe('tidyGeminiText', () => {
  // Spaced-out strings below are verbatim gemini-3.5-transcribe-live output.
  test('removes spaces between Chinese/Japanese characters and punctuation', () => {
    expect(tidyGeminiText('今 天 我 们 来 玩 一 个 新 游 戏 。')).toBe('今天我们来玩一个新游戏。')
    expect(tidyGeminiText('感谢老板 送的')).toBe('感谢老板送的')
    expect(tidyGeminiText('今日は 良い 天気 です')).toBe('今日は良い天気です')
  })

  test('keeps spaces next to Latin text and between Korean words', () => {
    expect(tidyGeminiText('我觉得 OK 的')).toBe('我觉得 OK 的')
    expect(tidyGeminiText('안녕하세요 여러분')).toBe('안녕하세요 여러분')
  })

  test('leads Latin-script text with a space so consecutive finals stay apart', () => {
    expect(tidyGeminiText('Hello everyone, welcome to the stream.')).toBe(' Hello everyone, welcome to the stream.')
    expect(tidyGeminiText('3 个人')).toBe(' 3 个人')
    expect(tidyGeminiText('欢迎')).toBe('欢迎')
    expect(tidyGeminiText('')).toBe('')
  })
})

describe('parseGeminiLiveMessage', () => {
  const none = { setupComplete: false, goAway: false, final: undefined, interim: undefined }

  test('reads interim and final transcriptions', () => {
    expect(parseGeminiLiveMessage({ serverContent: { interimInputTranscription: { text: '你好' } } })).toEqual({
      ...none,
      interim: '你好',
    })
    expect(parseGeminiLiveMessage({ serverContent: { inputTranscription: { text: '你好世界。' } } })).toEqual({
      ...none,
      final: '你好世界。',
    })
  })

  test('tidies both texts', () => {
    expect(
      parseGeminiLiveMessage({ serverContent: { inputTranscription: { text: '今 天 我 们 来 玩 。' } } }).final
    ).toBe('今天我们来玩。')
    expect(parseGeminiLiveMessage({ serverContent: { interimInputTranscription: { text: 'Hello' } } }).interim).toBe(
      ' Hello'
    )
  })

  test('a text-less final still marks the utterance as finished', () => {
    expect(parseGeminiLiveMessage({ serverContent: { inputTranscription: {} } }).final).toBe('')
  })

  test('reads setupComplete and goAway markers', () => {
    expect(parseGeminiLiveMessage({ setupComplete: {} })).toEqual({ ...none, setupComplete: true })
    expect(parseGeminiLiveMessage({ goAway: { timeLeft: '50s' } })).toEqual({ ...none, goAway: true })
  })

  test('ignores unrelated and malformed messages', () => {
    expect(parseGeminiLiveMessage({ usageMetadata: { totalTokenCount: 3 } })).toEqual(none)
    expect(
      parseGeminiLiveMessage({ serverContent: { inputTranscription: 'x', interimInputTranscription: 1 } })
    ).toEqual(none)
    expect(parseGeminiLiveMessage(null)).toEqual(none)
  })
})

describe('parseGeminiModels', () => {
  const model = (name: string, methods: string[], displayName?: string) => ({
    name: `models/${name}`,
    displayName,
    supportedGenerationMethods: methods,
  })

  test('keeps only Live transcription models, ids without the models/ prefix, sorted', () => {
    const models = parseGeminiModels({
      models: [
        model('gemini-3.8-live', ['bidiGenerateContent'], 'Gemini 3.8 Live'),
        model('gemini-3.5-transcribe-live', ['bidiGenerateContent'], 'Gemini 3.5 Transcribe Live'),
        model('gemini-3.5-transcribe', ['generateContent', 'countTokens'], 'Gemini 3.5 Transcribe'),
        model('gemini-3.5-live-translate-preview', ['bidiGenerateContent']),
        model('gemini-4-transcribe-live', ['bidiGenerateContent']),
        model('gemini-3.5-transcribe-live', ['bidiGenerateContent']),
      ],
    })
    expect(models).toEqual([
      { id: 'gemini-3.5-transcribe-live', name: 'Gemini 3.5 Transcribe Live' },
      { id: 'gemini-4-transcribe-live' },
    ])
  })

  test('returns [] for a missing/non-array models list or malformed entries', () => {
    expect(parseGeminiModels({})).toEqual([])
    expect(parseGeminiModels({ models: 'nope' })).toEqual([])
    expect(parseGeminiModels({ models: [{ name: 'models/x-transcribe' }, null] })).toEqual([])
    expect(parseGeminiModels(null)).toEqual([])
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

describe('isWhisperHallucination', () => {
  test('matches stock silence hallucinations', () => {
    expect(isWhisperHallucination('字幕由Amara.org社区提供')).toBe(true)
    expect(isWhisperHallucination('由 Amara.org 社群提供的字幕')).toBe(true)
    expect(isWhisperHallucination('請不吝點贊 訂閱')).toBe(true)
    expect(isWhisperHallucination('谢谢观看。')).toBe(true)
    expect(isWhisperHallucination('Thanks for watching!')).toBe(true)
    expect(isWhisperHallucination('   ')).toBe(true)
  })

  test('keeps legitimate speech that merely mentions the trigger words', () => {
    expect(isWhisperHallucination('这个字幕组翻译得很好啊大家去看看')).toBe(false)
    expect(isWhisperHallucination('感谢大家今天来观看我的直播真的很开心')).toBe(false)
    expect(isWhisperHallucination('我们来看看这个翻译对不对')).toBe(false)
    expect(isWhisperHallucination('观看人数已经破万了')).toBe(false)
  })
})
