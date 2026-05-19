/**
 * 粉丝牌禁言巡检的共享状态层。
 *
 * 历史背景:这些 signal 原本是 `src/components/settings/medal-check-section.tsx`
 * 里的私有 `const`,只被设置面板那一个 section 读写。Jobs 式审计 #8 决定把
 * 粉丝牌巡检升级为主面板独立的"我的状态"section ——重度直播观众会被主播拉黑,
 * 需要每天瞄一眼自己在哪些房间被禁了,这是 self-defense 信息,不是设置项。
 *
 * 把状态搬到 lib 层后,两个消费者读同一份数据:
 *  - `src/components/medal-status-panel.tsx`(新增主面板 section,只读 + 跳转)
 *  - `src/components/settings/medal-check-section.tsx`(原设置详细页,负责发起
 *    巡检 + 配置 Guard Room 同步 + 显示完整列表)
 *
 * 状态按账号(DedeUserID)分槽:用户切账号后看到的就是该账号的缓存,而不是
 * 另一账号的旧数据。这个设计在原文件就有,保留。
 */

import { GM_deleteValue, GM_getValue } from '$'
import { getDedeUid, type MedalRestrictionCheck } from './api'
import { gmSignal } from './gm-signal'

/** Filter mode for the detailed list in the settings section. */
export type MedalCheckFilter = 'issues' | 'restricted' | 'unknown' | 'deactivated' | 'ok' | 'all'

/**
 * 状态文本(显示在巡检面板的"上次状态"行)。空 = "尚未巡检"。
 * Key = DedeUserID(string),value = 自由文本。
 */
export const medalCheckStatusByUid = gmSignal<Record<string, string>>('medalCheckStatusByUid', {})

/** 巡检完整结果按账号 UID 分槽缓存。 */
export const medalCheckResultsByUid = gmSignal<Record<string, MedalRestrictionCheck[]>>('medalCheckResultsByUid', {})

/** 用户在设置详细页选择的 filter mode 按账号 UID 分槽。 */
export const medalCheckFilterByUid = gmSignal<Record<string, MedalCheckFilter>>('medalCheckFilterByUid', {})

/**
 * One-time migration: previous versions stored medal-check state as flat
 * globals (medalCheckResults, medalCheckStatus, medalCheckFilter) that were
 * not bound to any account. Move whatever is there into the slot for the
 * account that's currently logged in, so users keep their last results
 * instead of seeing them silently apply to a different account.
 *
 * IIFE intentional: runs once on module load, idempotent (deletes legacy
 * keys after migrating). Tests can re-trigger by dropping the module from
 * require.cache and re-importing.
 */
;(() => {
  const uid = getDedeUid()
  if (!uid) return
  const legacyResults = GM_getValue<MedalRestrictionCheck[] | undefined>('medalCheckResults')
  const legacyStatus = GM_getValue<string | undefined>('medalCheckStatus')
  const legacyFilter = GM_getValue<MedalCheckFilter | undefined>('medalCheckFilter')
  let migrated = false
  if (Array.isArray(legacyResults) && legacyResults.length > 0 && !medalCheckResultsByUid.value[uid]) {
    medalCheckResultsByUid.value = { ...medalCheckResultsByUid.value, [uid]: legacyResults }
    migrated = true
  }
  if (typeof legacyStatus === 'string' && legacyStatus && !medalCheckStatusByUid.value[uid]) {
    medalCheckStatusByUid.value = { ...medalCheckStatusByUid.value, [uid]: legacyStatus }
    migrated = true
  }
  if (typeof legacyFilter === 'string' && !medalCheckFilterByUid.value[uid]) {
    medalCheckFilterByUid.value = { ...medalCheckFilterByUid.value, [uid]: legacyFilter }
    migrated = true
  }
  if (migrated) {
    try {
      GM_deleteValue('medalCheckResults')
    } catch {
      // best-effort cleanup; legacy keys may already be gone
    }
    try {
      GM_deleteValue('medalCheckStatus')
    } catch {
      // best-effort cleanup; legacy keys may already be gone
    }
    try {
      GM_deleteValue('medalCheckFilter')
    } catch {
      // best-effort cleanup; legacy keys may already be gone
    }
  }
})()

// ---------------------------------------------------------------------------
// Pure helpers (no signals, no side effects) — shared by both UI consumers.
// ---------------------------------------------------------------------------

/**
 * Count results by status category. Used by status-line text + filter chip
 * labels in both the settings section and the main-panel compact view.
 */
