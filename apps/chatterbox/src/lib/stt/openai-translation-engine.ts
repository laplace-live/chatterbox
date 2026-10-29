import type { SttEngine, SttEngineEventHandler, SttSessionParams } from './types'

import { OPENAI_TRANSLATION_MODEL } from '../const'
import { gmFetch } from '../gm-fetch'
import { int16ToBase64 } from './audio'
import { readField, readStringField } from './normalize'
import { createTranslationSocket } from './translation-socket'

/** OpenAI continuous translation, authenticated with a short-lived browser credential. */
export function createOpenAiTranslationEngine(params: SttSessionParams, onEvent: SttEngineEventHandler): SttEngine {
  return createTranslationSocket(
    {
      deviceId: params.audioDeviceId,
      sampleRate: 24000,
      connect: async signal => {
        const key = params.apiKey.trim()
        const language = params.translation?.targetLanguage.trim()
        if (!key) throw new Error('请填写 OpenAI API Key')
        if (!language) throw new Error('请选择同传目标语言')
        const base = new URL(params.baseUrl?.trim() || 'https://api.openai.com/v1')
        if (
          base.protocol !== 'https:' &&
          !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
        ) {
          throw new Error('OpenAI 接口地址必须使用 HTTPS（本机地址可使用 HTTP）')
        }
        if (base.username || base.password || base.search || base.hash)
          throw new Error('OpenAI 接口地址不能包含登录信息、查询参数或片段')
        const model = params.model.trim() || OPENAI_TRANSLATION_MODEL
        base.pathname = `${base.pathname.replace(/\/+$/, '')}/realtime/translations`
        const response = await gmFetch(`${base.toString()}/client_secrets`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session: {
              model,
              audio: {
                input: { transcription: { model: 'gpt-realtime-whisper' } },
                output: { language },
              },
            },
          }),
          signal,
          timeout: 15000,
        })
        if (!response.ok) throw new Error(`OpenAI 同传认证失败（HTTP ${response.status}）`)
        const body: unknown = await response.json()
        const token = readStringField(body, 'value')
        if (!token) throw new Error('OpenAI 同传凭据响应缺少 value')
        base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
        base.searchParams.set('model', model)
        return { url: base.toString(), protocols: ['realtime', `openai-insecure-api-key.${token}`] }
      },
      audio: frame => ({ type: 'session.input_audio_buffer.append', audio: int16ToBase64(frame) }),
      stopMessage: { type: 'session.close' },
      onMessage: (message, controls) => {
        const type = readStringField(message, 'type')
        if (type === 'session.created') controls.ready()
        if (type === 'session.closed') controls.finish()
        if (type === 'session.output_transcript.delta' || type === 'session.input_transcript.delta') {
          const text = readStringField(message, 'delta')
          if (!text) return
          const translated = type === 'session.output_transcript.delta'
          controls.emit({
            type: 'transcript',
            chunks: [{ text, isFinal: true, kind: translated ? 'translation' : 'original' }],
          })
          if (translated && /[.!?。！？]\s*$/.test(text)) controls.emit({ type: 'endpoint' })
        }
        if (type === 'error') {
          controls.fail(
            new Error(`OpenAI 同传失败：${readStringField(readField(message, 'error'), 'message') ?? '未知错误'}`)
          )
        }
      },
    },
    onEvent
  )
}
