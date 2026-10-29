import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { int16ToBase64 } from './audio'
import { readStringField } from './normalize'
import { createTranslationSocket } from './translation-socket'

const ERROR_TYPES = new Set([
  'error',
  'auth_error',
  'rate_limited',
  'queue_overflow',
  'input_error',
  'transcriber_error',
  'translation_error',
  'quota_exceeded',
  'payment_issue',
  'unaccepted_terms',
])

/** ElevenLabs enterprise translation API; browser authentication uses a bearer token. */
export function createElevenLabsTranslationEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  return createTranslationSocket(
    {
      deviceId: params.audioDeviceId,
      sampleRate: 16000,
      connect: async () => {
        const target = params.translation?.targetLanguage.trim()
        const voice = params.translation?.voiceId?.trim()
        const token = params.translation?.authorizationToken?.trim()
        if (!target) throw new Error('请选择同传目标语言')
        if (!voice) throw new Error('请填写 ElevenLabs Voice ID')
        if (!token) throw new Error('请填写 ElevenLabs 同传 Authorization Token（需要企业权限）')
        const url = new URL('wss://api.elevenlabs.io/v1/translation/realtime')
        url.searchParams.set('authorization', token)
        url.searchParams.set('target_language', target)
        url.searchParams.set('voice_id', voice)
        url.searchParams.set('input_format', 'pcm_16000')
        if (params.languageHints[0]) url.searchParams.set('source_language', params.languageHints[0])
        return { url: url.toString() }
      },
      audio: frame => ({ message_type: 'input_audio_chunk', audio_base_64: int16ToBase64(frame) }),
      stopMessage: { message_type: 'end_of_stream' },
      onMessage: (message, controls) => {
        const type = readStringField(message, 'message_type')
        if (type === 'session_started') controls.ready()
        if (type === 'status' && readStringField(message, 'status') === 'stopped') controls.finish()
        if (type === 'partial_transcript' || type === 'final_transcript' || type === 'translation') {
          const text = readStringField(message, 'text')
          if (!text) return
          const isFinal = type !== 'partial_transcript'
          controls.emit({
            type: 'transcript',
            chunks: [
              {
                text: isFinal && !/\s$/.test(text) ? `${text} ` : text,
                isFinal,
                kind: type === 'translation' ? 'translation' : 'original',
              },
            ],
          })
          if (type === 'translation') controls.emit({ type: 'endpoint' })
        }
        if (type && ERROR_TYPES.has(type)) {
          controls.fail(new Error(`ElevenLabs ${type}: ${readStringField(message, 'error') ?? '同传失败'}`))
        }
      },
    },
    onEvent
  )
}
