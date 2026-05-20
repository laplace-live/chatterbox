/**
 * 智能辅助驾驶（HzmAutoDrive）运行时。
 *
 * 这是参考插件 `Bilibili-Live-Spamer_sbhzm` 的 `HzmAutoDrive` 类的 chatterbox 移植：
 * - 监听最近 60 秒的公屏弹幕（**走 chatterbox 已有的 `subscribeDanmaku`**，不再
 *   单独挂 MutationObserver）
 * - 自调度 jitter tick（基础间隔 × 0.7~1.5）
 * - 每 tick：
 *   1. 检查每日统计是否需要按日期重置
 *   2. 检查暂停关键词（命中则 60s 内不发）
 *   3. 检查每分钟限速
 *   4. 选梗：默认启发式；mode='llm' 时每 N 次 tick 一次 LLM（其余仍走启发式）
 *   5. dryRun=true 只 appendLog；否则走 `enqueueDanmaku(SendPriority.AUTO)`
 *
 * 与已有 auto-blend 共存：两者都通过同一个全局发送队列 (`send-queue.ts`)，
 * 不会冲突。但同时启用会叠加每分钟发送量；UI 上提示用户。
 *
 * 与文字独轮车（loop.ts）共存：同上，只是日志多一条提示。
 */

import { effect } from '@preact/signals'

import type { MemeSource } from './meme-sources'
import type { LaplaceMemeWithSource } from './sbhzm-client'

import { enqueueExternalCandidate } from './ai-candidate'
import { ensureRoomId, getCsrfToken } from './api'
import { detectTrend } from './auto-blend-trend'
import { subscribeDanmaku } from './danmaku-stream'
import { formatHzmDriveStatus } from './hzm-drive-status'
import { appendLog, notifyUser } from './log'
import { enqueueDanmaku, SendPriority } from './send-queue'
import {
  bumpDailyLlmCalls,
  bumpDailySent,
  getBlacklistTags,
  getRecentSent,
  getSelectedTags,
  hzmActivityMinDanmu,
  hzmActivityMinDistinctUsers,
  hzmActivityWindowSec,
  hzmDriveEnabled,
  hzmDriveIntervalSec,
  hzmDriveMode,
  hzmDriveSendMode,
  hzmDriveStatusText,
  hzmDryRun,
  hzmLlmRatio,
  hzmPauseKeywordsOverride,
  hzmRateLimitPerMin,
  hzmStrictHeuristic,
  pushRecentSent,
} from './store-hzm'
import { llmApiKey, llmBaseURL, llmModel, llmProvider } from './store-llm'
import { maxLength } from './store-send'
import { splitTextSmart } from './utils'

// 60s 而不是旧版 30s——为了确保活跃度闸门窗口（默认 45s）总能看到完整数据。
// 闸门窗口可调，但保留缓冲到 60s 让用户配大窗口时不卡上限。
const RECENT_DANMU_TTL_MS = 60_000
const RECENT_DANMU_MAX = 200
const PAUSE_HOLD_MS = 60_000
const MIN_TICK_DELAY_MS = 2_000

interface DanmuRecord {
  ts: number
  text: string
  uid: string | null
}

let recentDanmu: DanmuRecord[] = []
let unsubscribe: (() => void) | null = null
let tickTimer: ReturnType<typeof setTimeout> | null = null
let pausedUntil = 0
const sentTimestamps: number[] = []
let heuristicTickCount = 0
let activeRoomId: number | null = null
let activeSource: MemeSource | null = null
let memesProvider: (() => LaplaceMemeWithSource[]) | null = null
/** 最近一次成功发送（含 dryRun 候选）的时间戳。喂给 formatHzmDriveStatus。 */
let lastActionAt: number | null = null
/**
 * LLM 连续失败计数。每次 `pickWithLLM` catch 增 1；任何一次成功（含 abstain）
 * 都重置为 0。配合 `lastLlmFailureToastAt` 做去抖，避免 LLM 持续故障时连续
 * 撸 toast。原计划文档 P0-4：用户填了错的 key 时不能让脚本"看起来在跑"。
 */
