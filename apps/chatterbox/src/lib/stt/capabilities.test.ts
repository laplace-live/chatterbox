import { describe, expect, test } from 'bun:test'

import { translationCapabilities } from './capabilities'

describe('translationCapabilities', () => {
  test('keeps transcription-only models separate from translators at the same provider', () => {
    expect(translationCapabilities('gemini', 'gemini-3.5-transcribe-live').mode).toBe('none')
    expect(translationCapabilities('gemini', 'models/gemini-3.5-live-translate-preview').mode).toBe('required')
    expect(translationCapabilities('gemini', 'gemini-3.5-flash-live').mode).toBe('none')
    expect(translationCapabilities('elevenlabs', 'scribe_v2_realtime').mode).toBe('none')
    expect(translationCapabilities('elevenlabs', 'realtime-translation').mode).toBe('required')
    expect(translationCapabilities('deepgram', 'nova-3').mode).toBe('none')
  })

  test('allows translation to be disabled when the same model supports original transcripts', () => {
    expect(translationCapabilities('soniox', 'stt-rt-v5').mode).toBe('optional')
    expect(translationCapabilities('soniox', 'stt-async-v5').mode).toBe('none')
    expect(translationCapabilities('gladia', 'solaria-1').mode).toBe('optional')
    expect(translationCapabilities('gladia', 'unknown').mode).toBe('none')
    expect(translationCapabilities('openai', 'gpt-realtime-translate').mode).toBe('required')
    expect(translationCapabilities('openai', 'gpt-realtime').mode).toBe('none')
  })

  test('does not infer arbitrary translation support from an OpenAI-compatible endpoint', () => {
    expect(translationCapabilities('openai-compat', 'custom-model').mode).toBe('none')
    expect(translationCapabilities('openai-compat', 'gpt-4o-transcribe').mode).toBe('none')
    expect(translationCapabilities('openai-compat', 'whisper-large-v3-turbo').mode).toBe('none')
    expect(translationCapabilities('openai-compat', 'whisper-1')).toEqual({ mode: 'optional', targets: ['en'] })
    expect(translationCapabilities('openai-compat', 'whisper-large-v3').targets).toEqual(['en'])
  })

  test('requires an explicit whisper.cpp contract and excludes English-only models', () => {
    expect(translationCapabilities('openai-compat', 'large-v3', 'whisper-cpp').targets).toEqual(['en'])
    expect(translationCapabilities('openai-compat', 'ggml-small.en.bin', 'whisper-cpp').mode).toBe('none')
    expect(translationCapabilities('openai-compat', 'large-v3-turbo', 'whisper-cpp').mode).toBe('none')
  })
})
