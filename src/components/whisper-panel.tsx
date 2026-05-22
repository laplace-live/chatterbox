/**
 * In-browser Whisper STT panel — sibling to the Soniox UI in the
 * 同传 tab. Rendered when `sttProvider === 'whisper'`.
 *
 * **v2 architecture (current).** The v1 panel tried to bridge
 * Whisper's "full re-decode every pass" output into our append-
 * only send-queue via a stable-suffix diff. Dogfood measurements
 * showed this never worked well because Whisper's output is
 * substantially different between passes (different
 * hallucinations, different word boundaries) — the "stable prefix"
 * was rarely more than a few characters.
 *
 * v2 moves the hard part down into the engine: each
 * `onSegment` event already carries committed, append-only text
 * for a fresh ~3 s of audio. The panel just appends to a
 * transcript log and ships each segment through the existing send
 * queue. No diffing, no stability windows, no flashing partials.
 *
 * UI parity with the Soniox panel: device picker, language picker
 * (single-select for Whisper, not multi-hint), auto-send + bracket
 * wrap toggles. We intentionally reuse `sonioxAutoSend`,
 * `sonioxWrapBrackets`, `sonioxMaxLength`, and `sonioxAudioDeviceId`
 * settings so a user toggling between engines doesn't have to
 * reconfigure post-processing — those settings are about how to
 * shape *outgoing danmaku*, not about which STT service produced
 * the text.
 */

import { useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { tryAiEvasion } from '../lib/ai-evasion'
import { ensureRoomId, getCsrfToken } from '../lib/api'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import {
  sonioxAudioDeviceId,
  sonioxAutoSend,
  sonioxMaxLength,
  sonioxWrapBrackets,
  sttEndpointReached,
  sttRunning,
  sttTranscriptBuffer,
  whisperLanguage,
  whisperModel,
  whisperVadEnabled,
  whisperVadThreshold,
} from '../lib/store'
import { useWhisperRecording } from '../lib/use-whisper-recording'
import { splitTextSmart, stripTrailingPunctuation } from '../lib/utils'
import { isWebGpuAvailable, WHISPER_MODELS, type WhisperModelKey } from '../lib/whisper'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Label } from './ui/label'
import { NativeSelect } from './ui/native-select'

const HEADING_CLASS = 'font-bold mb-2'
const ROW_CLASS = 'flex gap-2 items-center flex-wrap mb-2'

/**
 * Display the last N segments worth of transcribed text so the
 * caption box doesn't grow unboundedly during long sessions. At
 * ~3 s per segment, 12 segments = ~36 s of recent history visible
 * at any time — plenty for a streamer dogfooding their captions
 * without scrolling a wall of text.
 */
const MAX_VISIBLE_SEGMENTS = 12

/**
 * Some Whisper outputs are clearly hallucinations even with our
 * RMS silence gate (model-imprinted boilerplate that triggers on
 * room tone). We drop any segment matching this exact-string
 * blocklist before it can pollute the caption or get auto-sent.
 * Extend as observed in the wild.
 */
const HALLUCINATION_BLOCKLIST = new Set([
  '了',
  '嗯',
  '啊',
  '哦',
  '呃',
  '本',
  '我',
  '的',
  '是',
  'Thank you.',
  'Thanks for watching.',
  'Thank you for watching.',
  '字幕由 Amara.org 社區提供',
  '小編工作室 製',
  '謝謝大家',
])

/**
 * Catch parenthesized "non-speech" annotations the model emits
 * when fed near-silent or noisy audio (`(咱們 咱們 咱們 ...)`,
 * `(I'll be in the sky)`, `(我都在看你)`, etc.). These are
 * sound-effect-style outputs Whisper learned from movie/captions
 * training data; they're useless in a livestream context and
 * leak into the danmaku send queue if not filtered. Matches both
 * half-width `()` and full-width `（）` since Whisper sometimes
 * mixes them on Chinese audio.
 */
const PARENTHESIZED_NONSPEECH_RE = /^[（(][^()（）]*[)）]$/

/**
 * Detect a single token repeated more than a few times — Whisper's
 * classic looping failure mode on silence or unintelligible audio.
 * The pattern is "same Chinese char or word repeated with optional
 * whitespace between" and is genuinely uninformative when it shows
 * up. Threshold of 4 repetitions is conservative — real speech
 * occasionally repeats words 2-3 times.
 */
