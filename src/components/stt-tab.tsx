import { useSignal } from '@preact/signals'
import { SonioxClient } from '@soniox/speech-to-text-web'
import { useEffect, useRef } from 'preact/hooks'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import {
  sonioxApiKey,
  sonioxAudioDeviceId,
  sonioxAutoSend,
  sonioxLanguageHints,
  sonioxMaxLength,
  sonioxTranslationEnabled,
  sonioxTranslationTarget,
  sonioxWrapBrackets,
  sttRunning,
} from '../lib/store'
import { splitTextSmart, stripTrailingPunctuation } from '../lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'

const SONIOX_FLUSH_DELAY_MS = 5000

// Each visible block in this tab is wrapped in this section shape (vertical
// rhythm + bottom divider). Repeated across API key / recognition / translation
// settings.
const SECTION_CLASS = 'lc-my-2 lc-pb-2 lc-border-b lc-border-b-solid lc-border-b-ga2'
const HEADING_CLASS = 'lc-font-bold lc-mb-2'
const ROW_CLASS = 'lc-flex lc-gap-2 lc-items-center lc-flex-wrap lc-mb-2'

export function SttTab() {
  const apiKeyVisible = useSignal(false)
  const state = useSignal<'stopped' | 'starting' | 'running' | 'stopping'>('stopped')
  const statusText = useSignal('未启动')
  const statusColor = useSignal('#666')
  const finalText = useSignal('')
  const nonFinalText = useSignal('')
  const audioDevices = useSignal<MediaDeviceInfo[]>([])

  const clientRef = useRef<SonioxClient | null>(null)
  const accFinal = useRef('')
  const accTranslated = useRef('')
  const sendBuffer = useRef('')
  const flushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFlushing = useRef(false)

  const enumerateMics = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      audioDevices.value = devices.filter(d => d.kind === 'audioinput')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 枚举麦克风失败：${msg}`)
    }
  }

  // Browsers hide device labels until the page has been granted microphone
  // permission at least once. Calling getUserMedia briefly forces the prompt
  // (or returns instantly if already granted), then we re-enumerate to pick
  // up the now-visible labels.
  const requestMicPermission = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      appendLog('🔴 当前浏览器不支持麦克风访问')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
      await enumerateMics()
    } catch (err) {
      const name = err instanceof Error ? err.name : ''
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        appendLog('❌ 麦克风权限被拒绝，请在浏览器地址栏左侧的权限设置中允许使用麦克风')
      } else if (name === 'NotFoundError') {
        appendLog('❌ 未找到麦克风设备')
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        appendLog(`🔴 麦克风权限请求失败：${msg}`)
      }
    }
  }

  useEffect(() => {
    void enumerateMics()
    const onChange = () => void enumerateMics()
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange)
  }, [])

  const resetState = () => {
    state.value = 'stopped'
    sttRunning.value = false
    statusText.value = '未启动'
    statusColor.value = '#666'
    clientRef.current = null
    sendBuffer.current = ''
    isFlushing.current = false
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
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 同传：未找到登录信息')
        return
      }
      const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.STT)
      appendLog(result, '同传', segment)
      if (!result.success && !result.cancelled) {
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
      const wrap = sonioxWrapBrackets.value
      const maxLen = sonioxMaxLength.value || 40
      // Reserve 2 graphemes for the 【】 wrapper so the wrapped segment still
      // fits within the user's configured max length.
      const splitLen = wrap ? Math.max(1, maxLen - 2) : maxLen
      const processedText = applyReplacements(sendBuffer.current.trim())
      sendBuffer.current = ''
      const segments = splitTextSmart(processedText, splitLen)
      for (const segment of segments) {
        const clean = stripTrailingPunctuation(segment)
        if (!clean) continue
        await sendSegment(wrap ? `【${clean}】` : clean)
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
        const translationEnabled = sonioxTranslationEnabled.value
        const translationTarget = sonioxTranslationTarget.value

        // Validate the saved device is still present; auto-fall back to
        // system default (and persist the reset) if the user unplugged it
        // since they last picked it.
        const savedDeviceId = sonioxAudioDeviceId.value
        const deviceStillAvailable = !savedDeviceId || audioDevices.value.some(d => d.deviceId === savedDeviceId)
        if (savedDeviceId && !deviceStillAvailable) {
          appendLog('⚠️ 已选麦克风不可用，已切换至系统默认')
          sonioxAudioDeviceId.value = ''
        }
        const effectiveDeviceId = deviceStillAvailable ? savedDeviceId : ''

        const startConfig: Parameters<SonioxClient['start']>[0] = {
          model: 'stt-rt-v3',
          languageHints: hints,
          enableEndpointDetection: true,
          onStarted: () => {
            state.value = 'running'
            sttRunning.value = true
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
              if (newTransFinal && sonioxAutoSend.value) addToBuffer(newTransFinal)
              accTranslated.current += newTransFinal
              let display = accTranslated.current
              if (display.length > 500) display = `…${display.slice(-500)}`
              finalText.value = display
              nonFinalText.value = transNonFinal
            } else {
              if (newFinal && sonioxAutoSend.value) addToBuffer(newFinal)
              accFinal.current += newFinal
              let display = accFinal.current
              if (display.length > 500) display = `…${display.slice(-500)}`
              finalText.value = display
              nonFinalText.value = nonFinal
            }
            if (endpointDetected && sonioxAutoSend.value) {
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
        if (effectiveDeviceId) {
          // Mirror the SDK's internal defaults (raw mono, no DSP) so that
          // adding a deviceId doesn't silently flip echo cancellation /
          // noise suppression / AGC back to the browser's "true" defaults
          // — Soniox recommends raw audio for best transcription quality.
          startConfig.audioConstraints = {
            deviceId: { exact: effectiveDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            sampleRate: 44100,
          }
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
  const devices = audioDevices.value
  // Labels are blanked by the browser until the page has been granted
  // microphone permission. We use the presence of any non-empty label as a
  // proxy for "permission already granted, no need to nag the user".
  const hasMicLabels = devices.some(d => d.label)
  const savedDeviceId = sonioxAudioDeviceId.value
  const savedDeviceMissing = Boolean(savedDeviceId) && !devices.some(d => d.deviceId === savedDeviceId)

  return (
    <>
      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>Soniox API 设置</div>
        <div class={ROW_CLASS}>
          <Input
            type={apiKeyVisible.value ? 'text' : 'password'}
            placeholder='输入 Soniox API Key'
            className='lc-flex-1 lc-min-w-[150px]'
            value={sonioxApiKey.value}
            onInput={e => {
              sonioxApiKey.value = e.currentTarget.value
            }}
          />
          <Button
            variant='outline'
            size='sm'
            onClick={() => {
              apiKeyVisible.value = !apiKeyVisible.value
            }}
          >
            {apiKeyVisible.value ? '隐藏' : '显示'}
          </Button>
        </div>
        <div class='lc-my-2 lc-text-[#666] lc-text-[.9em]'>
          前往{' '}
          <a href='https://soniox.com/' target='_blank' class='lc-text-link' rel='noopener'>
            Soniox
          </a>{' '}
          注册账号并获取 API Key
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>语音识别设置</div>
        <div class={ROW_CLASS}>
          <Label htmlFor='sonioxAudioDevice'>设备</Label>
          <NativeSelect
            id='sonioxAudioDevice'
            className='lc-flex-1 lc-min-w-[150px] lc-pr-5'
            value={savedDeviceId}
            onChange={e => {
              sonioxAudioDeviceId.value = e.currentTarget.value
            }}
          >
            <option value=''>系统默认</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || `mic-${i}`} value={d.deviceId}>
                {d.label || `麦克风 ${i + 1}`}
              </option>
            ))}
            {/* Surface a stale id so the user can see *something* is
                selected and switch away — without this the <select> would
                silently fall back to "系统默认" while the underlying
                stored id remains unchanged. */}
            {savedDeviceMissing && <option value={savedDeviceId}>(已保存设备不可用)</option>}
          </NativeSelect>
          {!hasMicLabels && (
            <Button variant='outline' size='sm' onClick={() => void requestMicPermission()}>
              授权
            </Button>
          )}
          <Button variant='outline' size='sm' onClick={() => void enumerateMics()}>
            刷新
          </Button>
        </div>
        <div class={ROW_CLASS}>
          <span>语言提示：</span>
          {(['zh', 'en', 'ja', 'ko'] as const).map(lang => {
            const labels: Record<string, string> = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }
            return (
              <Checkbox
                key={lang}
                id={`stt-lang-${lang}`}
                checked={hints.includes(lang)}
                onChange={e => updateLangHints(lang, e.currentTarget.checked)}
                label={labels[lang]}
              />
            )
          })}
          <Label htmlFor='sonioxMaxLength'>超过</Label>
          <Input
            id='sonioxMaxLength'
            type='number'
            min='1'
            className='lc-w-[50px]'
            value={sonioxMaxLength.value}
            onInput={e => {
              const v = parseInt(e.currentTarget.value, 10) || 1
              sonioxMaxLength.value = Math.max(1, v)
            }}
          />
          <span>字自动分段</span>
        </div>
        <div class='lc-flex lc-gap-3 lc-items-center lc-flex-wrap'>
          <Checkbox
            id='sonioxAutoSend'
            checked={sonioxAutoSend.value}
            onInput={e => {
              sonioxAutoSend.value = e.currentTarget.checked
            }}
            label='识别完成后自动发送弹幕'
          />
          <Checkbox
            id='sonioxWrapBrackets'
            checked={sonioxWrapBrackets.value}
            onInput={e => {
              sonioxWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹同传内容'
          />
        </div>
      </div>

      <div class={SECTION_CLASS}>
        <div class={HEADING_CLASS}>实时翻译设置</div>
        <div class={ROW_CLASS}>
          <Checkbox
            id='sonioxTranslationEnabled'
            checked={sonioxTranslationEnabled.value}
            onInput={e => {
              sonioxTranslationEnabled.value = e.currentTarget.checked
            }}
            label='启用实时翻译'
          />
        </div>
        <div class='lc-flex lc-gap-2 lc-items-center lc-flex-wrap'>
          <Label htmlFor='sonioxTranslationTarget'>翻译目标语言：</Label>
          <NativeSelect
            id='sonioxTranslationTarget'
            className='lc-min-w-[80px]'
            value={sonioxTranslationTarget.value}
            onChange={e => {
              sonioxTranslationTarget.value = e.currentTarget.value
            }}
          >
            <option value='en'>English</option>
            <option value='zh'>中文</option>
            <option value='ja'>日本語</option>
          </NativeSelect>
        </div>
        <div class='lc-mt-2 lc-text-[#666] lc-text-[.9em]'>启用后将发送翻译结果而非原始识别文字</div>
      </div>

      <div class='lc-my-2'>
        <div class={ROW_CLASS}>
          <Button
            variant={state.value === 'running' ? 'destructive' : 'default'}
            size='sm'
            disabled={state.value === 'starting' || state.value === 'stopping'}
            onClick={() => void toggle()}
          >
            {btnText}
          </Button>
          {/* statusColor cycles through three values driven by external SDK
              callbacks (stopped/info, running/success, error). Keeping it as
              an inline color avoids enumerating the states as classes. */}
          <span style={{ color: statusColor.value }}>{statusText.value}</span>
        </div>
        <div class='lc-my-2'>
          <div class='lc-font-bold lc-mb-1'>实时识别结果：</div>
          <div class='lc-p-2 lc-bg-bg2 lc-rounded lc-min-h-10 lc-max-h-[100px] lc-overflow-y-auto lc-break-all'>
            <span>{finalText.value}</span>
            <span class='lc-text-ga6'>{nonFinalText.value}</span>
          </div>
        </div>
      </div>
    </>
  )
}