export function getMedalCheckCounts(results: MedalRestrictionCheck[]): {
  restricted: number
  deactivated: number
  unknown: number
  ok: number
} {
  return {
    restricted: results.filter(r => r.status === 'restricted').length,
    deactivated: results.filter(r => r.status === 'deactivated').length,
    unknown: results.filter(r => r.status === 'unknown').length,
    ok: results.filter(r => r.status === 'ok').length,
  }
}

/** Sort results so the worst (restricted) shows first. Stable on anchor name. */
export function sortMedalResults(results: MedalRestrictionCheck[]): MedalRestrictionCheck[] {
  const rank = { restricted: 0, unknown: 1, deactivated: 2, ok: 3 } satisfies Record<
    MedalRestrictionCheck['status'],
    number
  >
  return [...results].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.room.anchorName.localeCompare(b.room.anchorName)
  )
}

/** Chinese label for each status — used in headings, chips, copy-to-clipboard text. */
export function medalStatusTitle(status: MedalRestrictionCheck['status']): string {
  if (status === 'restricted') return '发现限制'
  if (status === 'unknown') return '无法确认'
  if (status === 'deactivated') return '主播已注销'
  return '未发现限制'
}

/** CSS color var/string for each status — used in chips and detail blocks. */
export function medalStatusColor(status: MedalRestrictionCheck['status']): string {
  if (status === 'restricted') return 'var(--cb-warning-text)'
  if (status === 'unknown') return '#666'
  if (status === 'deactivated') return '#8e8e93'
  return 'var(--cb-success-text)'
}

/** Apply filter mode to a sorted result list. 'issues' = restricted+unknown+deactivated. */
export function getFilteredMedalResults(
  results: MedalRestrictionCheck[],
  filter: MedalCheckFilter
): MedalRestrictionCheck[] {
  const sorted = sortMedalResults(results)
  if (filter === 'all') return sorted
  if (filter === 'issues') return sorted.filter(r => r.status !== 'ok')
  return sorted.filter(r => r.status === filter)
}

/**
 * 把最近一次巡检的 timestamp + 总房间数渲染成一句人话,主面板"我的状态"
 * section 底部用。返回:
 *   - "刚刚巡检了 N 个房间"        (< 1 分钟)
 *   - "X 分钟前巡检了 N 个房间"   (< 60 分钟)
 *   - "X 小时前巡检了 N 个房间"   (< 24 小时)
 *   - "昨天巡检了 N 个房间"        (exactly 1 天)
 *   - "X 天前巡检了 N 个房间"     (>= 2 天)
 *   - "共 N 个房间"               (latestCheckedAt 不可用 / falsy)
 *   - ""                          (空 list)
 *
 * `now` 显式传入便于测试,跟 medal-check-state 的其它 helper 一样保持纯函数。
 */
export function formatMedalCheckSummaryLine(latestCheckedAt: number, totalRooms: number, now: number): string {
  if (totalRooms === 0) return ''
  if (!latestCheckedAt) return `共 ${totalRooms} 个房间`
  const ageMs = now - latestCheckedAt
  const ageMin = Math.floor(ageMs / 60_000)
  const ageHr = Math.floor(ageMin / 60)
  const ageDay = Math.floor(ageHr / 24)
  let when: string
  if (ageMin < 1) when = '刚刚'
  else if (ageMin < 60) when = `${ageMin} 分钟前`
  else if (ageHr < 24) when = `${ageHr} 小时前`
  else if (ageDay === 1) when = '昨天'
  else when = `${ageDay} 天前`
  return `${when}巡检了 ${totalRooms} 个房间`
}

/**
 * 主面板"我的状态"section 只回答一个问题:"我在哪些房间被限制?"
 * 这个 helper 把全部 results 收窄到 restricted-only,并按主播名排序保证稳定。
 * 其他状态(unknown / deactivated / ok)留给设置页详细巡检报告。
 */
export function getRestrictedRooms(results: MedalRestrictionCheck[]): MedalRestrictionCheck[] {
  return results
    .filter(r => r.status === 'restricted')
    .sort((a, b) => a.room.anchorName.localeCompare(b.room.anchorName))
}

/** Short label for filter mode — used in detail-page chips and copy report header. */
export function medalFilterLabel(filter: MedalCheckFilter): string {
  if (filter === 'issues') return '异常'
  if (filter === 'restricted') return '限制'
  if (filter === 'unknown') return '未知'
  if (filter === 'deactivated') return '主播注销'
  if (filter === 'ok') return '正常'
  return '全部'
}
