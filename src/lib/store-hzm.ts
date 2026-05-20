/**
 * 智能辅助驾驶（hzm-auto-drive）相关持久状态。
 *
 * - 全局：模式、dryRun、间隔、限速、暂停关键词、LLM 配置（key/model/...）
 * - 按房间：勾选 tag、黑名单 tag、最近发送、每日统计
 *
 * "按房间"用 `Record<string, ...>` 而非 Map，因为 gmSignal 序列化用 JSON。
 * 房间号统一以字符串作为 key（与 store-meme.ts 等已有模块一致）。
 */

import { signal } from '@preact/signals'

import { GM_getValue, GM_setValue } from '$'
import { gmSignal } from './gm-signal'

// 兼容老 import 路径：API 凭证已搬到 store-llm.ts，但有测试 / 上下游代码仍按
// `hzmLlm*` 名字 import。提供 deprecated 别名，避免破坏外部消费方。新代码请
// 直接 import 自 ./store-llm。
export {
  clearLlmApiKey as clearHzmLlmApiKey,
  llmApiKey as hzmLlmApiKey,
  llmApiKeyPersist as hzmLlmApiKeyPersist,
  llmBaseURL as hzmLlmBaseURL,
  llmModel as hzmLlmModel,
  llmProvider as hzmLlmProvider,
} from './store-llm'

// ---------------------------------------------------------------------------
// 全局
// ---------------------------------------------------------------------------

export type HzmDriveMode = 'heuristic' | 'llm'

const VALID_MODES: HzmDriveMode[] = ['heuristic', 'llm']
const isValidMode = (v: unknown): v is HzmDriveMode => typeof v === 'string' && (VALID_MODES as string[]).includes(v)

/**
 * One-shot migration: legacy `hzmDriveMode='off'` is split into `mode='heuristic' + enabled=false`.
 * The new gmSignal below validates strictly, so we must scrub the persisted value first.
 *
 * Exported (with injectable get/set) so it's testable without relying on module-import order
 * or bun's '$' mock — both of which are flaky when multiple test files share a process.
 */
export const HZM_DRIVE_MODE_MIGRATION_KEY = 'hzmDriveModeOffSplitMigrated'
export function migrateLegacyHzmDriveMode(io: {
  get: <T>(key: string, defaultValue: T) => T
  set: (key: string, value: unknown) => void
}): void {
  if (io.get(HZM_DRIVE_MODE_MIGRATION_KEY, false)) return
  if (io.get('hzmDriveMode', 'heuristic') === 'off') io.set('hzmDriveMode', 'heuristic')
  io.set(HZM_DRIVE_MODE_MIGRATION_KEY, true)
}
migrateLegacyHzmDriveMode({ get: GM_getValue, set: GM_setValue })

/**
 * 智驾模式：
 * - heuristic：纯启发式（弹幕关键词 → tag → 随机选条）
 * - llm：每 N 次 tick 用 LLM 选条（其它 tick 仍走启发式）
 *
 * 此 signal 仅表示"模式偏好"。开关由 `hzmDriveEnabled` 控制。
 */
export const hzmDriveMode = gmSignal<HzmDriveMode>('hzmDriveMode', 'heuristic', { validate: isValidMode })

/**
 * 是否开车（运行时状态）。
 * 用 signal（非 gmSignal），刷新后默认 false——避免离开页面后仍在自动发送。
 * 与 `autoBlendEnabled` 的策略一致。
 */
export const hzmDriveEnabled = signal(false)

/** 状态文本（运行时 signal，由 hzm-auto-drive.ts 更新）。 */
export const hzmDriveStatusText = signal('已关闭')

/** 面板展开状态（持久化）。默认收起，与自动跟车一致。 */
export const hzmPanelOpen = gmSignal('hzmPanelOpen', false)

/** 用户已确认过"非试运行直接开车会真发弹幕"提醒。 */
export const hasConfirmedHzmRealFire = gmSignal('hasConfirmedHzmRealFire', false)

/**
 * 试运行：选了梗但不真发，只 appendLog。
 * 默认 true，避免新用户开机就开始往别人房间发。
 *
 * @deprecated — 新代码用 `hzmDriveSendMode`。这里保留是为了一次性迁移老用户的
 * 持久化偏好(下面的 `migrateHzmDryRunToSendMode` 在模块加载时读一次老 key,把
 * 它折算成 'dry' / 'live' 写入新 key,之后这个 signal 不再被 UI/runtime 读)。
 */
export const hzmDryRun = gmSignal<boolean>('hzmDryRun', true)

/**
 * 智驾发送模式(三态,替代老的 dry/non-dry 二态):
 *  - `dry` — 试运行,只 appendLog,不发,也不进候选队列
 *  - `candidate` — 选了梗 push 到 AI 陪聊 review 队列,等用户点确认才发(推荐档)
 *  - `live` — 现行"直接发"(保留首次开启的 `hasConfirmedHzmRealFire` 二次确认)
 *
 * 默认 `dry` —— 和老 `hzmDryRun=true` 行为一致,首次进入产品不会真发。
 */
