import { effect, signal, untracked } from '@preact/signals'

import type { LlmContentPart } from '../llm'
import type { CaptionerStatus, SceneNote } from './types'

import { chatCompletion, classifyMediaRejection } from '../llm'
import { appendLog } from '../log'
import { visionCaptionModel, visionCaptionProvider } from '../store'
import { isRecord, parseEmbeddedJson } from '../utils'
import { getKeptFrames, grabCurrentFrame, onSceneCut, visionAvailability } from './frame-sampler'
import { latestScene, recordScene, sceneNotes } from './scene-memory'
import { selectFrames } from './select-frames'

const SYSTEM_PROMPT = [
  '你是直播画面记录员，负责把直播画面截图整理成简短的文字记录，供其他模型理解直播内容。',
  '只描述画面中确实能看到的内容，看不清或不确定的不要猜。忽略画面中滚动的弹幕文字和聊天框。',
  '返回一个 JSON 对象：',
  '- "scene" (string)：不超过 30 个字，概括当前画面（主播在做什么、游戏或场景、画面上值得注意的文字）',
  '- "event" (string)：相比上一条记录刚刚发生的明显变化，没有则为空串',
  '返回示例：{"scene": "主播在玩恐怖游戏，角色站在走廊里", "event": "怪物突然出现"}',
].join('\n')

const SCENE_CUT_GAP_MS = 10_000
const REFRESH_MS = 45_000
const REFRESH_CHECK_MS = 5_000
const FRAME_WINDOW_MS = 12_000
const MAX_FRAMES = 2
// An older note would make `event` pass off long-past changes as 刚刚.
const PREV_NOTE_MAX_AGE_MS = 90_000
const CALL_TIMEOUT_MS = 30_000
const ERROR_LOG_GAP_MS = 60_000

interface CaptionConfig {
  base: string
  apiKey: string
  model: string
  /** Provider + base + model; a media rejection latches on it. */
  key: string
}

/** Caption model state; 'off' while stopped. */
export const captionerStatus = signal<CaptionerStatus>('off')

let startCount = 0
// Bumped on stop so a call from an earlier run can't touch state.
let session = 0
let config: CaptionConfig | null = null
let inflight: Promise<SceneNote | null> | null = null
let abortCall: AbortController | null = null
let disposers: (() => void)[] = []
let lastCallAt = Number.NEGATIVE_INFINITY
let lastErrorLogAt = Number.NEGATIVE_INFINITY
let unsupportedKey: string | null = null
let hintLogged = false

function readConfig(): CaptionConfig | null {
  const provider = visionCaptionProvider.value
  const model = visionCaptionModel.value.trim() || provider?.model.trim()
  if (!provider?.apiBase.trim() || !provider.apiKey.trim() || !model) return null
  return { base: provider.apiBase, apiKey: provider.apiKey, model, key: `${provider.id}:${provider.apiBase}:${model}` }
}

/** Status between calls: config problems first, else idle. */
function idleStatus(): CaptionerStatus {
  if (!config) return 'error'
  return config.key === unsupportedKey ? 'unsupported' : 'idle'
}

function applyConfig(next: CaptionConfig | null): void {
  config = next
  if (next && next.key !== unsupportedKey) unsupportedKey = null
  if (!next && !hintLogged) {
    hintLogged = true
    appendLog('⚠️ [画面识别] 请在「设置 → 画面识别」选择画面描述模型')
  }
  if (!inflight) captionerStatus.value = idleStatus()
}

/** Scene note from the model's JSON (or the outermost {…} in prose); the trimmed raw text when there is none. */
function parseNote(reply: string): string {
  const text = reply.trim()
  const parsed = parseEmbeddedJson(text)
  if (!isRecord(parsed)) return text
  const scene = typeof parsed.scene === 'string' ? parsed.scene.trim() : ''
  const event = typeof parsed.event === 'string' ? parsed.event.trim() : ''
  return scene && event ? `${scene}；刚刚：${event}` : scene || event
}