let consecutiveLlmFailures = 0
let lastLlmFailureToastAt = 0
/** LLM 连续失败 toast 之间最少间隔 5 分钟，避免长期故障刷屏。 */
const LLM_FAILURE_TOAST_COOLDOWN_MS = 5 * 60_000
/** 触发 toast 的连续失败阈值——3 次表示"真有问题"（偶发抖动通常 1-2 次）。 */
const LLM_FAILURE_TOAST_THRESHOLD = 3

/** 重置全部运行时状态（停车时调用）。 */
function resetRuntime(): void {
  recentDanmu = []
  pausedUntil = 0
  sentTimestamps.length = 0
  heuristicTickCount = 0
  activeRoomId = null
  activeSource = null
  memesProvider = null
  lastActionAt = null
  consecutiveLlmFailures = 0
  lastLlmFailureToastAt = 0
}

function updateHzmStatusText(): void {
  hzmDriveStatusText.value = formatHzmDriveStatus({
    enabled: hzmDriveEnabled.value,
    mode: hzmDriveMode.value,
    // formatHzmDriveStatus 现仍按 boolean 接 dryRun;'dry' 和 'candidate' 都视作
    // 不会真发(状态文案显示"试运行/观察中"语义即可,候选档的 review 提示由
    // AI 陪聊面板自己显示)。'live' 才是真发。
    dryRun: hzmDriveSendMode.value !== 'live',
    lastActionAt,
    now: Date.now(),
    gateOpen: isActivityGateOpen(Date.now()),
  })
}

/**
 * 活跃度闸门：最近窗口内是否有"足够多人在说话"。
 *
 * 必须同时满足两个阈值：
 *  1. ≥ `hzmActivityMinDanmu` 条公屏弹幕（量）
 *  2. ≥ `hzmActivityMinDistinctUsers` 个不同 uid（人数，防一人狂刷）
 *
 * 时间窗口由 `hzmActivityWindowSec` 控制。导出供测试与状态文本共用。
 */
export function isActivityGateOpen(now: number, records?: DanmuRecord[]): boolean {
  const cutoff = now - hzmActivityWindowSec.value * 1000
  const window = (records ?? recentDanmu).filter(d => d.ts >= cutoff)
  if (window.length < hzmActivityMinDanmu.value) return false
  const distinctUids = new Set<string>()
  for (const d of window) {
    if (d.uid) distinctUids.add(d.uid)
  }
  return distinctUids.size >= hzmActivityMinDistinctUsers.value
}

// 任何相关 signal 变化都让状态文本重算。
effect(() => {
  // touch all deps to subscribe
  void hzmDriveEnabled.value
  void hzmDriveMode.value
  void hzmDriveSendMode.value
  updateHzmStatusText()
})

function getRecentDanmuTexts(): string[] {
  const cutoff = Date.now() - RECENT_DANMU_TTL_MS
  recentDanmu = recentDanmu.filter(d => d.ts >= cutoff)
  return recentDanmu.map(d => d.text)
}

function getEffectivePauseKeywords(source: MemeSource): RegExp[] {
  const override = hzmPauseKeywordsOverride.value.trim()
  const lines = override
    ? override
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    : (source.pauseKeywords ?? [])
  const patterns: RegExp[] = []
  for (const p of lines) {
    try {
      patterns.push(new RegExp(p))
    } catch {
      // ignore malformed pattern
    }
  }
  return patterns
}

function shouldPauseFromKeywords(source: MemeSource): boolean {
  const recent = getRecentDanmuTexts().join(' ')
  for (const re of getEffectivePauseKeywords(source)) {
    if (re.test(recent)) {
      pausedUntil = Date.now() + PAUSE_HOLD_MS
      appendLog(`⏸ 智驾：检测到暂停关键词，60s 内不发`)
      return true
    }
  }
  return Date.now() < pausedUntil
}