export type HzmDriveSendMode = 'dry' | 'candidate' | 'live'
const VALID_SEND_MODES: HzmDriveSendMode[] = ['dry', 'candidate', 'live']
const isValidSendMode = (v: unknown): v is HzmDriveSendMode =>
  typeof v === 'string' && (VALID_SEND_MODES as string[]).includes(v)
export const hzmDriveSendMode = gmSignal<HzmDriveSendMode>('hzmDriveSendMode', 'dry', { validate: isValidSendMode })

/**
 * One-shot migration: 老用户的 `hzmDryRun` 决定 `hzmDriveSendMode` 初始值。
 *  - true  → 'dry'(老用户偏向保守)
 *  - false → 'live'(老用户主动关过 dryRun,延续直发偏好;不强行换到 candidate)
 *
 * 只跑一次(用 marker key 标记完成),之后用户对新 segment 的任何点击都
 * authoritative。Exported with injectable IO 为了测试,模式参考
 * `migrateLegacyHzmDriveMode` 上面的写法。
 */
export const HZM_SEND_MODE_MIGRATION_KEY = 'hzmDryRunToSendModeMigrated'
export function migrateHzmDryRunToSendMode(io: {
  get: <T>(key: string, defaultValue: T) => T
  set: (key: string, value: unknown) => void
}): void {
  if (io.get(HZM_SEND_MODE_MIGRATION_KEY, false)) return
  // 只在用户没显式设过新 key 的情况下迁移,避免回滚后再次启动覆盖新偏好
  const existing = io.get<string | undefined>('hzmDriveSendMode', undefined)
  if (existing === undefined) {
    const wasDryRun = io.get('hzmDryRun', true)
    io.set('hzmDriveSendMode', wasDryRun ? 'dry' : 'live')
  }
  io.set(HZM_SEND_MODE_MIGRATION_KEY, true)
}
migrateHzmDryRunToSendMode({ get: GM_getValue, set: GM_setValue })

/** Tick 基础间隔（秒），加 0.7×–1.5× jitter。默认 8s。 */
export const hzmDriveIntervalSec = gmSignal<number>('hzmDriveIntervalSec', 8)

/** 每分钟最多发送条数。默认 6（与参考插件一致）。 */
export const hzmRateLimitPerMin = gmSignal<number>('hzmRateLimitPerMin', 6)

/** LLM 调用频率（每 N tick 一次）。1 = 每次都调；3 = 每 3 次调一次（其余走启发式）。 */
export const hzmLlmRatio = gmSignal<number>('hzmLlmRatio', 3)

// ---------------------------------------------------------------------------
// 活跃度闸门（heuristic + llm 共享）
// ---------------------------------------------------------------------------
//
// 旧版本只要 tick 触发就一定选梗发送，导致冷清房间也照刷不误。新版本在
// tick 头部加一道闸门：最近 windowSec 内必须既有 ≥minDanmu 条公屏，又有
// ≥minDistinctUsers 个不同 uid。一人独刷不算活，避免被刷屏诱发误触。

/** 活跃度统计窗口（秒）。默认 45s——比较激进，中小房也能响应。 */
export const hzmActivityWindowSec = gmSignal<number>('hzmActivityWindowSec', 45)

/** 窗口内至少 N 条公屏弹幕才算"活"。 */
export const hzmActivityMinDanmu = gmSignal<number>('hzmActivityMinDanmu', 3)

/** 窗口内至少 N 个不同 uid——防止一个人狂刷被当作活跃。 */
export const hzmActivityMinDistinctUsers = gmSignal<number>('hzmActivityMinDistinctUsers', 2)

/**
 * 启发式选梗严格模式。
 * - true（默认）：trending / keywordToTag / selectedTags 都没命中时**本 tick 不发**，
 *   不再随机兜底。配合活跃度闸门解决"空屏也刷"。
 * - false：保留旧行为——以上都没中就从全候选池随机选一条。
 */
export const hzmStrictHeuristic = gmSignal<boolean>('hzmStrictHeuristic', true)

/**
 * 暂停关键词（每行一条），匹配时 60s 内不发智驾弹幕。
 * 默认从内置梗源的 pauseKeywords 起步，但用户可在 UI 编辑覆盖。
 * 空字符串 = 用所在房间梗源里的默认值。
 */
export const hzmPauseKeywordsOverride = gmSignal<string>('hzmPauseKeywordsOverride', '')

// ---------------------------------------------------------------------------
// 按房间
// ---------------------------------------------------------------------------

const isRecordOfStringArrays = (v: unknown): v is Record<string, string[]> =>
  typeof v === 'object' &&
  v !== null &&
  Object.values(v as Record<string, unknown>).every(arr => Array.isArray(arr) && arr.every(s => typeof s === 'string'))

