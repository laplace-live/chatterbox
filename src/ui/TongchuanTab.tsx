import { useSignal } from '@preact/signals'
import { SonioxClient } from '@soniox/speech-to-text-web'
import { useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { applyReplacements } from '../replacement.js'
import {
  appendLog,
  sonioxApiKey,
  sonioxAutoSend,
  sonioxLanguageHints,
  sonioxMaxLength,
  sonioxTranslationEnabled,
  sonioxTranslationTarget,
} from '../store.js'
import { stripTrailingPunctuation, trimText } from '../utils.js'
import { tryAiEvasion } from './ai-evasion.js'

const SONIOX_SEND_INTERVAL_MS = 1100
const SONIOX_FLUSH_DELAY_MS = 5000

export function TongchuanTab() {
  const apiKeyVisible = useSignal(false)
  const state = useSignal<'stopped' | 'starting' | 'running' | 'stopping'>('stopped')
  const statusText = useSignal('未启动')
  const statusColor = useSignal('#666')
  const finalText = useSignal('')
  const nonFinalText = useSignal('')

  const clientRef = useRef<SonioxClient | null>(null)
  const accFinal = useRef('')
  const accTranslated = useRef('')
  const sendBuffer = useRef('')
  const flushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFlushing = useRef(false)
  const lastSendTime = useRef(0)

  const resetState = () => {
    state.value = 'stopped'
    statusText.value = '未启动'
    statusColor.value = '#666'
    clientRef.current = null
    sendBuffer.current = ''
    isFlushing.current = false
    lastSendTime.current = 0
    accFinal.current = ''
    accTranslated.current = ''
    finalText.value = ''
    nonFinalText.value = ''
    if (flushTimeout.current) {
      clearTimeout(flushTimeout.current)
      flushTimeout.current = null
    }
  }

  const sendSegment = async (segment: string) => {
    if (!segment.trim()) return
    const now = Date.now()
    const elapsed = now - lastSendTime.current
    if (elapsed < SONIOX_SEND_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, SONIOX_SEND_INTERVAL_MS - elapsed))
    }
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 同传：未找到登录信息')
        return
      }
      lastSendTime.current = Date.now()
      const result = await sendDanmaku(segment, roomId, csrfToken)
      if (result.success) {
        appendLog(`✅ 同传: ${segment}`)
      } else {
        appendLog(`❌ 同传: ${segment}，原因：${result.error}`)
        await tryAiEvasion(segment, roomId, csrfToken, '同传')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 同传发送出错：${msg}`)
    }
  }

  const flushBuffer = async () => {
    if (isFlushing.current) return
    isFlushing.current = true
    try {
      if (flushTimeout.current) {
        clearTimeout(flushTimeout.current)
        flushTimeout.current = null
      }
      if (!sendBuffer.current.trim()) return
      const maxLen = sonioxMaxLength.value || 40
      const processedText = applyReplacements(sendBuffer.current.trim())
      sendBuffer.current = ''
      const segments = trimText(processedText, maxLen)
      for (const segment of segments) {
        const clean = stripTrailingPunctuation(segment)
        if (clean) await sendSegment(clean)
      }
    } finally {
      isFlushing.current = false
    }
  }

  const addToBuffer = (text: string) => {
    if (!text) return
    sendBuffer.current += text
    if (flushTimeout.current) clearTimeout(flushTimeout.current)
    if (state.value === 'running') {
      flushTimeout.current = setTimeout(() => void flushBuffer(), SONIOX_FLUSH_DELAY_MS)
    }
  }

  const toggle = async () => {
    if (state.value === 'stopped') {
      const apiKey = sonioxApiKey.value.trim()
      if (!apiKey) {
        appendLog('⚠️ 请先输入 Soniox API Key')
        statusText.value = '请输入 API Key'
        statusColor.value = '#f44'
        return
      }
      finalText.value = ''
      nonFinalText.value = ''
      accFinal.current = ''
      accTranslated.current = ''
      state.value = 'starting'
      statusText.value = '正在连接…'
      statusColor.value = '#666'

      try {
        const client = new SonioxClient({ apiKey })
        clientRef.current = client

        const hints = sonioxLanguageHints.value
        const autoSend = sonioxAutoSend.value
        const translationEnabled = sonioxTranslationEnabled.value
        const translationTarget = sonioxTranslationTarget.value

        const startConfig: Parameters<SonioxClient['start']>[0] = {
          model: 'stt-rt-v3',
          languageHints: hints,
          enableEndpointDetection: true,
          onStarted: () => {
            state.value = 'running'
            if (translationEnabled) {
              const langNames: Record<string, string> = { en: 'English', zh: '中文', ja: '日本語' }
              statusText.value = `正在识别并翻译为${langNames[translationTarget] ?? translationTarget}…`
            } else {
              statusText.value = '正在识别…'
            }
            statusColor.value = '#36a185'
            appendLog(translationEnabled ? `🎤 同传已启动（翻译模式：${translationTarget}）` : '🎤 同传已启动')
          },
          onPartialResult: result => {
            let newFinal = ''
            let nonFinal = ''
            let newTransFinal = ''
            let transNonFinal = ''
            let endpointDetected = false
            for (const token of result.tokens ?? []) {
              if (token.text === '<end>' && token.is_final) {
                endpointDetected = true
                continue
              }
              if (translationEnabled) {
                if (token.translation_status === 'translation') {
                  if (token.is_final) newTransFinal += token.text
                  else transNonFinal += token.text
                }
              } else {
                if (token.is_final) newFinal += token.text
                else nonFinal += token.text
              }
            }
            if (translationEnabled) {
              if (newTransFinal && autoSend) addToBuffer(newTransFinal)
              accTranslated.current += newTransFinal
              let display = accTranslated.current
              if (display.length > 500) display = `…${display.slice(-500)}`
              finalText.value = display
              nonFinalText.value = transNonFinal
            } else {
              if (newFinal && autoSend) addToBuffer(newFinal)
              accFinal.current += newFinal
              let display = accFinal.current
              if (display.length > 500) display = `…${display.slice(-500)}`
              finalText.value = display
              nonFinalText.value = nonFinal
            }
            if (endpointDetected && autoSend) {
              setTimeout(() => void flushBuffer(), translationEnabled ? 300 : 0)
            }
          },
          onFinished: async () => {
            let waitCount = 0
            while (isFlushing.current && waitCount < 100) {
              await new Promise(r => setTimeout(r, 100))
              waitCount++
            }
            await flushBuffer()
            appendLog('🎤 同传已停止')
            resetState()
          },
          onError: (_status, message) => {
            console.error('Soniox error:', message)
            appendLog(`🔴 Soniox 错误：${message}`)
            statusText.value = `错误: ${message}`
            statusColor.value = '#f44'
            if (state.value !== 'stopping' && state.value !== 'stopped') resetState()
          },
        }
        if (translationEnabled) {
          startConfig.translation = { type: 'one_way', target_language: translationTarget }
        }
        client.start(startConfig)
      } catch (err) {
        console.error('Soniox startup error:', err)
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
          appendLog('❌ 麦克风权限被拒绝，请在浏览器设置中允许使用麦克风')
          statusText.value = '麦克风权限被拒绝'
        } else if (err instanceof Error && err.name === 'NotFoundError') {
          appendLog('❌ 未找到麦克风设备')
          statusText.value = '未找到麦克风'
        } else {
          appendLog(`🔴 启动同传失败：${message}`)
          statusText.value = `启动失败: ${message}`
        }
        statusColor.value = '#f44'
        resetState()
      }
    } else if (state.value === 'running') {
      state.value = 'stopping'
      statusText.value = '正在停止…'
      if (clientRef.current) clientRef.current.stop()
    }
  }

  const updateLangHints = (lang: string, checked: boolean) => {
    let hints = [...sonioxLanguageHints.value]
    if (checked && !hints.includes(lang)) hints.push(lang)
    else if (!checked) hints = hints.filter(h => h !== lang)
    if (hints.length === 0) hints = ['zh']
    sonioxLanguageHints.value = hints
  }

  const btnText =
    state.value === 'starting'
      ? '启动中…'
      : state.value === 'stopping'
        ? '停止中…'
        : state.value === 'running'
          ? '停止同传'
          : '开始同传'

  const hints = sonioxLanguageHints.value

  return (
    <>
      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>Soniox API 设置</div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <input
            type={apiKeyVisible.value ? 'text' : 'password'}
            placeholder='输入 Soniox API Key'
            style={{ flex: 1, minWidth: '150px' }}
            value={sonioxApiKey.value}
            onInput={e => {
              sonioxApiKey.value = (e.target as HTMLInputElement).value
            }}
          />
          <button
            type='button'
            style={{ cursor: 'pointer' }}
            onClick={() => {
              apiKeyVisible.value = !apiKeyVisible.value
            }}
          >
            {apiKeyVisible.value ? '隐藏' : '显示'}
          </button>
        </div>
        <div style={{ marginBlock: '.5em', color: '#666', fontSize: '0.9em' }}>
          前往{' '}
          <a href='https://soniox.com/' target='_blank' style={{ color: '#288bb8' }} rel='noopener'>
            Soniox
          </a>{' '}
          注册账号并获取 API Key
        </div>
      </div>

      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>语音识别设置</div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <span>语言提示：</span>
          {(['zh', 'en', 'ja', 'ko'] as const).map(lang => {
            const labels: Record<string, string> = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }
            return (
              <span key={lang} style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
                <input
                  type='checkbox'
                  checked={hints.includes(lang)}
                  onChange={e => updateLangHints(lang, (e.target as HTMLInputElement).checked)}
                />
                <label htmlFor={lang}>{labels[lang]}</label>
              </span>
            )
          })}
          <label htmlFor='sonioxMaxLength'>超过</label>
          <input
            id='sonioxMaxLength'
            type='number'
            min='1'
            style={{ width: '40px' }}
            value={sonioxMaxLength.value}
            onInput={e => {
              const v = parseInt((e.target as HTMLInputElement).value, 10) || 1
              sonioxMaxLength.value = Math.max(1, v)
            }}
          />
          <span>字自动分段</span>
        </div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='sonioxAutoSend'
              type='checkbox'
              checked={sonioxAutoSend.value}
              onInput={e => {
                sonioxAutoSend.value = (e.target as HTMLInputElement).checked
              }}
            />
            <label htmlFor='sonioxAutoSend'>识别完成后自动发送弹幕</label>
          </span>
        </div>
      </div>

      <div style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '.5em' }}>实时翻译设置</div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='sonioxTranslationEnabled'
              type='checkbox'
              checked={sonioxTranslationEnabled.value}
              onInput={e => {
                sonioxTranslationEnabled.value = (e.target as HTMLInputElement).checked
              }}
            />
            <label htmlFor='sonioxTranslationEnabled'>启用实时翻译</label>
          </span>
        </div>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor='sonioxTranslationTarget'>翻译目标语言：</label>
          <select
            id='sonioxTranslationTarget'
            style={{ minWidth: '80px' }}
            value={sonioxTranslationTarget.value}
            onChange={e => {
              sonioxTranslationTarget.value = (e.target as HTMLSelectElement).value
            }}
          >
            <option value='en'>English</option>
            <option value='zh'>中文</option>
            <option value='ja'>日本語</option>
          </select>
        </div>
        <div style={{ marginTop: '.5em', color: '#666', fontSize: '0.9em' }}>启用后将发送翻译结果而非原始识别文字</div>
      </div>

      <div style={{ margin: '.5em 0' }}>
        <div style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}>
          <button type='button' onClick={() => void toggle()}>
            {btnText}
          </button>
          <span style={{ color: statusColor.value }}>{statusText.value}</span>
        </div>
        <div style={{ marginBlock: '.5em' }}>
          <div style={{ fontWeight: 'bold', marginBottom: '.25em' }}>实时识别结果：</div>
          <div
            style={{
              padding: '.5em',
              background: 'var(--bg2, #f5f5f5)',
              borderRadius: '4px',
              minHeight: '40px',
              maxHeight: '100px',
              overflowY: 'auto',
              wordBreak: 'break-all',
            }}
          >
            <span>{finalText.value}</span>
            <span style={{ color: '#999' }}>{nonFinalText.value}</span>
          </div>
        </div>
      </div>
    </>
  )
}