function logFailure(message: string): void {
  const now = Date.now()
  if (now - lastErrorLogAt < ERROR_LOG_GAP_MS) return
  lastErrorLogAt = now
  appendLog(`⚠️ [画面识别] 画面描述失败：${message}`)
}

async function runCaption(target: CaptionConfig, runSession: number): Promise<SceneNote | null> {
  const controller = new AbortController()
  abortCall = controller
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
  let failed = false
  try {
    const now = Date.now()
    const current = await grabCurrentFrame()
    if (!current || runSession !== session) return null
    const frames = selectFrames({ kept: getKeptFrames(), current, from: now - FRAME_WINDOW_MS, max: MAX_FRAMES })
    const content: LlmContentPart[] = [
      { type: 'text', text: `上一条记录：${latestScene(PREV_NOTE_MAX_AGE_MS, now)?.scene ?? '（无）'}` },
      ...frames.flatMap((frame): LlmContentPart[] => [
        { type: 'text', text: `【${frame.label}】` },
        { type: 'image_url', image_url: { url: frame.dataUrl } },
      ]),
    ]
    lastCallAt = now
    const reply = await chatCompletion({
      base: target.base,
      apiKey: target.apiKey,
      model: target.model,
      temperature: 0.2,
      maxTokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content },
      ],
      signal: controller.signal,
    })
    if (runSession !== session) return null
    const note = parseNote(reply)
    if (!note) return null
    recordScene(note, 'caption', current.at)
    // The note just recorded, unless a newer one landed meanwhile.
    return sceneNotes.peek().at(-1) ?? null
  } catch (err) {
    if (runSession !== session) return null
    if (classifyMediaRejection(err)) {
      unsupportedKey = target.key
      appendLog('❌ [画面识别] 画面描述模型不支持图片输入')
    } else {
      failed = true
      const message = err instanceof Error ? err.message : String(err)
      logFailure(controller.signal.aborted ? `请求超时（${CALL_TIMEOUT_MS / 1000} 秒）` : message)
    }
    return null
  } finally {
    clearTimeout(timer)
    if (runSession === session) {
      inflight = null
      abortCall = null
      // A config change mid-call makes this failure moot.
      captionerStatus.value = failed && config === target ? 'error' : idleStatus()
    }
  }
}

/** Start one caption, or join the one in flight; resolves null when it can't run. */
function caption(): Promise<SceneNote | null> {
  if (inflight) return inflight
  const target = config
  if (!target || target.key === unsupportedKey || visionAvailability.value !== 'ok') return Promise.resolve(null)
  captionerStatus.value = 'captioning'
  inflight = runCaption(target, session)
  return inflight
}

function refreshIfStale(): void {
  const now = Date.now()
  if (now - lastCallAt >= REFRESH_MS && !latestScene(REFRESH_MS, now)) void caption()
}

/** Ref-counted start. */
export function startCaptioner(): void {
  startCount++
  if (startCount > 1) return
  hintLogged = false
  const timer = setInterval(refreshIfStale, REFRESH_CHECK_MS)
  disposers = [
    () => clearInterval(timer),
    onSceneCut(() => {
      if (Date.now() - lastCallAt >= SCENE_CUT_GAP_MS) void caption()
    }),
    effect(() => {
      const next = readConfig()
      untracked(() => applyConfig(next))
    }),
  ]
}

/** Ref-counted stop; the last one aborts the call in flight. */
export function stopCaptioner(): void {
  if (startCount === 0) return
  startCount--
  if (startCount > 0) return
  session++
  for (const dispose of disposers) dispose()
  disposers = []
  abortCall?.abort()
  abortCall = null
  inflight = null
  captionerStatus.value = 'off'
}

/** Newest note ≤ maxAgeMs old; otherwise run one caption now, bounded by timeoutMs (default 8000). null when not running, unavailable or failed. */
export async function requestFreshScene(maxAgeMs: number, timeoutMs = 8_000): Promise<SceneNote | null> {
  if (startCount === 0) return null
  const fresh = latestScene(maxAgeMs, Date.now())
  if (fresh) return fresh
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([caption(), timeout])
  } finally {
    clearTimeout(timer)
  }
}