/** roomId(string) → 当前直播间用户勾选的 tag 列表（智驾选梗时只看这些 tag）。 */
export const hzmSelectedTagsByRoom = gmSignal<Record<string, string[]>>(
  'hzmSelectedTagsByRoom',
  {},
  {
    validate: isRecordOfStringArrays,
  }
)

/** roomId(string) → 黑名单 tag（命中即跳过）。 */
export const hzmBlacklistTagsByRoom = gmSignal<Record<string, string[]>>(
  'hzmBlacklistTagsByRoom',
  {},
  {
    validate: isRecordOfStringArrays,
  }
)

/** roomId(string) → 最近发送的 N 条梗 content（去重避免连发同条）。 */
export const hzmRecentSentByRoom = gmSignal<Record<string, string[]>>(
  'hzmRecentSentByRoom',
  {},
  {
    validate: isRecordOfStringArrays,
  }
)

export interface HzmDailyStats {
  /** YYYY-MM-DD（本地时区）。 */
  date: string
  /** 今日已发送条数（不含 dryRun）。 */
  sent: number
  /** 今日 LLM 调用次数。 */
  llmCalls: number
}

const isDailyStats = (v: unknown): v is HzmDailyStats =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as HzmDailyStats).date === 'string' &&
  typeof (v as HzmDailyStats).sent === 'number' &&
  typeof (v as HzmDailyStats).llmCalls === 'number'

const isRecordOfDailyStats = (v: unknown): v is Record<string, HzmDailyStats> =>
  typeof v === 'object' && v !== null && Object.values(v as Record<string, unknown>).every(isDailyStats)

/** roomId(string) → 当日发送/LLM 计数。每天换日期自动重置。 */
export const hzmDailyStatsByRoom = gmSignal<Record<string, HzmDailyStats>>(
  'hzmDailyStatsByRoom',
  {},
  {
    validate: isRecordOfDailyStats,
  }
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 按房间号取勾选 tag（只读）。 */
export function getSelectedTags(roomId: number | null): string[] {
  if (roomId == null) return []
  return hzmSelectedTagsByRoom.value[String(roomId)] ?? []
}

/** 按房间号写勾选 tag（替换）。 */
export function setSelectedTags(roomId: number, tags: string[]): void {
  hzmSelectedTagsByRoom.value = {
    ...hzmSelectedTagsByRoom.value,
    [String(roomId)]: tags,
  }
}

/** 按房间号取黑名单 tag。 */
export function getBlacklistTags(roomId: number | null): string[] {
  if (roomId == null) return []
  return hzmBlacklistTagsByRoom.value[String(roomId)] ?? []
}

/** 按房间号写黑名单 tag。 */
export function setBlacklistTags(roomId: number, tags: string[]): void {
  hzmBlacklistTagsByRoom.value = {
    ...hzmBlacklistTagsByRoom.value,
    [String(roomId)]: tags,
  }
}

/** 取最近 N 条已发送（roomId 维度）。 */
export function getRecentSent(roomId: number | null): string[] {
  if (roomId == null) return []
  return hzmRecentSentByRoom.value[String(roomId)] ?? []
}

/** 推一条到最近已发送，限制最近 5 条。 */
export function pushRecentSent(roomId: number, content: string, max = 5): void {
  const key = String(roomId)
  const cur = hzmRecentSentByRoom.value[key] ?? []
  const next = [...cur.filter(c => c !== content), content]
  hzmRecentSentByRoom.value = {
    ...hzmRecentSentByRoom.value,
    [key]: next.length > max ? next.slice(-max) : next,
  }
}

function todayLocal(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 取当日统计（自动按日期重置）。 */
export function getDailyStats(roomId: number | null): HzmDailyStats {
  const today = todayLocal()
  if (roomId == null) return { date: today, sent: 0, llmCalls: 0 }
  const key = String(roomId)
  const cur = hzmDailyStatsByRoom.value[key]
  if (!cur || cur.date !== today) {
    return { date: today, sent: 0, llmCalls: 0 }
  }
  return cur
}

/** 累加当日发送计数。 */
export function bumpDailySent(roomId: number, delta = 1): void {
  const today = todayLocal()
  const key = String(roomId)
  const cur = hzmDailyStatsByRoom.value[key]
  const next: HzmDailyStats =
    !cur || cur.date !== today ? { date: today, sent: delta, llmCalls: 0 } : { ...cur, sent: cur.sent + delta }
  hzmDailyStatsByRoom.value = { ...hzmDailyStatsByRoom.value, [key]: next }
}

/** 累加当日 LLM 调用计数。 */
export function bumpDailyLlmCalls(roomId: number, delta = 1): void {
  const today = todayLocal()
  const key = String(roomId)
  const cur = hzmDailyStatsByRoom.value[key]
  const next: HzmDailyStats =
    !cur || cur.date !== today ? { date: today, sent: 0, llmCalls: delta } : { ...cur, llmCalls: cur.llmCalls + delta }
  hzmDailyStatsByRoom.value = { ...hzmDailyStatsByRoom.value, [key]: next }
}
