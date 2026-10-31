import { type Signal, useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import type { SttChunk, SttModelOption, SttProvider, SttSessionParams } from '../lib/stt/types'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import {
  DEEPGRAM_DEFAULT_MODEL,
  ELEVENLABS_DEFAULT_MODEL,
  ELEVENLABS_TRANSLATION_MODE,
  GEMINI_API_BASE,
  GEMINI_DEFAULT_MODEL,
  GEMINI_TRANSLATION_MODEL,
  GEMINI_TRANSLATION_STOP_TIMEOUT_MS,
  GLADIA_DEFAULT_MODEL,
  OPENAI_STT_DEFAULT_BASE_URL,
  OPENAI_STT_DEFAULT_MODEL,
  OPENAI_TRANSLATION_MODEL,
  SONIOX_DEFAULT_MODEL,
  STT_STOP_TIMEOUT_MS,
  WHISPER_CPP_URL,
} from '../lib/const'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { fetchSonioxModels } from '../lib/soniox-models'
import {
  deepgramApiKey,
  deepgramLanguage,
  deepgramModel,
  deepgramModels,
  elevenLabsApiKey,
  elevenLabsLanguageCode,
  elevenLabsMode,
  elevenLabsTranslationTarget,
  elevenLabsTranslationToken,
  elevenLabsTranslationVoiceId,
  geminiApiKey,
  geminiBaseUrl,
  geminiLanguage,
  geminiModel,
  geminiModels,
  geminiTranslationTarget,
  gladiaApiKey,
  gladiaLanguage,
  gladiaTranslationEnabled,
  gladiaTranslationTarget,
  openaiSttApi,
  openaiSttApiKey,
  openaiSttBaseUrl,
  openaiSttLanguage,
  openaiSttModel,
  openaiSttTranslationEnabled,
  openaiTranslationApiKey,
  openaiTranslationTarget,
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
import { translationCapabilities } from '../lib/stt/capabilities'
import { fetchDeepgramModels } from '../lib/stt/deepgram-models'
import { fetchGeminiModels } from '../lib/stt/gemini-models'
import { reduceChunks } from '../lib/stt/normalize'
import { WEB_AUDIO_DEVICE_ID } from '../lib/stt/pcm-capture'
import { useSttRecording } from '../lib/use-stt-recording'
import { isHttpUrl, splitTextSmart, stripTrailingPunctuation } from '../lib/utils'
import { wrapSegment, wrapSplitLen } from '../lib/wrap'
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

// Per-provider display label + signup link, so the API-key section renders generically.
const PROVIDER_META: Record<SttProvider, { label: string; signupUrl: string }> = {
  soniox: { label: 'Soniox', signupUrl: 'https://soniox.com/' },
  elevenlabs: { label: 'ElevenLabs', signupUrl: 'https://elevenlabs.io/' },
  deepgram: { label: 'Deepgram', signupUrl: 'https://deepgram.com/' },
  gladia: { label: 'Gladia', signupUrl: 'https://gladia.io/' },
  gemini: { label: 'Google AI Studio', signupUrl: 'https://aistudio.google.com/apikey' },
  openai: { label: 'OpenAI 实时翻译', signupUrl: 'https://platform.openai.com/api-keys' },
  'openai-compat': { label: '本地 / OpenAI 兼容', signupUrl: WHISPER_CPP_URL },
}

/** `PROVIDER_META` is keyed by every provider, so membership is the validity test. */
const isSttProvider = (value: string): value is SttProvider => value in PROVIDER_META

const API_KEY_SIGNALS: Record<SttProvider, Signal<string>> = {
  soniox: sonioxApiKey,
  elevenlabs: elevenLabsApiKey,
  deepgram: deepgramApiKey,
  gladia: gladiaApiKey,
  gemini: geminiApiKey,
  openai: openaiTranslationApiKey,
  'openai-compat': openaiSttApiKey,
}

type LanguageOption = { value: string; label: string }

// Single-value language pickers; Soniox uses multi-hint checkboxes instead.
// '' = auto-detect, except Deepgram ('multi'); Gemini needs full BCP-47 tags.
const AUTO_DETECT_LANGUAGES: LanguageOption[] = [
  { value: '', label: '自动检测' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]
const DEEPGRAM_LANGUAGES: LanguageOption[] = [
  { value: 'multi', label: '多语种' },
  { value: 'en', label: 'English' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
]
const GEMINI_LANGUAGES: LanguageOption[] = [
  { value: '', label: '自动检测' },
  { value: 'cmn-Hans-CN', label: '中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
]

const LANGUAGE_SETTINGS: Record<
  Exclude<SttProvider, 'soniox' | 'openai'>,
  { signal: Signal<string>; options: LanguageOption[] }
> = {
  elevenlabs: { signal: elevenLabsLanguageCode, options: AUTO_DETECT_LANGUAGES },
  deepgram: { signal: deepgramLanguage, options: DEEPGRAM_LANGUAGES },
  gladia: { signal: gladiaLanguage, options: AUTO_DETECT_LANGUAGES },
  gemini: { signal: geminiLanguage, options: GEMINI_LANGUAGES },
  'openai-compat': { signal: openaiSttLanguage, options: AUTO_DETECT_LANGUAGES },
}

type ModelPicker = {
  model: Signal<string>
  models: Signal<SttModelOption[]>
  fetch: (apiKey: string) => Promise<SttModelOption[]>
}

/** Providers with a model-list endpoint; the others have a fixed or free-text model. */
const MODEL_PICKERS: Partial<Record<SttProvider, ModelPicker>> = {
  soniox: { model: sonioxModel, models: sonioxModels, fetch: fetchSonioxModels },
  deepgram: { model: deepgramModel, models: deepgramModels, fetch: fetchDeepgramModels },
  gemini: { model: geminiModel, models: geminiModels, fetch: key => fetchGeminiModels(key, geminiBaseUrl.value) },
}

const TRANSLATION_SETTINGS: Partial<Record<SttProvider, { enabled?: Signal<boolean>; target?: Signal<string> }>> = {
  soniox: { enabled: sonioxTranslationEnabled, target: sonioxTranslationTarget },
  gladia: { enabled: gladiaTranslationEnabled, target: gladiaTranslationTarget },
  gemini: { target: geminiTranslationTarget },
  elevenlabs: { target: elevenLabsTranslationTarget },
  openai: { target: openaiTranslationTarget },
  'openai-compat': { enabled: openaiSttTranslationEnabled },
}

const TARGET_LABELS: Record<string, string> = { en: 'English', zh: '中文', ja: '日本語', ko: '한국어' }

export function SttTab() {
  const apiKeyVisible = useSignal(false)
  const state = useSignal<'stopped' | 'starting' | 'running' | 'stopping'>('stopped')
  const statusText = useSignal('未启动')
  const statusColor = useSignal('#666')
  const finalText = useSignal('')
  const nonFinalText = useSignal('')
  const sourceFinalText = useSignal('')
  const sourceNonFinalText = useSignal('')
  const audioDevices = useSignal<MediaDeviceInfo[]>([])
  const modelFetching = useSignal(false)
  const modelFetchStatus = useSignal('')
  const modelFetchStatusColor = useSignal('#666')

  // One accumulator suffices: translation mode is fixed per session, so reduceChunks picks the right stream.
  const acc = useRef('')
  const sendBuffer = useRef('')
  const flushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFlushing = useRef(false)
  // Translation toggle captured at start() so long-lived handlers see the value picked at click time.
  const translationModeRef = useRef(false)
  const sessionTarget = useRef('en')
  const sessionHasSource = useRef(true)
  const stopWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Browsers hide device labels until mic permission is granted; getUserMedia forces the prompt, then re-enumerate.
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

  const clearStopWatchdog = () => {
    if (stopWatchdog.current) {
      clearTimeout(stopWatchdog.current)
      stopWatchdog.current = null
    }
  }

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
    sourceFinalText.value = ''
    sourceNonFinalText.value = ''
    clearStopWatchdog()
    if (flushTimeout.current) {
      clearTimeout(flushTimeout.current)
      flushTimeout.current = null
    }
  }

  const sendSegment = async (segment: string) => {
    if (!segment.trim()) return
    const label = translationModeRef.current ? '同传' : '转录'
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog(`❌ ${label}：未找到登录信息`)
        return
      }
      const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.STT, 'stt')
      appendLog(result, label, segment)
      if (!result.success && !result.cancelled) {
        await tryAiEvasion(segment, roomId, csrfToken, label, 'stt')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 ${label}发送出错：${msg}`)
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
      // Reserve the 【】 wrapper graphemes so the wrapped segment still fits maxLen.
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

  // Provider-agnostic: finals feed the sliding display, send buffer, and AI-Chat buffer; non-finals only refresh the provisional display.
  const handleTranscript = (chunks: SttChunk[]) => {
    const { newFinal, nonFinal } = reduceChunks(chunks, translationModeRef.current)
    if (newFinal && sttAutoSend.value) addToBuffer(newFinal)
    acc.current += newFinal
    let display = acc.current
    if (display.length > 500) display = `…${display.slice(-500)}`
    finalText.value = display
    if (!translationModeRef.current || chunks.some(chunk => chunk.kind === 'translation')) {
      nonFinalText.value = nonFinal
    }
    const original =
      translationModeRef.current && sessionHasSource.current ? reduceChunks(chunks, false) : { newFinal, nonFinal }
    if (translationModeRef.current && sessionHasSource.current && chunks.some(chunk => chunk.kind === 'original')) {
      sourceFinalText.value = (sourceFinalText.peek() + original.newFinal).slice(-500)
      sourceNonFinalText.value = original.nonFinal
    }
    if (original.newFinal) sttTranscriptBuffer.value += original.newFinal
  }

  const handleEndpoint = () => {
    if (sttAutoSend.value) {
      // Translation lags the original by a few hundred ms; delay the flush so the utterance tail isn't clipped.
      setTimeout(() => void flushBuffer(), translationModeRef.current ? 300 : 0)
    }
    // Fire unconditionally (independent of auto-send) so AI Chat still triggers when danmaku auto-send is off.
    sttEndpointReached.value = true
  }

  const handleFinished = async () => {
    // Disarm up front: a terminal event arrived, so a slow flush below must not trip the stop watchdog.
    clearStopWatchdog()
    // Wait for an in-flight flush to settle, capped at 10s (100 × 100 ms) to avoid hanging on a stuck call.
    let waitCount = 0
    while (isFlushing.current && waitCount < 100) {
      await new Promise(r => setTimeout(r, 100))
      waitCount++
    }
    await flushBuffer()
    appendLog(`🎤 ${translationModeRef.current ? '同传' : '转录'}已停止`)
    resetState()
  }

  const handleError = (err: Error) => {
    console.error('STT error:', err)
    const message = err.message || String(err)
    const label = PROVIDER_META[sttProvider.value].label
    // Terminal on every provider — no `finished` can follow an `error` (Soniox
    // cleans up + unbinds; the raw-WS engines latch `settled`). So always unwind,
    // including from 'stopping', which would otherwise leave the tab disabled at
    // 停止中… forever. Runs before the status paint since resetState clears it.
    clearStopWatchdog()
    if (state.value !== 'stopped') resetState()
    // Match by name: DOM throws NotAllowedError/NotFoundError; Soniox adds Audio*Error subclasses.
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
  }

  const handleConnected = () => {
    state.value = 'running'
    sttRunning.value = true
    if (translationModeRef.current) {
      const target = sessionTarget.current
      statusText.value = `正在转录并翻译为${TARGET_LABELS[target] ?? target}…`
      appendLog(`🎤 同传已启动（目标语言：${target}）`)
    } else {
      statusText.value = '正在转录…'
      appendLog('🎤 转录已启动')
    }
    statusColor.value = '#36a185'
  }

  // Provider-aware config for the recording hook
  const provider: SttProvider = sttProvider.value
  const isSoniox = provider === 'soniox'
  // Batch provider: no realtime socket, no interim transcripts, key optional.
  const isOpenAiCompat = provider === 'openai-compat'
  const isGemini = provider === 'gemini'
  const isElevenTranslation = provider === 'elevenlabs' && elevenLabsMode.value === ELEVENLABS_TRANSLATION_MODE
  const apiKeySignal = isElevenTranslation ? elevenLabsTranslationToken : API_KEY_SIGNALS[provider]
  const modelPicker = MODEL_PICKERS[provider]
  const activeApiKey = apiKeySignal.value.trim()
  const activeBaseUrl = openaiSttBaseUrl.value.trim()

  // Fall back to default if the saved device is gone; the persisted reset is deferred to toggle() to avoid a store write during render.
  const savedDeviceIdForHook = sttAudioDeviceId.value
  const deviceStillAvailable =
    !savedDeviceIdForHook ||
    (!isSoniox && savedDeviceIdForHook === WEB_AUDIO_DEVICE_ID) ||
    audioDevices.value.some(d => d.deviceId === savedDeviceIdForHook)
  const effectiveDeviceId = deviceStillAvailable ? savedDeviceIdForHook : ''

  const model =
    provider === 'soniox'
      ? sonioxModel.value || SONIOX_DEFAULT_MODEL
      : provider === 'elevenlabs'
        ? elevenLabsMode.value
        : provider === 'gladia'
          ? GLADIA_DEFAULT_MODEL
          : provider === 'gemini'
            ? geminiModel.value.trim() || GEMINI_DEFAULT_MODEL
            : provider === 'openai'
              ? OPENAI_TRANSLATION_MODEL
              : provider === 'openai-compat'
                ? openaiSttModel.value.trim() || OPENAI_STT_DEFAULT_MODEL
                : deepgramModel.value || DEEPGRAM_DEFAULT_MODEL
  const capabilities = translationCapabilities(provider, model, openaiSttApi.value)
  const translationSettings = TRANSLATION_SETTINGS[provider]
  const requestedTarget = translationSettings?.target?.value ?? 'en'
  const targetLanguage = capabilities.targets.includes(requestedTarget) ? requestedTarget : 'en'
  const translationEnabledForHook =
    capabilities.mode === 'required' || (capabilities.mode === 'optional' && !!translationSettings?.enabled?.value)
  const languageSettings = provider !== 'soniox' && provider !== 'openai' ? LANGUAGE_SETTINGS[provider] : undefined

  const params: SttSessionParams = {
    apiKey: isElevenTranslation ? '' : activeApiKey,
    audioDeviceId: effectiveDeviceId,
    model,
    languageHints: isSoniox
      ? sonioxLanguageHints.value
      : languageSettings?.signal.value
        ? [languageSettings.signal.value]
        : [],
    ...(isGemini ? { baseUrl: geminiBaseUrl.value.trim() } : {}),
    ...(isOpenAiCompat ? { baseUrl: activeBaseUrl, translationApi: openaiSttApi.value } : {}),
    ...(translationEnabledForHook
      ? {
          translation: {
            targetLanguage: isGemini && targetLanguage === 'zh' ? 'zh-Hans' : targetLanguage,
            ...(provider === 'elevenlabs'
              ? {
                  voiceId: elevenLabsTranslationVoiceId.value.trim(),
                  authorizationToken: elevenLabsTranslationToken.value.trim(),
                }
              : {}),
          },
        }
      : {}),
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

  const refreshModels = async () => {
    if (!modelPicker || modelFetching.value) return
    const key = apiKeySignal.value
    const baseUrl = geminiBaseUrl.value
    // A custom Gemini host's @connect prompt can hold the request while the key or address is edited; drop that outcome.
    const stale = () => isGemini && (apiKeySignal.value !== key || geminiBaseUrl.value !== baseUrl)
    modelFetching.value = true
    modelFetchStatus.value = '正在获取模型列表…'
    modelFetchStatusColor.value = '#666'
    try {
      const models = await modelPicker.fetch(key)
      if (stale()) {
        modelFetchStatus.value = ''
        return
      }
      modelPicker.models.value = models
      modelFetchStatus.value = `已获取 ${models.length} 个实时模型`
      modelFetchStatusColor.value = '#36a185'
    } catch (err) {
      if (stale()) {
        modelFetchStatus.value = ''
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      modelFetchStatus.value = `获取失败：${msg}`
      modelFetchStatusColor.value = '#f44'
      appendLog(`❌ ${PROVIDER_META[provider].label} 模型列表获取失败：${msg}`)
    } finally {
      modelFetching.value = false
    }
  }

  const toggle = () => {
    if (state.value === 'stopped') {
      // Local servers need no key, so this provider gates on a valid endpoint instead.
      if (isOpenAiCompat ? !isHttpUrl(activeBaseUrl) : !activeApiKey) {
        const missing = isOpenAiCompat
          ? '服务地址（http:// 或 https://）'
          : isElevenTranslation
            ? 'Authorization Token'
            : 'API Key'
        appendLog(`⚠️ 请先输入 ${PROVIDER_META[provider].label} ${missing}`)
        statusText.value = `请输入${missing}`
        statusColor.value = '#f44'
        return
      }
      if (provider === 'elevenlabs' && translationEnabledForHook && !elevenLabsTranslationVoiceId.value.trim()) {
        statusText.value = '请输入 ElevenLabs Voice ID'
        statusColor.value = '#f44'
        return
      }
      // Persist the device fallback here, deferred from render to avoid a signal write during render.
      // The page-audio sentinel is not a device: Soniox just doesn't offer it, so keep the preference.
      if (savedDeviceIdForHook && savedDeviceIdForHook !== WEB_AUDIO_DEVICE_ID && !deviceStillAvailable) {
        appendLog('⚠️ 已选麦克风不可用，已切换至系统默认')
        sttAudioDeviceId.value = ''
      }
      finalText.value = ''
      nonFinalText.value = ''
      acc.current = ''
      sourceFinalText.value = ''
      sourceNonFinalText.value = ''
      state.value = 'starting'
      statusText.value = '正在连接…'
      statusColor.value = '#666'
      translationModeRef.current = translationEnabledForHook
      sessionTarget.current = targetLanguage
      sessionHasSource.current = !isOpenAiCompat
      // No pre-warm needed: the engine sets up the SDK/socket and reports failure via onError.
      recording.start()
    } else if (state.value === 'running') {
      state.value = 'stopping'
      statusText.value = '正在停止…'
      // The button is disabled while 'stopping' and there is no cancel affordance,
      // so a shutdown that emits no terminal event at all (socket died mid-finish,
      // or a server that never answers) would need a page reload. Disarmed by
      // handleFinished/handleError the moment either one arrives.
      clearStopWatchdog()
      stopWatchdog.current = setTimeout(
        () => {
          stopWatchdog.current = null
          if (state.value !== 'stopping') return
          appendLog(`⚠️ ${translationModeRef.current ? '同传' : '转录'}停止超时，已强制结束会话`)
          recording.cancel()
          resetState()
        },
        isGemini && translationModeRef.current ? GEMINI_TRANSLATION_STOP_TIMEOUT_MS : STT_STOP_TIMEOUT_MS
      )
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

  const showingTranslation = state.value === 'stopped' ? translationEnabledForHook : translationModeRef.current

  const modeLabel = showingTranslation ? '同传' : '转录'

  const btnText =
    state.value === 'starting'
      ? '启动中…'
      : state.value === 'stopping'
        ? '停止中…'
        : state.value === 'running'
          ? `停止${modeLabel}`
          : `开始${modeLabel}`

  const hints = sonioxLanguageHints.value
  const devices = audioDevices.value
  // Labels are blank until mic permission is granted, so a non-empty label means "already granted".
  const hasMicLabels = devices.some(d => d.label)
  const savedDeviceId = sttAudioDeviceId.value
  const savedDeviceMissing =
    Boolean(savedDeviceId) && savedDeviceId !== WEB_AUDIO_DEVICE_ID && !devices.some(d => d.deviceId === savedDeviceId)

  const knownModels = isGemini
    ? [{ id: GEMINI_DEFAULT_MODEL }, { id: GEMINI_TRANSLATION_MODEL }, ...(modelPicker?.models.value ?? [])]
    : (modelPicker?.models.value ?? [])
  const modelOptions = [...new Map(knownModels.map(m => [m.id, m])).values()].map(m => ({
    value: m.id,
    label: m.id,
    searchText: [m.id, m.name].filter(Boolean).join(' '),
  }))

  return (
    <>
      <fieldset disabled={state.value !== 'stopped'} class='m-0 min-w-0 border-0 p-0'>
        <div class={'my-2'}>
          <div class={HEADING_CLASS}>语音服务</div>
          <div class={ROW_CLASS}>
            <Label htmlFor='sttProvider'>服务商</Label>
            <NativeSelect
              id='sttProvider'
              className='min-w-37.5 flex-1 pr-5'
              value={provider}
              // Locked while live: a provider switch would only take effect on the next start.
              disabled={state.value !== 'stopped'}
              onChange={e => {
                const next = e.currentTarget.value
                if (isSttProvider(next)) sttProvider.value = next
              }}
            >
              {Object.entries(PROVIDER_META).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div class='text-ga6'>
            {capabilities.mode === 'required'
              ? '当前模型用于同传，将语音翻译为目标语言。'
              : capabilities.mode === 'optional'
                ? '当前模型支持转录，也可开启同传输出译文。'
                : '当前模型仅转录原文。'}
          </div>
          {isOpenAiCompat && <div class='text-ga6'>分段转录，延迟约 1–4 秒，无实时预览</div>}
        </div>
      </fieldset>

      <Separator />

      <div class={'my-2'}>
        <div class={HEADING_CLASS}>{PROVIDER_META[provider].label} API 设置</div>
        {isOpenAiCompat && (
          <div class={ROW_CLASS}>
            <Label htmlFor='openaiSttBaseUrl'>服务地址</Label>
            <Input
              id='openaiSttBaseUrl'
              disabled={state.value !== 'stopped'}
              className='min-w-37.5 flex-1'
              placeholder={OPENAI_STT_DEFAULT_BASE_URL}
              value={openaiSttBaseUrl.value}
              onInput={e => {
                openaiSttBaseUrl.value = e.currentTarget.value
              }}
            />
          </div>
        )}
        {isGemini && (
          <div class={ROW_CLASS}>
            <Label htmlFor='geminiBaseUrl'>接口地址</Label>
            <Input
              id='geminiBaseUrl'
              disabled={state.value !== 'stopped'}
              className='min-w-37.5 flex-1'
              placeholder={GEMINI_API_BASE}
              value={geminiBaseUrl.value}
              onInput={e => {
                geminiBaseUrl.value = e.currentTarget.value
              }}
            />
          </div>
        )}
        <div class={ROW_CLASS}>
          <Input
            type={apiKeyVisible.value ? 'text' : 'password'}
            disabled={state.value !== 'stopped'}
            placeholder={
              isOpenAiCompat
                ? 'API Key（本地服务可留空）'
                : isElevenTranslation
                  ? 'ElevenLabs Authorization Token'
                  : `输入 ${PROVIDER_META[provider].label} API Key`
            }
            className='min-w-37.5 flex-1'
            value={apiKeySignal.value}
            onInput={e => {
              apiKeySignal.value = e.currentTarget.value
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
          {isOpenAiCompat ? (
            <>
              指向任意 OpenAI 兼容的语音识别服务。本地部署可参考{' '}
              <a href={PROVIDER_META[provider].signupUrl} target='_blank' class='text-link' rel='noopener'>
                whisper.cpp
              </a>
              ，无需 API Key；填写云端地址（如 Groq、OpenAI）时才需要。whisper-server 需以{' '}
              <code>--request-path /v1 --inference-path /audio/transcriptions</code> 参数启动以匹配默认地址。 使用
              whisper.cpp 时，请将「接口类型」设为「whisper.cpp（多语言模型）」后再启用翻译。
            </>
          ) : isElevenTranslation ? (
            <>填写企业 Realtime Translation 的 Authorization Token；Scribe API Key 不适用于此处。</>
          ) : (
            <>
              前往{' '}
              <a href={PROVIDER_META[provider].signupUrl} target='_blank' class='text-link' rel='noopener'>
                {PROVIDER_META[provider].label}
              </a>{' '}
              {isGemini ? (
                <>
                  获取 API Key。接口地址留空即直连 Google；无法直连时可填 Cloudflare AI Gateway 网关地址（如{' '}
                  <code>https://gateway.ai.cloudflare.com/v1/账户ID/网关名</code>
                  ，需关闭网关的身份验证）或反向代理地址
                </>
              ) : (
                '注册账号并获取 API Key'
              )}
            </>
          )}
        </div>
      </div>

      <Separator />

      <fieldset disabled={state.value !== 'stopped'} class='m-0 min-w-0 border-0 p-0'>
        <div class={'my-2'}>
          <div class={HEADING_CLASS}>语音识别设置</div>
          <div class={ROW_CLASS}>
            <Label htmlFor='sttAudioDevice'>设备</Label>
            <NativeSelect
              id='sttAudioDevice'
              className='min-w-37.5 flex-1 pr-5'
              // Soniox doesn't render the page-audio option; fall back so the select isn't blank.
              value={isSoniox && savedDeviceId === WEB_AUDIO_DEVICE_ID ? '' : savedDeviceId}
              onChange={e => {
                sttAudioDeviceId.value = e.currentTarget.value
              }}
            >
              <option value=''>系统默认</option>
              {!isSoniox && <option value={WEB_AUDIO_DEVICE_ID}>获取网页声音</option>}
              {devices.map((d, i) => (
                <option key={d.deviceId || `mic-${i}`} value={d.deviceId}>
                  {d.label || `麦克风 ${i + 1}`}
                </option>
              ))}
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

          {modelPicker ? (
            <>
              {isGemini && (
                <div class={ROW_CLASS}>
                  <Label htmlFor='geminiModel'>模型</Label>
                  {/* Keep custom model IDs available alongside the built-in choices. */}
                  <Input
                    id='geminiModel'
                    className='min-w-37.5 flex-1'
                    placeholder={GEMINI_DEFAULT_MODEL}
                    value={geminiModel.value}
                    onInput={e => {
                      geminiModel.value = e.currentTarget.value
                    }}
                  />
                </div>
              )}
              <div class={ROW_CLASS}>
                {!isGemini && <Label htmlFor='sttModel'>模型</Label>}
                <Combobox
                  id='sttModel'
                  className='min-w-37.5 flex-1'
                  value={modelPicker.model.value}
                  options={modelOptions}
                  onChange={v => {
                    modelPicker.model.value = v
                  }}
                  placeholder={isGemini ? '从模型列表选择' : '选择模型'}
                  searchPlaceholder='输入关键词过滤模型…'
                  emptyText='未找到匹配模型'
                  unloadedText={isGemini ? '可直接填写模型 ID，或点击「刷新」获取列表' : '请点击「刷新」获取模型列表'}
                  // Only once a list is loaded; before that `unloadedText` explains the empty picker.
                  missingLabel={modelOptions.length > 0 ? v => `${v}（已保存，不在当前列表中）` : undefined}
                />
                <Button
                  variant='outline'
                  size='sm'
                  disabled={modelFetching.value || !apiKeySignal.value.trim()}
                  onClick={() => void refreshModels()}
                >
                  {modelFetching.value ? '加载中…' : '刷新'}
                </Button>
              </div>
              {modelFetchStatus.value && (
                <div class='mb-2' style={{ color: modelFetchStatusColor.value }}>
                  {modelFetchStatus.value}
                </div>
              )}
            </>
          ) : isOpenAiCompat ? (
            <div class={ROW_CLASS}>
              <Label htmlFor='openaiSttModel'>模型</Label>
              {/* Free text: servers disagree on whether /models exists or lists STT models at all. */}
              <Input
                id='openaiSttModel'
                className='min-w-37.5 flex-1'
                placeholder={OPENAI_STT_DEFAULT_MODEL}
                value={openaiSttModel.value}
                onInput={e => {
                  openaiSttModel.value = e.currentTarget.value
                }}
              />
            </div>
          ) : provider === 'elevenlabs' ? (
            <div class={ROW_CLASS}>
              <Label htmlFor='elevenLabsMode'>服务模式</Label>
              <NativeSelect
                id='elevenLabsMode'
                value={elevenLabsMode.value}
                onChange={e => {
                  elevenLabsMode.value = e.currentTarget.value
                }}
              >
                <option value={ELEVENLABS_DEFAULT_MODEL}>Scribe v2 Realtime · 转录</option>
                <option value={ELEVENLABS_TRANSLATION_MODE}>Realtime Translation · 同传（企业 Alpha）</option>
              </NativeSelect>
            </div>
          ) : (
            <div class={ROW_CLASS}>
              <Label>模型</Label>
              <span class='text-ga6'>{model}</span>
            </div>
          )}

          {isOpenAiCompat && (
            <div class={ROW_CLASS}>
              <Label htmlFor='openaiSttApi'>接口类型</Label>
              <NativeSelect
                id='openaiSttApi'
                value={openaiSttApi.value}
                onChange={e => {
                  openaiSttApi.value = e.currentTarget.value === 'whisper-cpp' ? 'whisper-cpp' : 'openai'
                }}
              >
                <option value='openai'>OpenAI 兼容</option>
                <option value='whisper-cpp'>whisper.cpp（多语言模型）</option>
              </NativeSelect>
            </div>
          )}

          {isSoniox ? (
            <div class={ROW_CLASS}>
              <span>语言提示：</span>
              {['zh', 'en', 'ja', 'ko'].map(lang => (
                <Checkbox
                  key={lang}
                  id={`stt-lang-${lang}`}
                  checked={hints.includes(lang)}
                  onChange={e => updateLangHints(lang, e.currentTarget.checked)}
                  label={TARGET_LABELS[lang]}
                />
              ))}
            </div>
          ) : languageSettings && (capabilities.mode !== 'required' || isElevenTranslation) ? (
            <div class={ROW_CLASS}>
              <Label htmlFor='sttLanguage'>{isElevenTranslation ? '源语言' : '转录语言'}</Label>
              <NativeSelect
                id='sttLanguage'
                className='min-w-25 pr-5'
                value={languageSettings.signal.value}
                onChange={e => {
                  languageSettings.signal.value = e.currentTarget.value
                }}
              >
                {languageSettings.options.map(l => (
                  <option key={l.value || 'auto'} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
        </div>
      </fieldset>
      <div class='my-2'>
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
        <div class='flex flex-wrap items-center gap-2'>
          <Checkbox
            id='sttAutoSend'
            checked={sttAutoSend.value}
            onInput={e => {
              sttAutoSend.value = e.currentTarget.checked
            }}
            label='自动将输出文本发送为弹幕'
          />
          <Checkbox
            id='sttWrapBrackets'
            checked={sttWrapBrackets.value}
            onInput={e => {
              sttWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹输出文本'
          />
        </div>
      </div>

      <fieldset disabled={state.value !== 'stopped'} class='m-0 min-w-0 border-0 p-0'>
        {capabilities.mode !== 'none' && (
          <>
            <Separator />
            <div class='my-2'>
              <div class={HEADING_CLASS}>同传设置</div>
              {capabilities.mode === 'optional' && translationSettings?.enabled && (
                <div class={ROW_CLASS}>
                  <Checkbox
                    id='sttTranslationEnabled'
                    checked={translationSettings.enabled.value}
                    onInput={e => {
                      if (translationSettings.enabled) translationSettings.enabled.value = e.currentTarget.checked
                    }}
                    label={isOpenAiCompat ? '启用分段翻译' : '启用同传'}
                  />
                </div>
              )}
              <div class={ROW_CLASS}>
                <Label htmlFor='sttTranslationTarget'>翻译目标语言</Label>
                <NativeSelect
                  id='sttTranslationTarget'
                  value={targetLanguage}
                  disabled={capabilities.targets.length === 1}
                  onChange={e => {
                    if (translationSettings?.target) translationSettings.target.value = e.currentTarget.value
                  }}
                >
                  {capabilities.targets.map(lang => (
                    <option key={lang} value={lang}>
                      {TARGET_LABELS[lang] ?? lang}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {provider === 'elevenlabs' && (
                <>
                  <div class={ROW_CLASS}>
                    <Label htmlFor='elevenLabsTranslationVoiceId'>Voice ID</Label>
                    <Input
                      id='elevenLabsTranslationVoiceId'
                      value={elevenLabsTranslationVoiceId.value}
                      onInput={e => {
                        elevenLabsTranslationVoiceId.value = e.currentTarget.value
                      }}
                    />
                  </div>
                  <div class='text-ga6'>需要已开通 Realtime Translation 的企业账号；服务要求提供 Voice ID。</div>
                </>
              )}
              <div class='text-ga6'>
                {isOpenAiCompat
                  ? 'Whisper 分段翻译仅输出英文；兼容服务须支持所选翻译接口。'
                  : '同传时显示原文与译文，自动发送使用译文。'}
              </div>
            </div>
          </>
        )}

        <Separator />
      </fieldset>
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
          <span style={{ color: statusColor.value }}>{statusText.value}</span>
        </div>
        {showingTranslation && !isOpenAiCompat && (
          <div class='my-2'>
            <div class='mb-1 font-bold'>原文转录：</div>
            <div class='max-h-25 min-h-10 overflow-y-auto rounded bg-bg2 p-2 break-all'>
              <span>{sourceFinalText.value}</span>
              <span class='text-ga6'>{sourceNonFinalText.value}</span>
            </div>
          </div>
        )}
        <div class='my-2'>
          <div class='mb-1 font-bold'>{showingTranslation ? '翻译结果：' : '转录结果：'}</div>
          <div class='max-h-25 min-h-10 overflow-y-auto rounded bg-bg2 p-2 break-all'>
            <span>{finalText.value}</span>
            <span class='text-ga6'>{nonFinalText.value}</span>
          </div>
        </div>
      </div>
    </>
  )
}
