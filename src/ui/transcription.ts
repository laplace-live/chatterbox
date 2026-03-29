import { SonioxClient } from '@soniox/speech-to-text-web'

import { GM_getValue, GM_setValue } from '$'
import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { applyReplacements } from '../replacement.js'
import { appendToLimitedLog, stripTrailingPunctuation, trimText } from '../utils.js'
import { tryAiEvasion } from './ai-evasion.js'

const SONIOX_SEND_INTERVAL_MS = 1100
const SONIOX_FLUSH_DELAY_MS = 5000

export function setupTranscription(): void {
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLines = GM_getValue<number>('maxLogLines', 1000)
  const sonioxApiKeyInput = document.getElementById('sonioxApiKey') as HTMLInputElement
  const sonioxApiKeyToggle = document.getElementById('sonioxApiKeyToggle') as HTMLButtonElement
  const sonioxLangZhInput = document.getElementById('sonioxLangZh') as HTMLInputElement
  const sonioxLangEnInput = document.getElementById('sonioxLangEn') as HTMLInputElement
  const sonioxLangJaInput = document.getElementById('sonioxLangJa') as HTMLInputElement
  const sonioxLangKoInput = document.getElementById('sonioxLangKo') as HTMLInputElement
  const sonioxMaxLengthInput = document.getElementById('sonioxMaxLength') as HTMLInputElement
  const sonioxAutoSendInput = document.getElementById('sonioxAutoSend') as HTMLInputElement
  const sonioxTranslationEnabledInput = document.getElementById('sonioxTranslationEnabled') as HTMLInputElement
  const sonioxTranslationTargetSelect = document.getElementById('sonioxTranslationTarget') as HTMLSelectElement
  const sonioxStartBtn = document.getElementById('sonioxStartBtn') as HTMLButtonElement
  const sonioxStatus = document.getElementById('sonioxStatus') as HTMLSpanElement
  const sonioxFinalText = document.getElementById('sonioxFinalText') as HTMLSpanElement
  const sonioxNonFinalText = document.getElementById('sonioxNonFinalText') as HTMLSpanElement

  let sonioxRecordTranscribe: SonioxClient | null = null
  let sonioxState: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped'
  let sonioxAccumulatedFinalText = ''
  let sonioxAccumulatedTranslatedText = ''
  let sonioxSendBuffer = ''
  let sonioxFlushTimeout: ReturnType<typeof setTimeout> | null = null
  let sonioxIsFlushing = false
  let sonioxLastSendTime = 0

  sonioxApiKeyToggle?.addEventListener('click', () => {
    if (sonioxApiKeyInput.type === 'password') {
      sonioxApiKeyInput.type = 'text'
      sonioxApiKeyToggle.textContent = '隐藏'
    } else {
      sonioxApiKeyInput.type = 'password'
      sonioxApiKeyToggle.textContent = '显示'
    }
  })

  sonioxApiKeyInput?.addEventListener('input', () => {
    GM_setValue('sonioxApiKey', sonioxApiKeyInput.value)
  })

  const updateLanguageHints = (): void => {
    const hints: string[] = []
    if (sonioxLangZhInput?.checked) hints.push('zh')
    if (sonioxLangEnInput?.checked) hints.push('en')
    if (sonioxLangJaInput?.checked) hints.push('ja')
    if (sonioxLangKoInput?.checked) hints.push('ko')
    if (hints.length === 0) {
      hints.push('zh')
      if (sonioxLangZhInput) sonioxLangZhInput.checked = true
    }
    GM_setValue('sonioxLanguageHints', hints)
  }
  sonioxLangZhInput?.addEventListener('change', updateLanguageHints)
  sonioxLangEnInput?.addEventListener('change', updateLanguageHints)
  sonioxLangJaInput?.addEventListener('change', updateLanguageHints)
  sonioxLangKoInput?.addEventListener('change', updateLanguageHints)

  sonioxMaxLengthInput?.addEventListener('input', () => {
    const value = parseInt(sonioxMaxLengthInput.value, 10) || 1
    const corrected = Math.max(1, value)
    sonioxMaxLengthInput.value = String(corrected)
    GM_setValue('sonioxMaxLength', corrected)
  })

  sonioxAutoSendInput?.addEventListener('input', () => {
    GM_setValue('sonioxAutoSend', sonioxAutoSendInput.checked)
  })
  sonioxTranslationEnabledInput?.addEventListener('input', () => {
    GM_setValue('sonioxTranslationEnabled', sonioxTranslationEnabledInput.checked)
  })
  sonioxTranslationTargetSelect?.addEventListener('change', () => {
    GM_setValue('sonioxTranslationTarget', sonioxTranslationTargetSelect.value)
  })

  function resetSonioxState(): void {
    sonioxStartBtn.textContent = '开始同传'
    sonioxStatus.textContent = '未启动'
    sonioxStatus.style.color = '#666'
    sonioxState = 'stopped'
    sonioxRecordTranscribe = null
    sonioxSendBuffer = ''
    sonioxIsFlushing = false
    sonioxLastSendTime = 0
    sonioxAccumulatedFinalText = ''
    sonioxAccumulatedTranslatedText = ''
    sonioxFinalText.textContent = ''
    sonioxNonFinalText.textContent = ''
    if (sonioxFlushTimeout) {
      clearTimeout(sonioxFlushTimeout)
      sonioxFlushTimeout = null
    }
  }

  async function sendSegmentAsDanmaku(segment: string): Promise<void> {
    if (!segment.trim()) return
    const now = Date.now()
    const timeSinceLastSend = now - sonioxLastSendTime
    if (timeSinceLastSend < SONIOX_SEND_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, SONIOX_SEND_INTERVAL_MS - timeSinceLastSend))
    }
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendToLimitedLog(msgLogs, '❌ 同传：未找到登录信息', maxLogLines)
        return
      }
      sonioxLastSendTime = Date.now()
      const result = await sendDanmaku(segment, roomId, csrfToken)
      if (result.success) {
        appendToLimitedLog(msgLogs, `✅ 同传: ${segment}`, maxLogLines)
      } else {
        appendToLimitedLog(msgLogs, `❌ 同传: ${segment}，原因：${result.error}`, maxLogLines)
        await tryAiEvasion(segment, roomId, csrfToken, '同传', msgLogs, maxLogLines)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendToLimitedLog(msgLogs, `🔴 同传发送出错：${msg}`, maxLogLines)
    }
  }

  async function flushSonioxBuffer(): Promise<void> {
    if (sonioxIsFlushing) return
    sonioxIsFlushing = true
    try {
      if (sonioxFlushTimeout) {
        clearTimeout(sonioxFlushTimeout)
        sonioxFlushTimeout = null
      }
      if (!sonioxSendBuffer.trim()) return
      const maxLen = parseInt(String(GM_getValue('sonioxMaxLength')), 10) || 40
      const processedText = applyReplacements(sonioxSendBuffer.trim())
      sonioxSendBuffer = ''
      const segments = trimText(processedText, maxLen)
      for (const segment of segments) {
        const clean = stripTrailingPunctuation(segment)
        if (clean) await sendSegmentAsDanmaku(clean)
      }
    } finally {
      sonioxIsFlushing = false
    }
  }

  function addToSendBuffer(text: string): void {
    if (!text) return
    sonioxSendBuffer += text
    if (sonioxFlushTimeout) clearTimeout(sonioxFlushTimeout)
    if (sonioxState === 'running') {
      sonioxFlushTimeout = setTimeout(() => void flushSonioxBuffer(), SONIOX_FLUSH_DELAY_MS)
    }
  }

  async function toggleSonioxTranscription(): Promise<void> {
    if (sonioxState === 'stopped') {
      const apiKey = String(GM_getValue('sonioxApiKey', ''))
      if (!apiKey.trim()) {
        appendToLimitedLog(msgLogs, '⚠️ 请先输入 Soniox API Key', maxLogLines)
        sonioxStatus.textContent = '请输入 API Key'
        sonioxStatus.style.color = '#f44'
        return
      }
      sonioxFinalText.textContent = ''
      sonioxNonFinalText.textContent = ''
      sonioxAccumulatedFinalText = ''
      sonioxAccumulatedTranslatedText = ''
      sonioxStartBtn.textContent = '启动中…'
      sonioxStatus.textContent = '正在连接…'
      sonioxStatus.style.color = '#666'
      sonioxState = 'starting'

      try {
        const client = new SonioxClient({ apiKey: apiKey.trim() })
        sonioxRecordTranscribe = client

        const languageHints = (GM_getValue('sonioxLanguageHints', ['zh']) as string[]) ?? ['zh']
        const autoSend = GM_getValue('sonioxAutoSend', true) as boolean
        const translationEnabled = GM_getValue('sonioxTranslationEnabled', false) as boolean
        const translationTarget = String(GM_getValue('sonioxTranslationTarget', 'en'))

        const startConfig: Parameters<SonioxClient['start']>[0] = {
          model: 'stt-rt-v3',
          languageHints,
          enableEndpointDetection: true,
          onStarted: () => {
            sonioxState = 'running'
            sonioxStartBtn.textContent = '停止同传'
            if (translationEnabled) {
              const langNames: Record<string, string> = { en: 'English', zh: '中文', ja: '日本語' }
              sonioxStatus.textContent = `正在识别并翻译为${langNames[translationTarget] ?? translationTarget}…`
            } else {
              sonioxStatus.textContent = '正在识别…'
            }
            sonioxStatus.style.color = '#36a185'
            appendToLimitedLog(
              msgLogs,
              translationEnabled ? `🎤 同传已启动（翻译模式：${translationTarget}）` : '🎤 同传已启动',
              maxLogLines
            )
          },
          onPartialResult: result => {
            let newFinalText = ''
            let nonFinalText = ''
            let newTranslatedFinalText = ''
            let translatedNonFinalText = ''
            let endpointDetected = false
            const tokens = result.tokens ?? []
            for (const token of tokens) {
              if (token.text === '<end>' && token.is_final) {
                endpointDetected = true
                continue
              }
              if (translationEnabled) {
                if (token.translation_status === 'translation') {
                  if (token.is_final) newTranslatedFinalText += token.text
                  else translatedNonFinalText += token.text
                }
              } else {
                if (token.is_final) newFinalText += token.text
                else nonFinalText += token.text
              }
            }
            if (translationEnabled) {
              if (newTranslatedFinalText && autoSend) addToSendBuffer(newTranslatedFinalText)
              sonioxAccumulatedTranslatedText += newTranslatedFinalText
              let displayText = sonioxAccumulatedTranslatedText
              if (displayText.length > 500) displayText = `…${displayText.slice(-500)}`
              sonioxFinalText.textContent = displayText
              sonioxNonFinalText.textContent = translatedNonFinalText
            } else {
              if (newFinalText && autoSend) addToSendBuffer(newFinalText)
              sonioxAccumulatedFinalText += newFinalText
              let displayText = sonioxAccumulatedFinalText
              if (displayText.length > 500) displayText = `…${displayText.slice(-500)}`
              sonioxFinalText.textContent = displayText
              sonioxNonFinalText.textContent = nonFinalText
            }
            if (endpointDetected && autoSend) {
              setTimeout(() => void flushSonioxBuffer(), translationEnabled ? 300 : 0)
            }
            const transcriptEl = document.getElementById('sonioxTranscript')
            if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight
          },
          onFinished: async () => {
            let waitCount = 0
            while (sonioxIsFlushing && waitCount < 100) {
              await new Promise(r => setTimeout(r, 100))
              waitCount++
            }
            await flushSonioxBuffer()
            appendToLimitedLog(msgLogs, '🎤 同传已停止', maxLogLines)
            resetSonioxState()
          },
          onError: (_status, message) => {
            console.error('Soniox error:', message)
            appendToLimitedLog(msgLogs, `🔴 Soniox 错误：${message}`, maxLogLines)
            sonioxStatus.textContent = `错误: ${message}`
            sonioxStatus.style.color = '#f44'
            if (sonioxState !== 'stopping' && sonioxState !== 'stopped') resetSonioxState()
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
          appendToLimitedLog(msgLogs, '❌ 麦克风权限被拒绝，请在浏览器设置中允许使用麦克风', maxLogLines)
          sonioxStatus.textContent = '麦克风权限被拒绝'
        } else if (err instanceof Error && err.name === 'NotFoundError') {
          appendToLimitedLog(msgLogs, '❌ 未找到麦克风设备', maxLogLines)
          sonioxStatus.textContent = '未找到麦克风'
        } else {
          appendToLimitedLog(msgLogs, `🔴 启动同传失败：${message}`, maxLogLines)
          sonioxStatus.textContent = `启动失败: ${message}`
        }
        sonioxStatus.style.color = '#f44'
        resetSonioxState()
      }
    } else if (sonioxState === 'running') {
      sonioxStartBtn.textContent = '停止中…'
      sonioxStatus.textContent = '正在停止…'
      sonioxState = 'stopping'
      if (sonioxRecordTranscribe) sonioxRecordTranscribe.stop()
    }
  }

  sonioxStartBtn?.addEventListener('click', () => void toggleSonioxTranscription())
}
