import type { SttProvider } from './types'

import { ELEVENLABS_TRANSLATION_MODE, OPENAI_TRANSLATION_MODEL } from '../const'

export interface TranslationCapabilities {
  mode: 'none' | 'optional' | 'required'
  targets: readonly string[]
}

const NONE: TranslationCapabilities = { mode: 'none', targets: [] }
const TARGETS = ['en', 'zh', 'ja', 'ko'] as const

/** Translation support belongs to the selected model and API, not the provider alone. */
export function translationCapabilities(
  provider: SttProvider,
  model: string,
  batchApi: 'openai' | 'whisper-cpp' = 'openai'
): TranslationCapabilities {
  const id = model.trim().replace(/^models\//, '')
  if (provider === 'soniox' && /^stt-rt-/.test(id)) return { mode: 'optional', targets: TARGETS }
  if (provider === 'gladia' && id === 'solaria-1') return { mode: 'optional', targets: TARGETS }
  if (provider === 'gemini' && /^gemini-.*-live-translate(?:-|$)/.test(id)) {
    return { mode: 'required', targets: TARGETS }
  }
  if (provider === 'elevenlabs' && id === ELEVENLABS_TRANSLATION_MODE) {
    return { mode: 'required', targets: TARGETS }
  }
  if (provider === 'openai' && (id === OPENAI_TRANSLATION_MODEL || id.startsWith(`${OPENAI_TRANSLATION_MODEL}-`))) {
    return { mode: 'required', targets: TARGETS }
  }
  if (provider === 'openai-compat') {
    const whisperCpp = batchApi === 'whisper-cpp' && !/(?:\.en|turbo)(?:\b|_)/i.test(id)
    if (whisperCpp || id === 'whisper-1' || id === 'whisper-large-v3') {
      return { mode: 'optional', targets: ['en'] }
    }
  }
  return NONE
}
