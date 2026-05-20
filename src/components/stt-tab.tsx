import { useSignal } from '@preact/signals'
import type { RealtimeResult } from '@soniox/client'
import { useEffect, useRef } from 'preact/hooks'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from '../lib/emoticon'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { loadSoniox } from '../lib/soniox'
import {
  clearSonioxApiKey,
  sonioxApiKey,
  sonioxApiKeyPersist,
  sonioxAudioDeviceId,
  sonioxAutoSend,
  sonioxLanguageHints,
  sonioxMaxLength,
  sonioxTranslationEnabled,
  sonioxTranslationTarget,
  sonioxWrapBrackets,
  sttEndpointReached,
  sttRunning,
  sttTranscriptBuffer,
} from '../lib/store'
import { useSonioxRecording } from '../lib/use-soniox-recording'
import { splitTextSmart, stripTrailingPunctuation } from '../lib/utils'
import { AiCandidateSection } from './ai-candidate-section'

const SONIOX_FLUSH_DELAY_MS = 5000

export function SttTab() {
  const apiKeyVisible = useSignal(false)
  // 本地 lifecycle state（驱动按钮文案 / 状态条）。SDK 自己有 `RecordingState`，
  // 但它的状态机字段更多（'idle' / 'starting' / 'connecting' / 'recording' /
  // 'paused' / 'stopping' / 'stopped' / 'canceled' / 'error'），UI 只需要四态。
  // 由 toggle() / handleConnected / handleFinished / handleError 维护。
  const state = useSignal<'stopped' | 'starting' | 'running' | 'stopping'>('stopped')
  const statusText = useSignal('未启动')
  const statusColor = useSignal('#666')
  const finalText = useSignal('')
  const nonFinalText = useSignal('')
  const audioDevices = useSignal<MediaDeviceInfo[]>([])

  const accFinal = useRef('')
  const accTranslated = useRef('')
  const sendBuffer = useRef('')
  const flushTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFlushing = useRef(false)
  // 翻译开关在 start() 时 snapshot 进 ref —— 同一 session 内 token 上的
  // `translation_status` 是按 session 开始时的配置打的标，用户中途切换开关
  // 不应该影响已发出但还没解析的 token 归类。
  const translationModeRef = useRef(false)

  const resetState = (nextStatusText = '未启动', nextStatusColor = '#666') => {
    state.value = 'stopped'
    sttRunning.value = false
    statusText.value = nextStatusText
    statusColor.value = nextStatusColor
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

  const sendSegment = async (segment: string) => {
    if (!segment.trim()) return
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog(`❌ 同传：未找到 Bilibili 登录信息，请刷新 B 站页面或重新登录（未发送：${segment}）`)
        return
      }
      if (isLockedEmoticon(segment)) {
        appendLog(formatLockedEmoticonReject(segment, '同传表情'))
        return
      }
      if (isUnavailableEmoticon(segment)) {
        appendLog(formatUnavailableEmoticonReject(segment, '同传表情'))
        return
      }
      const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.STT)
      appendLog(result, '同传', segment)
      if (!result.success && !result.cancelled) {
        await tryAiEvasion(segment, roomId, csrfToken, '同传')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 同传发送出错：${msg}（未发送：${segment}）`)
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

  // === SDK event handlers =================================================
  // 提取成命名函数（不再是 SDK config 上的 inline closure），这样 hook 内
  // 通过 ref 路由的 callback 永远拿到这一份。逻辑与 v1 SDK 的 onPartialResult
  // 等价 —— 唯一行为变化：endpoint 检测不再走 `<end>` token 解析（v1
  // server 行为），改吃 SDK 原生的 `endpoint` 事件（v2 已经把这层语义
  // 内化），见 handleEndpoint。

  const handleResult = (result: RealtimeResult) => {
    const translationEnabled = translationModeRef.current
    let newFinal = ''
    let nonFinal = ''
    let newTransFinal = ''
    let transNonFinal = ''
    for (const token of result.tokens ?? []) {
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
      // AI 候选桥接：翻译模式下发布翻译后的文本（与发出去的弹幕一致）。
      // 见 store-stt.ts 的 sttTranscriptBuffer 注释。
      if (newTransFinal) sttTranscriptBuffer.value = sttTranscriptBuffer.value + newTransFinal
    } else {
      if (newFinal && sonioxAutoSend.value) addToBuffer(newFinal)
      accFinal.current += newFinal
      let display = accFinal.current
      if (display.length > 500) display = `…${display.slice(-500)}`
      finalText.value = display
      nonFinalText.value = nonFinal
      // AI 候选桥接：发布原文 final tokens。AI 候选引擎在生成时
      // atomic snapshot+清空这个 buffer。
      if (newFinal) sttTranscriptBuffer.value = sttTranscriptBuffer.value + newFinal
    }
  }

  const handleEndpoint = () => {
    if (sonioxAutoSend.value) {
      // 翻译管线比原文转录滞后几百 ms：发送翻译时延迟 flush，避免在
      // 当前句的翻译落地之前就截掉句尾。
      setTimeout(() => void flushBuffer(), translationModeRef.current ? 300 : 0)
    }
    // AI 候选桥接：句子端点信号。引擎用它来把已排队的 debounce 时间
    // 提前（READY_MS 而非 FALLBACK_MS）。独立于 autoSend gating —— 用户
    // 不让自动发不等于不让 AI 候选引擎用。
    sttEndpointReached.value = true
  }

  const handleFinished = async () => {
    // 等已经在飞的 flush 把当前 in-flight 的句子送完再 declare stopped。
    // 100 × 100 ms = 10 s 上限；超过这个就是网络卡死的征兆，宁愿放弃也
    // 不要把 UI 挂死。
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
    console.error('Soniox error:', err)
    const message = err.message || String(err)
    // 通过 `err.name` 字符串比较 sniff platform 错误：v2 SDK 暴露
    // `AudioPermissionError` / `AudioDeviceError` / `AudioUnavailableError`
    // 子类。不用 `instanceof` 是因为 SDK 跨 userscript 沙箱 / page-context
    // 边界加载，`instanceof` 的原型链拿不到。
    if (err.name === 'AudioPermissionError' || err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      appendLog('❌ 麦克风权限被拒绝，请在浏览器设置中允许使用麦克风')
      if (state.value !== 'stopping' && state.value !== 'stopped') {
        resetState('麦克风权限被拒绝，请允许浏览器使用麦克风', 'var(--cb-danger-text)')
      }
    } else if (err.name === 'AudioDeviceError' || err.name === 'NotFoundError') {
      appendLog('❌ 未找到麦克风设备')
      if (state.value !== 'stopping' && state.value !== 'stopped') {
        resetState('未找到麦克风设备', 'var(--cb-danger-text)')
      }
    } else {
      appendLog(`🔴 Soniox 错误：${message}`)
      if (state.value !== 'stopping' && state.value !== 'stopped') {
        resetState(`错误: ${message}`, 'var(--cb-danger-text)')
      }
    }
  }

  const handleConnected = () => {
    state.value = 'running'
    sttRunning.value = true
    const translationEnabled = translationModeRef.current
    if (translationEnabled) {
      const target = sonioxTranslationTarget.value
      const langNames: Record<string, string> = { en: 'English', zh: '中文', ja: '日本語' }
      statusText.value = `正在识别并翻译为${langNames[target] ?? target}…`
      appendLog(`🎤 同传已启动（翻译模式：${target}）`)
    } else {
      statusText.value = '正在识别…'
      appendLog('🎤 同传已启动')
    }
    statusColor.value = 'var(--cb-success-text)'
  }

  // === Reactive config for the recording hook =============================
  // 在 render 路径上读取所有相关 signal，每次渲染重算 config 对象，hook
  // 内部 ref 路由的回调因此永远拿到最新版本。
  const apiKeyForHook = sonioxApiKey.value.trim()
  const langHintsForHook = sonioxLanguageHints.value
  const translationEnabledForHook = sonioxTranslationEnabled.value
  const translationTargetForHook = sonioxTranslationTarget.value
  const savedDeviceIdForHook = sonioxAudioDeviceId.value

  // 保存的 mic deviceId 在用户拔线后会失效。validation 放 render 期纯计算；
  // 真正的 store 写入（清空 sonioxAudioDeviceId）推到 toggle()，避免在
  // render 里写 signal 触发额外重渲染循环。
  const deviceStillAvailable =
    !savedDeviceIdForHook || audioDevices.value.some(d => d.deviceId === savedDeviceIdForHook)
  const effectiveDeviceId = deviceStillAvailable ? savedDeviceIdForHook : ''

  // 镜像 SDK MicrophoneSource 的默认 raw mono 配置 —— 给 deviceId pin 一个
  // 具体设备的同时，不能让浏览器把 echo cancel / noise suppression / AGC
  // 自动打开。Soniox 推荐 raw 音频以获取最佳识别质量；16kHz 是 v2 SDK
  // 内部约定的目标采样率。
  const micConstraints: MediaTrackConstraints | undefined = effectiveDeviceId
    ? {
        deviceId: { exact: effectiveDeviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 16000,
      }
    : undefined

  const recording = useSonioxRecording({
    apiKey: apiKeyForHook,
    // stt-rt-v4 是 v2 SDK 当前的实时模型；老的 stt-rt-v3 在 2026-02 已经
    // 被 Soniox 退役，server 端自动 route 到 v4，写新名只是显式化。
    model: 'stt-rt-v4',
    language_hints: langHintsForHook,
    enable_endpoint_detection: true,
    ...(translationEnabledForHook
      ? { translation: { type: 'one_way' as const, target_language: translationTargetForHook } }
      : {}),
    ...(micConstraints ? { microphoneConstraints: micConstraints } : {}),
    onResult: handleResult,
    onEndpoint: handleEndpoint,
    onError: handleError,
    onFinished: handleFinished,
    onConnected: handleConnected,
  })

  const toggle = async () => {
    if (state.value === 'stopped') {
      const apiKey = sonioxApiKey.value.trim()
      if (!apiKey) {
        appendLog('⚠️ 请先输入 Soniox API Key')
        statusText.value = '请输入 API Key'
        statusColor.value = 'var(--cb-danger-text)'
        return
      }
      // 设备失效的 store 重置在这里执行（不能放 render，否则会在渲染期
      // 写 signal）。
      if (savedDeviceIdForHook && !deviceStillAvailable) {
        appendLog('⚠️ 已选麦克风不可用，已切换至系统默认')
        sonioxAudioDeviceId.value = ''
      }
      // 重置显示和累加器，为新 session 让出空间。
      finalText.value = ''
      nonFinalText.value = ''
      accFinal.current = ''
      accTranslated.current = ''
      state.value = 'starting'
      statusText.value = '正在连接…'
      statusColor.value = '#666'
      // Snapshot 翻译模式给本 session 用 —— 用户中途切换不应影响已发出
      // 但还没解析的 token 归类。
      translationModeRef.current = translationEnabledForHook
      // 预热 loader。不预热的话，用户首次"开始同传"会和 CDN fetch 静默
      // race；在这里失败可以走我们正常的错误路径，给用户具体反馈。
      try {
        await loadSoniox()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        appendLog(`🔴 加载 Soniox SDK 失败：${message}`)
        resetState(`加载失败: ${message}`, 'var(--cb-danger-text)')
        return
      }
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
  // microphone permission. Presence of any non-empty label is a proxy for
  // "permission already granted, no need to nag the user".
  const hasMicLabels = devices.some(d => d.label)
  const savedDeviceId = sonioxAudioDeviceId.value
  const savedDeviceMissing = Boolean(savedDeviceId) && !devices.some(d => d.deviceId === savedDeviceId)

  return (
    <>
      <div
        className='cb-section cb-stack'
        style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}
      >
        <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          Soniox API 设置
        </div>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <input
            type={apiKeyVisible.value ? 'text' : 'password'}
            placeholder='输入 Soniox API Key'
            style={{ flex: 1, minWidth: '150px' }}
            value={sonioxApiKey.value}
            onInput={e => {
              sonioxApiKey.value = e.currentTarget.value
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
          <button
            type='button'
            disabled={!sonioxApiKey.value}
            onClick={() => clearSonioxApiKey()}
            style={{ fontSize: '11px' }}
            title='把 key 从内存和 GM 存储里都抹掉'
          >
            清除
          </button>
        </div>
        <label
          htmlFor='sonioxApiKeyPersist'
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            color: '#666',
            fontSize: '0.85em',
            cursor: 'pointer',
            marginBottom: '.25em',
          }}
        >
          <input
            id='sonioxApiKeyPersist'
            type='checkbox'
            checked={sonioxApiKeyPersist.value}
            onInput={e => {
              sonioxApiKeyPersist.value = e.currentTarget.checked
            }}
          />
          <span title='不勾：key 仅留在内存，刷新页面就清空，GM 存储里的旧值也立即抹掉'>
            保存到 GM 存储（关闭后仅本次会话有效）
          </span>
        </label>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.25em' }}
        >
          <a
            href='https://soniox.com/'
            target='_blank'
            className='cb-primary'
            style={{ display: 'inline-flex', alignItems: 'center', minHeight: '26px', padding: '3px 9px' }}
            rel='noopener'
          >
            获取 Soniox API Key
          </a>
          <span className='cb-note'>注册后把 API Key 粘贴到上方。</span>
        </div>
        {sonioxApiKeyPersist.value && sonioxApiKey.value ? (
          <div
            role='status'
            aria-live='polite'
            style={{
              color: 'var(--cb-danger-text)',
              background: 'rgba(176,0,32,.08)',
              border: '1px solid rgba(176,0,32,.25)',
              padding: '6px 8px',
              borderRadius: '4px',
              fontSize: '12px',
              fontWeight: 600,
              lineHeight: 1.45,
              marginTop: '.25em',
            }}
          >
            ⚠️ Soniox key 已明文存进浏览器 GM 存储。共用电脑、浏览器同步、其他扩展、备份导出都能直接读到。
            担心泄漏：上面取消勾选「保存到 GM 存储」改为仅本会话。
          </div>
        ) : (
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em', marginTop: '.25em' }}>
            {sonioxApiKeyPersist.value
              ? '提示：填入 key 后会明文存进 GM 存储。关掉「保存到 GM 存储」可改为仅本会话。'
              : 'Key 仅留在内存，刷新页面后清空。'}
            开启同传后，麦克风音频流会通过 WebSocket 发送到 api.soniox.com 进行识别。
          </div>
        )}
      </div>

      <div
        className='cb-section cb-stack'
        style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}
      >
        <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          语音识别设置
        </div>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <label htmlFor='sonioxAudioDevice'>设备：</label>
          {/* Wrap the <select> in a min-width:0 / overflow:hidden flex
              container. Chrome honors `min-width: 0` directly on the
              <select> and shrinks it to fit the flex-allocated space, but
              Edge / Firefox treat <select> as a "replaced-element-ish"
              control whose intrinsic width is set by the longest <option>
              text and ignore min-width on the element itself. A long
              microphone name (e.g. "Microphone Array (Intel® Smart Sound
              Technology for Digital Microphones)") then forces the
              <select> to ~450px and pushes the entire row past the
              320px panel right edge.

              The wrapper div is the actual flex item. Its `min-width: 0`
              + `overflow: hidden` clip the select visually instead of
              expanding the row. The select keeps `width: 100%` so it
              follows the wrapper. The dropdown popup width is still
              browser-controlled and may extend past the panel — that's
              an Edge native control thing we can't override from CSS. */}
          <div style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', display: 'flex' }}>
            <select
              id='sonioxAudioDevice'
              style={{ width: '100%', minWidth: 0, maxWidth: '100%' }}
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
            </select>
          </div>
          {!hasMicLabels && (
            <button type='button' onClick={() => void requestMicPermission()} style={{ whiteSpace: 'nowrap' }}>
              授权
            </button>
          )}
          <button type='button' onClick={() => void enumerateMics()} style={{ whiteSpace: 'nowrap' }}>
            刷新
          </button>
        </div>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.4em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <span>语言：</span>
          {(['zh', 'en', 'ja', 'ko'] as const).map(lang => {
            // Short labels keep the row compact in a 320px panel — full
            // names "中文 / English / 日本語 / 한국어" + the "语言提示：" label
            // span ~316px which is over the section content width and forces
            // an awkward wrap. The `title` attribute keeps the full name
            // discoverable on hover.
            const labels: Record<string, string> = { zh: '中', en: 'EN', ja: '日', ko: '한' }
            const fullNames: Record<string, string> = { zh: '中文', en: 'English', ja: '日本語', ko: '한국어' }
            return (
              <span
                key={lang}
                className='cb-switch-row'
                style={{ display: 'inline-flex', alignItems: 'center', gap: '.2em' }}
                title={fullNames[lang]}
              >
                <input
                  type='checkbox'
                  checked={hints.includes(lang)}
                  onChange={e => updateLangHints(lang, e.currentTarget.checked)}
                />
                <label htmlFor={lang}>{labels[lang]}</label>
              </span>
            )
          })}
        </div>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <label htmlFor='sonioxMaxLength'>超过</label>
          <input
            id='sonioxMaxLength'
            type='number'
            min='1'
            max='200'
            title='允许范围：1–200'
            aria-label='Soniox 自动分段长度，允许范围 1–200'
            style={{ width: '46px' }}
            value={sonioxMaxLength.value}
            onInput={e => {
              const raw = Number.parseInt(e.currentTarget.value, 10)
              const v = Number.isFinite(raw) ? raw : 1
              sonioxMaxLength.value = Math.min(200, Math.max(1, v))
            }}
          />
          <span>字自动分段</span>
        </div>
        <div className='cb-row' style={{ display: 'flex', gap: '.75em', alignItems: 'center', flexWrap: 'wrap' }}>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='sonioxAutoSend'
              type='checkbox'
              checked={sonioxAutoSend.value}
              onInput={e => {
                sonioxAutoSend.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='sonioxAutoSend'>识别完成后自动发送弹幕</label>
          </span>
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='sonioxWrapBrackets'
              type='checkbox'
              checked={sonioxWrapBrackets.value}
              onInput={e => {
                sonioxWrapBrackets.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='sonioxWrapBrackets'>使用【】包裹同传内容</label>
          </span>
        </div>
      </div>

      <div
        className='cb-section cb-stack'
        style={{ margin: '.5em 0', paddingBottom: '.5em', borderBottom: '1px solid var(--Ga2, #eee)' }}
      >
        <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.5em' }}>
          实时翻译设置
        </div>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <span className='cb-switch-row' style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
            <input
              id='sonioxTranslationEnabled'
              type='checkbox'
              checked={sonioxTranslationEnabled.value}
              onInput={e => {
                sonioxTranslationEnabled.value = e.currentTarget.checked
              }}
            />
            <label htmlFor='sonioxTranslationEnabled'>启用实时翻译</label>
          </span>
        </div>
        <div className='cb-row' style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor='sonioxTranslationTarget'>翻译目标语言：</label>
          <select
            id='sonioxTranslationTarget'
            style={{ minWidth: '80px' }}
            value={sonioxTranslationTarget.value}
            onChange={e => {
              sonioxTranslationTarget.value = e.currentTarget.value
            }}
          >
            <option value='en'>English</option>
            <option value='zh'>中文</option>
            <option value='ja'>日本語</option>
          </select>
        </div>
        <div className='cb-note' style={{ marginTop: '.5em', color: '#666', fontSize: '0.9em' }}>
          启用后将发送翻译结果而非原始识别文字
        </div>
      </div>

      <div className='cb-section cb-stack' style={{ margin: '.5em 0' }}>
        <div
          className='cb-row'
          style={{ display: 'flex', gap: '.5em', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.5em' }}
        >
          <button type='button' onClick={() => void toggle()}>
            {btnText}
          </button>
          <span style={{ color: statusColor.value }}>{statusText.value}</span>
        </div>
        <div style={{ marginBlock: '.5em' }}>
          <div className='cb-heading' style={{ fontWeight: 'bold', marginBottom: '.25em' }}>
            实时识别结果：
          </div>
          <div
            className='cb-result'
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
        <AiCandidateSection />
      </div>
    </>
  )
}
