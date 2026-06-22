import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import type { SttChunk, SttProvider, SttSessionParams } from '../lib/stt/types'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { fetchSonioxModels } from '../lib/soniox-models'
import {
  elevenLabsApiKey,
  elevenLabsLanguageCode,
  sonioxApiKey,
  sonioxLanguageHints,
  sonioxModel,
  sonioxModels,
  sonioxTranslationEnabled,
  sonioxTranslationTarget,
  sttAudioDeviceId,
  sttAutoSend,
  sttEndpointReached,
  sttMaxLength,
  sttProvider,
  sttRunning,
  sttTranscriptBuffer,
  sttWrapBrackets,
} from '../lib/store'
import { reduceChunks } from '../lib/stt/normalize'
import { useSttRecording } from '../lib/use-stt-recording'
import { splitTextSmart, stripTrailingPunctuation } from '../lib/utils'
import { wrapSegment, wrapSplitLen } from '../lib/wrap'
import { AiChatSection } from './ai-chat-section'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Combobox } from './ui/combobox'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'
import { Separator } from './ui/separator'

const STT_FLUSH_DELAY_MS = 5000

const HEADING_CLASS = 'font-bold mb-2'
const ROW_CLASS = 'flex gap-2 items-center flex-wrap mb-2'

// Default model ids — mirror the gmSignal defaults so a session never starts
// model-less even if the persisted value is somehow empty.
const SONIOX_DEFAULT_MODEL = 'stt-rt-v5'
const ELEVENLABS_DEFAULT_MODEL = 'scribe_v2_realtime'

// Shared language options for the ElevenLabs single `languageCode` picker
// (empty = auto-detect). Scribe accepts any ISO-639 code; these are the common
// ones for this audience, matching Soniox's hint checkboxes.
const ELEVENLABS_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: '', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]