function isLoopingHallucination(text: string): boolean {
  // Split on whitespace and Chinese punctuation; check whether
  // 4+ consecutive tokens are identical.
  const tokens = text.split(/[\s,，。.!！?？]+/).filter(Boolean)
  if (tokens.length < 4) return false
  let runLen = 1
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      runLen++
      if (runLen >= 4) return true
    } else {
      runLen = 1
    }
  }
  return false
}

function isLikelyHallucination(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (HALLUCINATION_BLOCKLIST.has(t)) return true
  // Pure punctuation / non-alphanumeric — typically Whisper emits
  // these as filler when it has nothing real to say.
  if (!/[\p{L}\p{N}]/u.test(t)) return true
  // Parenthesized "(non-speech)" outputs from sound-effect
  // captioning training data.
  if (PARENTHESIZED_NONSPEECH_RE.test(t)) return true
  // Looping repetition of the same token — a known Whisper
  // failure mode on silent or low-information audio.
  if (isLoopingHallucination(t)) return true
  return false
}

export function WhisperPanel() {
  const audioDevices = useSignal<MediaDeviceInfo[]>([])
  const loadStatusText = useSignal<string>('')
  const loadProgressPct = useSignal<number>(0)
  // Recent committed segments. Rendered as a single concatenated
  // caption — the last entry is the freshest.
  const segments = useSignal<string[]>([])
  // Most recent per-pass GPU + decode time, for the "X ms" status.
  const lastElapsedMs = useSignal<number>(0)
  // Last speech probability reported by Silero VAD. -1 = "no
  // pass yet / VAD disabled" so the UI can hide the indicator.
  const lastVadProb = useSignal<number>(-1)

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

  // ---- Danmaku send ------------------------------------------
  // Each committed segment goes through replacement → smart split
  // → enqueue. Unlike the v1 panel we don't accumulate into a
  // debounced flush buffer — the engine already debounces by
  // committing at ~3 s cadence, which is well-shaped for danmaku.
  const sendSegmentAsDanmaku = async (text: string) => {
    const wrap = sonioxWrapBrackets.value
    const maxLen = sonioxMaxLength.value || 40
    const splitLen = wrap ? Math.max(1, maxLen - 2) : maxLen
    const processed = applyReplacements(text.trim())
    if (!processed) return
    const pieces = splitTextSmart(processed, splitLen)
    for (const piece of pieces) {
      const clean = stripTrailingPunctuation(piece)
      if (!clean) continue
      const segment = wrap ? `【${clean}】` : clean
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
  }

  // ---- Hook ---------------------------------------------------
  const langForHook = whisperLanguage.value
  const modelForHook = whisperModel.value
  const vadEnabledForHook = whisperVadEnabled.value
  const vadThresholdForHook = whisperVadThreshold.value
  const savedDeviceId = sonioxAudioDeviceId.value
  const deviceStillAvailable = !savedDeviceId || audioDevices.value.some(d => d.deviceId === savedDeviceId)
  const effectiveDeviceId = deviceStillAvailable ? savedDeviceId : undefined

  const recording = useWhisperRecording({
    language: langForHook,
    model: modelForHook,
    deviceId: effectiveDeviceId,
    vad: { enabled: vadEnabledForHook, threshold: vadThresholdForHook },
    onLoadProgress: p => {
      loadProgressPct.value = Math.round(p.progress)
    },
    onLoadStatus: msg => {
      loadStatusText.value = msg
    },
    onReady: () => {
      loadStatusText.value = '模型已加载，等待语音…'
      appendLog('🎤 Whisper 模型已加载')
    },
    onSegment: (text, elapsedMs) => {
      lastElapsedMs.value = elapsedMs
      const trimmed = text.trim()
      if (!trimmed || isLikelyHallucination(trimmed)) return
      // Append to the visible log, capped to MAX_VISIBLE_SEGMENTS.
      const next = [...segments.value, trimmed]
      if (next.length > MAX_VISIBLE_SEGMENTS) next.splice(0, next.length - MAX_VISIBLE_SEGMENTS)
      segments.value = next
      // Feed downstream consumers (AI Chat, send queue).
      sttTranscriptBuffer.value = sttTranscriptBuffer.value + trimmed
      sttEndpointReached.value = true
      if (sonioxAutoSend.value) {
        void sendSegmentAsDanmaku(trimmed)
      }
    },
    onVadSkipped: (speechProb, _elapsedMs) => {
      // VAD rejected the chunk — surface enough info to debug
      // false-positive filtering without spamming. Two-decimal
      // probability is the minimum useful precision (0.30 vs
      // 0.29 is the calibration question).
      lastVadProb.value = speechProb
    },
    onError: err => {
      appendLog(`🔴 Whisper 错误：${err.message}`)
    },
  })

  // Mirror the global `sttRunning` flag so other modules (AI Chat,
  // info panel) can react to either engine being live without
  // caring which one.
  useEffect(() => {
    sttRunning.value = recording.isActive.value
  }, [recording.isActive.value])

  const toggle = async () => {
    if (recording.isActive.value) {
      await recording.stop()
      appendLog('🎤 Whisper 同传已停止')
      segments.value = []
      lastElapsedMs.value = 0
      return
    }

    if (!isWebGpuAvailable()) {
      appendLog('❌ 当前浏览器不支持 WebGPU；请使用 Chrome / Edge ≥ 113，且未禁用 WebGPU')
      return
    }
    if (savedDeviceId && !deviceStillAvailable) {
      appendLog('⚠️ 已选麦克风不可用，已切换至系统默认')
      sonioxAudioDeviceId.value = ''
    }
    segments.value = []
    lastElapsedMs.value = 0
    const cfg = WHISPER_MODELS[whisperModel.value]
    appendLog(
      `🎤 启动本地 Whisper (${cfg.label.split(' — ')[0]}），首次加载需下载约 ${cfg.approxDownloadMb} MB 模型，请耐心等待`
    )
    recording.start()
  }

  const devices = audioDevices.value
  const hasMicLabels = devices.some(d => d.label)
  const savedDeviceMissing = Boolean(savedDeviceId) && !devices.some(d => d.deviceId === savedDeviceId)

  const state = recording.state.value
  const btnText =
    state === 'loading'
      ? '加载中…'
      : state === 'starting'
        ? '启动中…'
        : state === 'stopping'
          ? '停止中…'
          : state === 'running'
            ? '停止同传'
            : '开始同传'
  const statusText =
    state === 'loading'
      ? loadStatusText.value || '正在初始化…'
      : state === 'starting'
        ? '正在准备麦克风…'
        : state === 'running'
          ? `本地识别中… ${lastElapsedMs.value > 0 ? `(${lastElapsedMs.value}ms/段)` : ''}`
          : state === 'error'
            ? '错误'
            : '未启动'
  const statusColor = state === 'running' ? '#36a185' : state === 'error' ? '#f44' : '#666'

  const webgpuOk = isWebGpuAvailable()
  const captionText = segments.value.join(' ')

  return (
    <>
      <div class='my-2'>
        <div class={HEADING_CLASS}>本地 Whisper 设置</div>
        <div class='mb-2 text-ga6'>
          完全在浏览器内运行的语音识别引擎，无需 API
          Key、不上传音频。首次启动需按选中模型下载权重，加载后可永久离线使用。需要支持 WebGPU 的浏览器（推荐 Chrome /
          Edge 113+）。
        </div>
        {!webgpuOk && (
          <div class='my-2 rounded bg-red-900/30 p-2 text-red-300'>
            ❌ 当前浏览器不支持 WebGPU，无法启动本地识别。请改用 Chrome / Edge 最新版本。
          </div>
        )}
        <div class={ROW_CLASS}>
          <Label htmlFor='whisperAudioDevice'>设备</Label>
          <NativeSelect
            id='whisperAudioDevice'
            className='min-w-37.5 flex-1 pr-5'
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
          <Label htmlFor='whisperModel'>模型</Label>
          <NativeSelect
            id='whisperModel'
            className='min-w-37.5 flex-1 pr-5'
            value={whisperModel.value}
            onChange={e => {
              const v = e.currentTarget.value
              if (v in WHISPER_MODELS) {
                // Switching the model while the engine is running
                // is a no-op until the next start (the hook reads
                // model at start time). Surface that to the user
                // via the log if they swap mid-session.
                if (recording.isActive.value && v !== whisperModel.value) {
                  appendLog('ℹ️ 已切换模型，下一次启动同传时生效')
                }
                whisperModel.value = v as WhisperModelKey
              }
            }}
          >
            {Object.entries(WHISPER_MODELS).map(([key, cfg]) => (
              <option key={key} value={key}>
                {cfg.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div class='mb-2 text-ga6'>
          推荐 <code>Turbo</code>（560 MB / q4f16 量化）。追求最佳准确度可选 <code>Turbo HQ</code>（1.6 GB / fp16
          全精度）。两者基于同一份 OpenAI Whisper-large-v3 权重， 仅量化精度不同；首次切换需重新下载对应权重。
        </div>
        <div class={ROW_CLASS}>
          <Checkbox
            id='whisperVadEnabled'
            checked={whisperVadEnabled.value}
            onChange={e => {
              whisperVadEnabled.value = (e.currentTarget as HTMLInputElement).checked
            }}
          />
          <Label htmlFor='whisperVadEnabled'>过滤背景音乐 (Silero VAD)</Label>
          {whisperVadEnabled.value && (
            <>
              <Label htmlFor='whisperVadThreshold' className='ml-2'>
                阈值
              </Label>
              <input
                id='whisperVadThreshold'
                type='range'
                min={0}
                max={1}
                step={0.05}
                value={whisperVadThreshold.value}
                onInput={e => {
                  whisperVadThreshold.value = Number((e.currentTarget as HTMLInputElement).value)
                }}
                class='w-30'
              />
              <span class='font-mono text-xs tabular-nums'>{whisperVadThreshold.value.toFixed(2)}</span>
              {lastVadProb.value >= 0 && (
                <span class='font-mono text-ga6 text-xs tabular-nums'>最近: {lastVadProb.value.toFixed(2)}</span>
              )}
            </>
          )}
        </div>
        <div class='mb-2 text-ga6'>
          启用后，每段音频先用 Silero VAD（~1 MB）判定是否包含人声。低于阈值的片段直接跳过， 避免直播 BGM 被 Whisper
          误识别成歌词或胡乱填字。阈值越低越宽松（漏过更多非语音）； 越高越严格（可能丢失轻声说话）。
        </div>
        <div class={ROW_CLASS}>
          <Label htmlFor='whisperLang'>识别语言</Label>
          <NativeSelect
            id='whisperLang'
            className='min-w-20'
            value={whisperLanguage.value}
            onChange={e => {
              const v = e.currentTarget.value
              if (v === 'zh' || v === 'en' || v === 'ja' || v === 'ko') whisperLanguage.value = v
            }}
          >
            <option value='zh'>中文</option>
            <option value='en'>English</option>
            <option value='ja'>日本語</option>
            <option value='ko'>한국어</option>
          </NativeSelect>
          <span class='text-ga6'>本地引擎暂不支持翻译，仅识别为所选语言</span>
        </div>
        <div class='flex flex-wrap items-center gap-3'>
          <Checkbox
            id='whisperAutoSend'
            checked={sonioxAutoSend.value}
            onInput={e => {
              sonioxAutoSend.value = e.currentTarget.checked
            }}
            label='识别完成后自动发送弹幕'
          />
          <Checkbox
            id='whisperWrapBrackets'
            checked={sonioxWrapBrackets.value}
            onInput={e => {
              sonioxWrapBrackets.value = e.currentTarget.checked
            }}
            label='使用【】包裹同传内容'
          />
        </div>
      </div>

      <div class='my-2'>
        <div class={ROW_CLASS}>
          <Button
            variant={state === 'running' ? 'destructive' : 'default'}
            size='sm'
            disabled={!webgpuOk || state === 'loading' || state === 'starting' || state === 'stopping'}
            onClick={() => void toggle()}
          >
            {btnText}
          </Button>
          <span style={{ color: statusColor }}>{statusText}</span>
        </div>
        {state === 'loading' && loadProgressPct.value > 0 && loadProgressPct.value < 100 && (
          <div class='my-2'>
            <div class='h-2 w-full overflow-hidden rounded bg-bg2'>
              <div class='h-full bg-link transition-all' style={{ width: `${loadProgressPct.value}%` }} />
            </div>
            <div class='mt-1 text-ga6'>{loadProgressPct.value}%</div>
          </div>
        )}
        <div class='my-2'>
          <div class='mb-1 font-bold'>识别结果（最近 {MAX_VISIBLE_SEGMENTS} 段）：</div>
          {/* Single stable caption — append-only at the segment
              level, no per-token flicker, updates ~1/s during
              continuous speech. */}
          <div class='max-h-30 min-h-10 overflow-y-auto break-all rounded bg-bg2 p-2'>{captionText}</div>
        </div>
      </div>
    </>
  )
}