function withinRateLimit(): boolean {
  const cutoff = Date.now() - 60_000
  while (sentTimestamps.length > 0 && sentTimestamps[0] < cutoff) {
    sentTimestamps.shift()
  }
  return sentTimestamps.length < hzmRateLimitPerMin.value
}

/**
 * 候选池：从给定梗集里过滤掉
 *  - 最近发送过的
 *  - 命中黑名单 tag 的
 * 仅保留有内容的条。导出供测试用。
 */
export function buildCandidatePool(opts: {
  roomId: number
  memes: LaplaceMemeWithSource[]
  /** 显式注入便于测试；不传则从 store 读。 */
  recentSent?: string[]
  blacklistTags?: string[]
}): LaplaceMemeWithSource[] {
  const recent = new Set(opts.recentSent ?? getRecentSent(opts.roomId))
  const blacklist = new Set(opts.blacklistTags ?? getBlacklistTags(opts.roomId))
  return opts.memes.filter(m => {
    if (!m.content) return false
    if (recent.has(m.content)) return false
    return !m.tags.some(t => blacklist.has(t.name))
  })
}

/**
 * 启发式选梗（纯函数，便于测试）。
 *
 * 信号优先级（命中即用）：
 *  1. **trending 文本**（如果给了 `recentDanmu`）：用 detectTrend 拿窗口内最高频
 *     的一条公屏，再用它去匹配 keywordToTag。这是最强信号——观众正在刷的话题
 *     直接对应到 tag 会让选梗特别贴脸。
 *  2. **整体公屏文本**：旧逻辑，把 join 后的 recentDanmuText 整体匹配 keywordToTag。
 *  3. **用户预选 selectedTags**：按预选 tag 过滤候选池。
 *  4. **strict 短路**：以上都没命中且 `strict=true` → 返回 null（本 tick 不发）。
 *     `strict=false` → 落到候选池随机选（旧行为）。
 *
 * 默认从 store 读所有可调项；测试时可显式注入。
 */