export function SttTab() {
  const apiKeyVisible = useSignal(false)
  const state = useSignal<'stopped' | 'starting' | 'running' | 'stopping'>('stopped')
  const statusText = useSignal('未启动')
  const statusColor = useSignal('#666')
  const finalText = useSignal('')
  const nonFinalText = useSignal('')
  const audioDevices = useSignal<MediaDeviceInfo[]>([])
  // Model-list fetch state machine (idle / loading / success / error),
  // colour-coded the same way the recording status line is. Mirrors the
  // LLM picker's refresh flow in settings-tab. Soniox-only — ElevenLabs has a
  // single realtime model, so there's no list to fetch.
  const modelFetching = useSignal(false)
  const modelFetchStatus = useSignal('')
  const modelFetchStatusColor = useSignal('#666')

  // Single accumulator for the finalised display text. Translation mode is
  // captured for the lifetime of a session (see `translationModeRef`), so one
  // buffer suffices — `reduceChunks` already picks the right stream.
  const acc = useRef('')
  const sendBuffer = useRef('')
  const flushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFlushing = useRef(false)
  // Translation toggle captured at start() time and stashed in a ref so the
  // event handlers — which fire across the lifetime of the recording —
  // observe the value the user picked when they clicked 开始同传, not whatever
  // they've flipped to since. Always false for providers without translation.
  const translationModeRef = useRef(false)

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

  const refreshSonioxModels = async () => {
    if (modelFetching.value) return
    modelFetching.value = true
    modelFetchStatus.value = '正在获取模型列表…'
    modelFetchStatusColor.value = '#666'
    try {
      const models = await fetchSonioxModels(sonioxApiKey.value)
      sonioxModels.value = models
      // If the previously selected model isn't in the freshly fetched list
      // (renamed / retired), keep the old id so the user can SEE it's stale
      // via the Combobox's "saved but missing" sentinel. We don't
      // auto-clobber their pick.
      modelFetchStatus.value = `已获取 ${models.length} 个实时模型`
      modelFetchStatusColor.value = '#36a185'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      modelFetchStatus.value = `获取失败：${msg}`
      modelFetchStatusColor.value = '#f44'
      appendLog(`❌ Soniox 模型列表获取失败：${msg}`)
    } finally {
      modelFetching.value = false
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
    sendBuffer.current = ''
    isFlushing.current = false
    acc.current = ''
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
      const wrap = sttWrapBrackets.value
      const maxLen = sttMaxLength.value || 40
      // Reserve the 【】 wrapper graphemes so the wrapped segment still fits
      // within the user's configured max length.
      const splitLen = wrapSplitLen(maxLen, wrap)
      const processedText = applyReplacements(sendBuffer.current.trim())
      sendBuffer.current = ''
      const segments = splitTextSmart(processedText, splitLen)
      for (const segment of segments) {
        const clean = stripTrailingPunctuation(segment)
        if (!clean) continue
        await sendSegment(wrapSegment(clean, wrap))
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
      flushTimeout.current = setTimeout(() => void flushBuffer(), STT_FLUSH_DELAY_MS)
    }
  }

  // Transcript handler — provider-agnostic. Each frame's chunks are reduced to
  // the new final text + current non-final text for the stream the user is
  // listening to (translation vs original). Finals feed the 500-char sliding
  // display, the danmaku send buffer (when auto-send is on), and the AI-Chat
  // transcript buffer; non-finals just refresh the provisional display.
  const handleTranscript = (chunks: SttChunk[]) => {
    const { newFinal, nonFinal } = reduceChunks(chunks, translationModeRef.current)
    if (newFinal && sttAutoSend.value) addToBuffer(newFinal)
    acc.current += newFinal
    let display = acc.current
    if (display.length > 500) display = `…${display.slice(-500)}`
    finalText.value = display
    nonFinalText.value = nonFinal
    if (newFinal) sttTranscriptBuffer.value = sttTranscriptBuffer.value + newFinal
  }

  const handleEndpoint = () => {
    if (sttAutoSend.value) {
      // The translation pipeline lags the original transcript by a few hundred
      // ms, so when sending translated text we delay the flush slightly to
      // avoid clipping the tail of the current utterance before its
      // translation lands. (Translation is Soniox-only.)
      setTimeout(() => void flushBuffer(), translationModeRef.current ? 300 : 0)
    }
    // Surface the endpoint to AI Chat unconditionally (independent of the
    // auto-send gating above) so the engine still fires when same-tab danmaku
    // auto-send is off — it treats endpoint as a stronger "ready to generate"
    // signal than buffer length alone.
    sttEndpointReached.value = true
  }

  const handleFinished = async () => {
    // Wait briefly for any in-flight flush triggered by the last result frame
    // to settle before declaring the session over. 100 × 100 ms = 10 s upper
    // bound; longer than that is a stuck network call and we'd rather move on
    // than hang the UI.
    let waitCount = 0
    while (isFlushing.current && waitCount < 100) {
      await new Promise(r => setTimeout(r, 100))
      waitCount++
    }
    await flushBuffer()
    appendLog('🎤 同传已停止')
    resetState()
  }

  const handleError = (err: Error) => {
    console.error('STT error:', err)
    const message = err.message || String(err)
    const label = sttProvider.value === 'elevenlabs' ? 'ElevenLabs' : 'Soniox'
    // Surface platform-typed mic errors with friendly Chinese copy. Both
    // providers' audio layers throw the same DOM error names
    // (NotAllowedError / NotFoundError); Soniox's SDK adds its own
    // Audio*Error subclasses, sniffed by name (string-compatible across the
    // loader's page-context ↔ sandbox boundary, where instanceof wouldn't
    // survive).
    if (err.name === 'AudioPermissionError' || err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      appendLog('❌ 麦克风权限被拒绝，请在浏览器设置中允许使用麦克风')
      statusText.value = '麦克风权限被拒绝'
    } else if (err.name === 'AudioDeviceError' || err.name === 'NotFoundError') {
      appendLog('❌ 未找到麦克风设备')
      statusText.value = '未找到麦克风'
    } else {
      appendLog(`🔴 ${label} 错误：${message}`)
      statusText.value = `错误: ${message}`
    }
    statusColor.value = '#f44'
    if (state.value !== 'stopping' && state.value !== 'stopped') resetState()
  }

  const handleConnected = () => {
    state.value = 'running'
    sttRunning.value = true
    if (translationModeRef.current) {
      const target = sonioxTranslationTarget.value
      const langNames: Record<string, string> = { en: 'English', zh: '中文', ja: '日本語' }
      statusText.value = `正在识别并翻译为${langNames[target] ?? target}…`
      appendLog(`🎤 同传已启动（翻译模式：${target}）`)
    } else {
      statusText.value = '正在识别…'
      appendLog('🎤 同传已启动')
    }
    statusColor.value = '#36a185'
  }

  // ---------------------------------------------------------------
  // Provider-aware config for the recording hook
  // ---------------------------------------------------------------
  const provider: SttProvider = sttProvider.value
  const isSoniox = provider === 'soniox'
  const activeApiKey = (isSoniox ? sonioxApiKey.value : elevenLabsApiKey.value).trim()

  // Validate the saved device is still present at the moment we'd use it. If
  // it isn't, fall back to the system default (matching what <NativeSelect>
  // renders as "系统默认") and surface the swap once. The persisted reset
  // happens lazily inside toggle() to avoid mutating store state during render.
  const savedDeviceIdForHook = sttAudioDeviceId.value
  const deviceStillAvailable =
    !savedDeviceIdForHook || audioDevices.value.some(d => d.deviceId === savedDeviceIdForHook)
  const effectiveDeviceId = deviceStillAvailable ? savedDeviceIdForHook : ''

  const translationEnabledForHook = isSoniox && sonioxTranslationEnabled.value

  const params: SttSessionParams = isSoniox
    ? {
        apiKey: activeApiKey,
        model: sonioxModel.value || SONIOX_DEFAULT_MODEL,
        languageHints: sonioxLanguageHints.value,
        audioDeviceId: effectiveDeviceId,
        ...(sonioxTranslationEnabled.value ? { translation: { targetLanguage: sonioxTranslationTarget.value } } : {}),
      }
    : {
        apiKey: activeApiKey,
        model: ELEVENLABS_DEFAULT_MODEL,
        languageHints: elevenLabsLanguageCode.value ? [elevenLabsLanguageCode.value] : [],
        audioDeviceId: effectiveDeviceId,
      }

  const recording = useSttRecording({
    provider,
    params,
    onTranscript: handleTranscript,
    onEndpoint: handleEndpoint,
    onError: handleError,
    onFinished: handleFinished,
    onConnected: handleConnected,
  })

  const toggle = () => {
    if (state.value === 'stopped') {
      if (!activeApiKey) {
        appendLog(isSoniox ? '⚠️ 请先输入 Soniox API Key' : '⚠️ 请先输入 ElevenLabs API Key')
        statusText.value = '请输入 API Key'
        statusColor.value = '#f44'
        return
      }
      // Persist the device fallback now (deferred from render to keep it out
      // of the render path's signal-write side effects).
      if (savedDeviceIdForHook && !deviceStillAvailable) {
        appendLog('⚠️ 已选麦克风不可用，已切换至系统默认')
        sttAudioDeviceId.value = ''
      }
      // Reset display and accumulator for the new session.
      finalText.value = ''
      nonFinalText.value = ''
      acc.current = ''
      state.value = 'starting'
      statusText.value = '正在连接…'
      statusColor.value = '#666'
      // Capture translation mode for the lifetime of this session — toggling
      // it mid-session shouldn't reinterpret tokens tagged on the way out.
      translationModeRef.current = translationEnabledForHook
      // The engine lazy-loads its SDK (and mints a token, for ElevenLabs) and
      // surfaces any failure through onError, so no pre-warm is needed here.
      recording.start()
    } else if (state.value === 'running') {
      state.value = 'stopping'
      statusText.value = '正在停止…'
      void recording.stop()
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
  const savedDeviceId = sttAudioDeviceId.value
  const savedDeviceMissing = Boolean(savedDeviceId) && !devices.some(d => d.deviceId === savedDeviceId)

  return (
    <>
      <div class={'my-2'}>
        <div class={HEADING_CLASS}>语音识别服务</div>
        <div class={ROW_CLASS}>
          <Label htmlFor='sttProvider'>供应商</Label>
          <NativeSelect
            id='sttProvider'
            className='min-w-37.5 flex-1 pr-5'
            value={provider}
            // Locked while a session is live — switching providers mid-stream
            // would only take effect on the next start and reads as a no-op.
            disabled={state.value !== 'stopped'}
            onChange={e => {
              sttProvider.value = e.currentTarget.value === 'elevenlabs' ? 'elevenlabs' : 'soniox'
            }}
          >
            <option value='soniox'>Soniox</option>
            <option value='elevenlabs'>ElevenLabs</option>
          </NativeSelect>
        </div>
      </div>

      <Separator />

      <div class={'my-2'}>
        <div class={HEADING_CLASS}>{isSoniox ? 'Soniox API 设置' : 'ElevenLabs API 设置'}</div>
        <div class={ROW_CLASS}>
          <Input
            type={apiKeyVisible.value ? 'text' : 'password'}
            placeholder={isSoniox ? '输入 Soniox API Key' : '输入 ElevenLabs API Key'}
            className='min-w-37.5 flex-1'
            value={isSoniox ? sonioxApiKey.value : elevenLabsApiKey.value}
            onInput={e => {
              if (isSoniox) sonioxApiKey.value = e.currentTarget.value
              else elevenLabsApiKey.value = e.currentTarget.value
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
        <div class='my-2 text-ga6'>
          前往{' '}
          {isSoniox ? (
            <a href='https://soniox.com/' target='_blank' class='text-link' rel='noopener'>
              Soniox
            </a>
          ) : (
            <a href='https://elevenlabs.io/' target='_blank' class='text-link' rel='noopener'>
              ElevenLabs
            </a>
          )}{' '}
          注册账号并获取 API Key
        </div>
      </div>

      <Separator />

      <div class={'my-2'}>
        <div class={HEADING_CLASS}>语音识别设置</div>
        <div class={ROW_CLASS}>
          <Label htmlFor='sttAudioDevice'>设备</Label>
          <NativeSelect
            id='sttAudioDevice'
            className='min-w-37.5 flex-1 pr-5'
            value={savedDeviceId}
            onChange={e => {
              sttAudioDeviceId.value = e.currentTarget.value
            }}
          >
            <option value=''>系统默认</option>
            {devices.map((d, i) => (
              <option key={d.deviceId || `mic-${i}`} value={d.deviceId}>
                {d.label || `麦克风 ${i + 1}`}
              </option>
            ))}
            {/* Surface a stale id so the user can see *something* is selected
                and switch away — without this the <select> would silently fall
                back to "系统默认" while the underlying stored id stays put. */}
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

        {isSoniox ? (
          <>
            <div class={ROW_CLASS}>
              <Label htmlFor='sonioxModel'>模型</Label>
              <Combobox
                id='sonioxModel'
                className='min-w-37.5 flex-1'
                value={sonioxModel.value}
                // Display is id-only (the API has no pricing to show, and the
                // name is often just a verbose restatement of the id). The
                // friendly name still feeds searchText so filtering by it works.
                options={sonioxModels.value.map(m => ({
                  value: m.id,
                  label: m.id,
                  searchText: [m.id, m.name].filter(Boolean).join(' '),
                }))}
                onChange={v => {
                  sonioxModel.value = v
                }}
                placeholder='选择模型'
                searchPlaceholder='输入关键词过滤模型…'
                emptyText='未找到匹配模型'
                unloadedText='请点击「刷新」获取模型列表'
                // Stale-but-persisted sentinel — same pattern the device select
                // uses for an unplugged mic: surface the saved id so the user
                // can SEE what's selected and switch, rather than silently
                // dropping to the placeholder.
                missingLabel={v => `${v}（已保存，不在当前列表中）`}
              />
              <Button
                variant='outline'
                size='sm'
                disabled={modelFetching.value || !sonioxApiKey.value.trim()}
                onClick={() => void refreshSonioxModels()}
              >
                {modelFetching.value ? '加载中…' : '刷新'}
              </Button>
            </div>
            {modelFetchStatus.value && (
              // Status colour cycles neutral / success / error driven by the
              // fetch state machine; inline color matches the recording status
              // line below so the same visual language repeats.
              <div class='mb-2' style={{ color: modelFetchStatusColor.value }}>
                {modelFetchStatus.value}
              </div>
            )}
            <div class={ROW_CLASS}>
              <span>语言提示：</span>
              {['zh', 'en', 'ja', 'ko'].map(lang => {
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
            </div>
          </>
        ) : (
          <div class={ROW_CLASS}>
            <Label>模型</Label>
            {/* Read-only: scribe_v2_realtime is the only realtime Scribe model
                and ElevenLabs has no API to list STT models, so it's fixed. */}
            <span class='text-ga6'>{ELEVENLABS_DEFAULT_MODEL}</span>
            <Label htmlFor='elevenLabsLanguage'>语言</Label>
            <NativeSelect
              id='elevenLabsLanguage'
              className='min-w-20 pr-5'
              value={elevenLabsLanguageCode.value}
              onChange={e => {
                elevenLabsLanguageCode.value = e.currentTarget.value
              }}
            >
              {ELEVENLABS_LANGUAGES.map(l => (
                <option key={l.value || 'auto'} value={l.value}>
                  {l.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}

        <div class={ROW_CLASS}>
          <Label htmlFor='sttMaxLength'>超过</Label>
          <Input
            id='sttMaxLength'
            type='number'
            min='1'
            className='w-20'
            value={sttMaxLength.value}
            onInput={e => {
              const v = parseInt(e.currentTarget.value, 10) || 1
              sttMaxLength.value = Math.max(1, v)
            }}
          />
          <span>字自动分段</span>
        </div>
        <div class='flex flex-wrap items-center gap-3'>
          <Checkbox
            id='sttAutoSend'
            checked={sttAutoSend.value}
            onInput={e => {
              sttAutoSend.value = e.currentTarget.checked
            }}
            label='识别完成后自动发送弹幕'
          />
          <Checkbox
            id='sttWrapBrackets'
            checked={sttWrapBrackets.value}
            onInput={e => {
              sttWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹同传内容'
          />
        </div>
      </div>

      {/* Realtime translation is Soniox-only — ElevenLabs Scribe transcribes
          but doesn't translate, so we hide the whole section for it. */}
      {isSoniox && (
        <>
          <Separator />
          <div class={'my-2'}>
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
            <div class='flex flex-wrap items-center gap-2'>
              <Label htmlFor='sonioxTranslationTarget'>翻译目标语言：</Label>
              <NativeSelect
                id='sonioxTranslationTarget'
                className='min-w-20'
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
            <div class='text-ga6'>启用后将发送翻译结果而非原始识别文字</div>
          </div>
        </>
      )}

      <Separator />

      <div class='my-2'>
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
        <div class='my-2'>
          <div class='mb-1 font-bold'>实时识别结果：</div>
          <div class='max-h-25 min-h-10 overflow-y-auto break-all rounded bg-bg2 p-2'>
            <span>{finalText.value}</span>
            <span class='text-ga6'>{nonFinalText.value}</span>
          </div>
        </div>
      </div>

      <Separator />

      {/* AI Chat lives downstream of STT — it consumes the same final
          transcript stream that the captions above render — so we mount it
          inside this tab rather than burning a top-level tab slot. The
          component owns its own enable / mode toggles; this tab just hosts it. */}
      <AiChatSection />
    </>
  )
}