export function pickByHeuristic(opts: {
  roomId: number
  source: MemeSource
  memes: LaplaceMemeWithSource[]
  recentDanmuText: string
  /** 测试时可显式覆盖；不传则从 store 读。 */
  recentSent?: string[]
  blacklistTags?: string[]
  selectedTags?: string[]
  /** 测试时可注入伪随机值（0..1）替代 Math.random，便于稳定断言。 */
  randomFn?: () => number
  /**
   * 最近窗口内的弹幕记录。给了就走 trending-first 选梗，能用 detectTrend 拿出
   * 最高频公屏文本去匹配 keywordToTag。不给则跳过这一步，回落到老逻辑。
   */
  recentDanmu?: DanmuRecord[]
  /**
   * strict 模式：trending / keywordToTag / selectedTags 都没命中时是否短路。
   * 不传则从 store 读 `hzmStrictHeuristic`，默认 true。
   */
  strict?: boolean
  /**
   * trending 文本的最低次数门槛——detectTrend 的 threshold。默认 2，单条不算 trending。
   */
  trendingThreshold?: number
  /** trending 计算窗口。默认 30 秒，比闸门窗口短一些，更聚焦"最近一波"。 */
  trendingWindowMs?: number
}): LaplaceMemeWithSource | null {
  const pool = buildCandidatePool({
    roomId: opts.roomId,
    memes: opts.memes,
    recentSent: opts.recentSent,
    blacklistTags: opts.blacklistTags,
  })
  if (pool.length === 0) return null

  const keywordEntries = Object.entries(opts.source.keywordToTag ?? {})
  const matchKeyword = (text: string): string | null => {
    for (const [pattern, tag] of keywordEntries) {
      try {
        if (new RegExp(pattern).test(text)) return tag
      } catch {
        // skip malformed pattern
      }
    }
    return null
  }

  // 信号 1：trending 文本（若提供了 recentDanmu）
  let matchedTag: string | null = null
  if (opts.recentDanmu && opts.recentDanmu.length > 0) {
    const windowMs = opts.trendingWindowMs ?? 30_000
    const threshold = opts.trendingThreshold ?? 2
    const trend = detectTrend(
      opts.recentDanmu.map(d => ({ text: d.text, ts: d.ts, uid: d.uid })),
      windowMs,
      threshold
    )
    if (trend.text) {
      const tag = matchKeyword(trend.text)
      if (tag) matchedTag = tag
    }
  }

  // 信号 2：整体公屏文本（旧逻辑）
  if (!matchedTag) matchedTag = matchKeyword(opts.recentDanmuText)

  let filtered: LaplaceMemeWithSource[] | null = null
  if (matchedTag) {
    const byTag = pool.filter(m => m.tags.some(t => t.name === matchedTag))
    if (byTag.length > 0) filtered = byTag
  } else {
    // 信号 3：用户预选 tag
    const selected = opts.selectedTags ?? getSelectedTags(opts.roomId)
    if (selected.length > 0) {
      const sel = new Set(selected)
      const bySelected = pool.filter(m => m.tags.some(t => sel.has(t.name)))
      if (bySelected.length > 0) filtered = bySelected
    }
  }

  // 4. 没命中任何信号——strict 短路 vs 旧版随机兜底
  if (filtered === null) {
    const strict = opts.strict ?? hzmStrictHeuristic.value
    if (strict) return null
    filtered = pool
  }

  const rand = opts.randomFn ?? Math.random
  return filtered[Math.floor(rand() * filtered.length)] ?? null
}

/**
 * LLM 选梗结果三态：
 *  - `pick`：选到了一条梗
 *  - `abstain`：LLM 主动判定都不合适（返回 -1）；调用方应**尊重**，不要再回退启发式发别的
 *  - `error`：LLM 调用失败（HTTP 报错、超时、未配 key、空池等）；调用方应回退启发式
 *
 * 旧版本只返回 `null`，调用方无法区分 abstain 和 error，结果一律回退启发式 → -1
 * 在产品上完全失效。修这个，让 LLM 弃权能真正"安静下来"。
 */
export type LlmPickResult = { kind: 'pick'; meme: LaplaceMemeWithSource } | { kind: 'abstain' } | { kind: 'error' }

/**
 * Exported with DI hooks (`getMemes`, `recentChat`, `chooser`) for unit
 * testing. Production callers (the tick loop) leave them undefined and the
 * function reads from the module-level `memesProvider` / `getRecentDanmuTexts()`,
 * and resolves `chooseMemeWithLLM` via dynamic import.
 *
 * The `chooser` DI hook avoids bun-test cross-file mock leakage (we can't use
 * `mock.module('./llm-driver', ...)` here because llm-driver tests in the same
 * process would inherit the stub). Same rationale as `_setGmXhrForTests` in
 * [gm-fetch.ts](src/lib/gm-fetch.ts).
 */
export type LlmChooser = (opts: import('./llm-driver').ChooseMemeOptions) => Promise<string | null>

export async function pickByLLM(
  roomId: number,
  source: MemeSource,
  opts?: {
    getMemes?: () => LaplaceMemeWithSource[]
    recentChat?: string[]
    chooser?: LlmChooser
  }
): Promise<LlmPickResult> {
  const apiKey = llmApiKey.value.trim()
  if (!apiKey) return { kind: 'error' }
  const all = opts?.getMemes?.() ?? memesProvider?.() ?? []
  const pool = buildCandidatePool({ roomId, memes: all }).slice(0, 30)
  if (pool.length === 0) return { kind: 'error' }

  bumpDailyLlmCalls(roomId)
  try {
    const chooser = opts?.chooser ?? (await import('./llm-driver')).chooseMemeWithLLM
    const chosenContent = await chooser({
      provider: llmProvider.value,
      apiKey,
      model: llmModel.value,
      baseURL: llmBaseURL.value.trim() || undefined,
      roomName: source.name,
      recentChat: opts?.recentChat ?? getRecentDanmuTexts().slice(-30),
      candidates: pool.map(m => ({ id: String(m.id), content: m.content, tags: m.tags.map(t => t.name) })),
    })
    if (!chosenContent) {
      // abstain 也算"LLM 通了"——重置失败计数。
      consecutiveLlmFailures = 0
      return { kind: 'abstain' }
    }
    const meme = pool.find(m => m.content === chosenContent)
    if (meme) consecutiveLlmFailures = 0
    return meme ? { kind: 'pick', meme } : { kind: 'abstain' }
  } catch (err) {
    appendLog(`⚠️ 智驾 LLM 调用失败，回退启发式：${err instanceof Error ? err.message : String(err)}`)
    consecutiveLlmFailures++
    // 连续 N 次 + 5 分钟 cooldown 才弹一次 toast。这样：
    //  - 偶发 1-2 次失败（网络抖动）只进日志，不打扰用户。
    //  - 持续失败（错 key / 无效 model）会被显式提示，不再"看起来在跑实际在裸退化"。
    //  - cooldown 防长期故障刷屏。
    const now = Date.now()
    if (
      consecutiveLlmFailures >= LLM_FAILURE_TOAST_THRESHOLD &&
      now - lastLlmFailureToastAt >= LLM_FAILURE_TOAST_COOLDOWN_MS
    ) {
      lastLlmFailureToastAt = now
      notifyUser(
        'warning',
        `智驾 LLM 已连续失败 ${consecutiveLlmFailures} 次，已回退到启发式选梗`,
        '请检查 API key / model / base URL，或在「设置 → LLM」点「测试连接」定位问题。'
      )
    }
    return { kind: 'error' }
  }
}

async function sendOne(roomId: number, meme: LaplaceMemeWithSource): Promise<void> {
  const sendMode = hzmDriveSendMode.value

  if (sendMode === 'dry') {
    appendLog(`🚗[试运行] 智驾候选：${meme.content}`)
    pushRecentSent(roomId, meme.content)
    lastActionAt = Date.now()
    updateHzmStatusText()
    return
  }

  if (sendMode === 'candidate') {
    // Push 到 AI 陪聊 review 队列;不真发、不计入限速、不增加日发送计数。
    // 但仍要 pushRecentSent,否则同一条会在下一 tick 又被选中,把队列灌满。
    enqueueExternalCandidate({
      source: 'hzm-drive',
      content: meme.content,
      reason: `智驾(${hzmDriveMode.value})选中`,
    })
    appendLog(`🚗 智驾候选已入审:${meme.content}`)
    pushRecentSent(roomId, meme.content)
    lastActionAt = Date.now()
    updateHzmStatusText()
    return
  }

  const csrfToken = getCsrfToken()
  if (!csrfToken) {
    appendLog('❌ 智驾：未找到登录信息，已暂停发送')
    pausedUntil = Date.now() + PAUSE_HOLD_MS
    return
  }

  try {
    const segments = splitTextSmart(meme.content, maxLength.value)
    const total = segments.length
    let recentRecorded = false

    for (let i = 0; i < total; i++) {
      const segment = segments[i]
      const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.AUTO)
      const tag = total > 1 ? ` [${i + 1}/${total}]` : ''

      if (result.success && !result.cancelled) {
        sentTimestamps.push(Date.now())
        bumpDailySent(roomId)
        if (!recentRecorded) {
          pushRecentSent(roomId, meme.content)
          recentRecorded = true
        }
        lastActionAt = Date.now()
        appendLog(`🚗 智驾：${segment}${tag}`)
      } else if (result.cancelled) {
        appendLog(`⏭ 智驾被打断：${segment}${tag}`)
        break
      } else {
        appendLog(`❌ 智驾发送失败：${segment}${tag}，原因：${result.error ?? '未知'}`)
        break
      }
    }

    updateHzmStatusText()
  } catch (err) {
    appendLog(`❌ 智驾发送异常：${err instanceof Error ? err.message : String(err)}`)
  }
}

async function tick(): Promise<void> {
  // 已停车 / 房间号变了 → 静默退出
  if (!hzmDriveEnabled.value || activeRoomId === null || activeSource === null) {
    tickTimer = null
    return
  }

  try {
    const now = Date.now()
    if (shouldPauseFromKeywords(activeSource)) {
      scheduleNext(hzmDriveIntervalSec.value * 2)
      return
    }
    if (now < pausedUntil) {
      scheduleNext(hzmDriveIntervalSec.value)
      return
    }
    if (!withinRateLimit()) {
      scheduleNext(hzmDriveIntervalSec.value)
      return
    }

    // 活跃度闸门：公屏没活就闭嘴。静默退出，**不写日志**——不然冷清房间日志会爆。
    // 状态文本通过 updateHzmStatusText() 反映为"观察中（公屏冷清）"。
    if (!isActivityGateOpen(now)) {
      updateHzmStatusText()
      scheduleNext(hzmDriveIntervalSec.value)
      return
    }

    heuristicTickCount++
    let meme: LaplaceMemeWithSource | null = null
    const llmRatio = Math.max(1, hzmLlmRatio.value)
    const useLLM = hzmDriveMode.value === 'llm' && llmApiKey.value.trim() !== '' && heuristicTickCount % llmRatio === 0
    if (useLLM) {
      const result = await pickByLLM(activeRoomId, activeSource)
      // 用户在 LLM await 期间关停 / 切换房间 → 立刻退出,不要 sendOne。
      if (!hzmDriveEnabled.value || activeRoomId === null || activeSource === null) return
      if (result.kind === 'abstain') {
        // LLM 主动 -1：尊重，本 tick 不发，**不**回退启发式。这是 -1 信号生效的关键。
        scheduleNext(hzmDriveIntervalSec.value)
        return
      }
      if (result.kind === 'pick') meme = result.meme
      // result.kind === 'error' → meme 仍为 null，下面回退启发式
    }
    if (!meme) {
      meme = pickByHeuristic({
        roomId: activeRoomId,
        source: activeSource,
        memes: memesProvider?.() ?? [],
        recentDanmuText: getRecentDanmuTexts().join(' '),
        recentDanmu: recentDanmu,
      })
    }
    if (meme) {
      // 再次确认 enabled / room — pickByHeuristic 是同步的,但 useLLM 路径已经
      // 跨过一次 await,且 sendOne 内部还会再 await。任何一次 await 之后
      // hzmDriveEnabled 都可能已被 stop 翻成 false。
      if (!hzmDriveEnabled.value || activeRoomId === null || activeSource === null) return
      await sendOne(activeRoomId, meme)
    }
  } catch (err) {
    appendLog(`⚠️ 智驾 tick 异常：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // finally 里仍然要 scheduleNext —— 但 scheduleNext 本身只在 enabled 时排下一拍
    // (它内部已经检查 hzmDriveEnabled),所以 stop 路径不会被 finally 重启。
    scheduleNext(hzmDriveIntervalSec.value)
  }
}

function scheduleNext(baseSec: number): void {
  if (!hzmDriveEnabled.value) {
    tickTimer = null
    return
  }
  const jitter = baseSec * (0.7 + Math.random() * 0.8)
  const delay = Math.max(MIN_TICK_DELAY_MS, Math.round(jitter * 1000))
  tickTimer = setTimeout(() => {
    void tick()
  }, delay)
}

/**
 * 启动智驾。调用方需要传入：
 *  - 当前房间号
 *  - 该房间的梗源配置
 *  - 一个回调，每次 tick 拿到当前可用梗列表（避免我们自己再拉一次）
 *
 * 重复调用安全：会先 stop 再 start。
 */
export async function startHzmAutoDrive(opts: {
  source: MemeSource
  getMemes: () => LaplaceMemeWithSource[]
}): Promise<void> {
  stopHzmAutoDrive()

  let roomId: number
  try {
    roomId = await ensureRoomId()
  } catch (err) {
    notifyUser('error', '智驾启动失败：无法获取房间号', err instanceof Error ? err.message : String(err))
    return
  }
  if (roomId !== opts.source.roomId) {
    // 调用方应该已经构造了匹配的 source(注册的灰泽满源走 getMemeSourceForRoom;
    // 其他房间走 makeSyntheticSource(roomId))。能走到这里说明上游传错了 —— 这是
    // bug,弹 warning 让我们看到。
    notifyUser('warning', `当前房间 (${roomId}) 与梗源配置 (${opts.source.roomId}) 不匹配，智驾未启动`)
    return
  }

  activeRoomId = roomId
  activeSource = opts.source
  memesProvider = opts.getMemes

  unsubscribe = subscribeDanmaku({
    onMessage: ev => {
      if (!ev.text) return
      // 大表情(bulge-emoticon)的 `data-danmaku` 是"应援"/"干杯"这类
      // 显示名,不是 emoticon_unique。混进 recentDanmu 会污染 LLM/启发式
      // 选梗时的"近期热度"统计,把"应援"这种本就不可重发的字符串选进
      // 推荐里——同样的理由,自动跟车也在 recordDanmaku 里硬丢这种事件。
      if (ev.hasLargeEmote) return
      recentDanmu.push({ ts: Date.now(), text: ev.text, uid: ev.uid ?? null })
      if (recentDanmu.length > RECENT_DANMU_MAX) {
        recentDanmu.splice(0, recentDanmu.length - RECENT_DANMU_MAX)
      }
    },
  })

  appendLog(
    `🤖 智能辅助驾驶已启动（mode=${hzmDriveMode.value}，试运行=${hzmDryRun.value ? '开' : '关'}）— 独轮车工具无罪，请合理使用`
  )
  updateHzmStatusText()
  // 立即跑第一 tick（不等 jitter）
  void tick()
}

/** 停止智驾。多次调用安全。 */
export function stopHzmAutoDrive(): void {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  resetRuntime()
  updateHzmStatusText()
}

/** 测试用：当前监听到的最近弹幕。 */
export function _getRecentDanmuForTests(): DanmuRecord[] {
  return [...recentDanmu]
}

/**
 * 测试用：直接跑一次 tick，跳过 setTimeout/jitter 调度。让单元测试能稳定断言
 * 暂停关键词、限速、活跃度闸门等内部分支，而不需要等 `MIN_TICK_DELAY_MS` 的
 * 真实定时器（每秒只能跑 1 步，CI 跑会非常慢）。
 *
 * 不会自动 schedule 下一 tick；调用方需要自行 stop 或继续手动调用。
 */
export async function _runOneTickForTests(): Promise<void> {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  await tick()
  // 阻止 finally 里 schedule 出来的 timer 干扰后续断言。
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
}

/**
 * 测试用：直接跑一次 sendOne，绕过 picker / 活跃度闸门 / 限速。
 * 用于稳定测试切片分段发送的逻辑（segment loop / recent dedup / daily
 * counter / 错误中断 / 异常捕获），不需要构造能稳定命中 picker 的 fixture。
 */
export async function _sendOneForTests(roomId: number, meme: LaplaceMemeWithSource): Promise<void> {
  await sendOne(roomId, meme)
}
