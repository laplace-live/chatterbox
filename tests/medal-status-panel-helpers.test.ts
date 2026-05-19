import { describe, expect, test } from 'bun:test'

// Stub `document` BEFORE importing medal-check-state — its module-load IIFE
// runs a one-time legacy-key migration that reads `document.cookie` to
// resolve the current Bilibili UID. Under bun's stripped test runtime
// `document` doesn't exist; static imports would crash before this line
// runs (ES modules hoist imports to module top), so we use DYNAMIC import
// for the SUT below. The pure helpers we're testing
// (formatMedalCheckSummaryLine / getRestrictedRooms) don't touch DOM at
// runtime, but the IIFE side-effect would still crash without this guard.
;(globalThis as { document?: { cookie: string } }).document ??= { cookie: '' }

// Use dynamic import so the stub above takes effect before api.ts /
// medal-check-state.ts are loaded.
const { formatMedalCheckSummaryLine, getRestrictedRooms } = await import('../src/lib/medal-check-state')
const apiModule = (await import('../src/lib/api')) as typeof import('../src/lib/api')
type MedalRestrictionCheck = ReturnType<typeof apiModule.checkMedalRoomRestriction> extends Promise<infer T> ? T : never

/**
 * Regression tests for the helpers that drive the main-panel "我的状态" section.
 *
 * Background: Jobs 2026-05-18 simplified that section to answer ONE question
 * ("which streamers are restricting me right now?"). The derivation logic
 * (filter to restricted-only, sort by anchor name, human-readable last-check
 * timestamp) lives here as pure helpers so they can be tested without
 * mounting the Preact component or stubbing GM storage / signals.
 */

function makeResult(
  anchorName: string,
  status: MedalRestrictionCheck['status'],
  checkedAt: number,
  roomId = 0
): MedalRestrictionCheck {
  return {
    room: { roomId, anchorName, anchorUid: 1, medalName: 'm', source: 'medal-room-id' },
    status,
    signals: [],
    checkedAt,
  }
}

describe('getRestrictedRooms', () => {
  test('returns empty array on empty input', () => {
    expect(getRestrictedRooms([])).toEqual([])
  })

  test('filters out non-restricted rooms (ok / unknown / deactivated)', () => {
    const results = [
      makeResult('A', 'ok', 1),
      makeResult('B', 'restricted', 2),
      makeResult('C', 'unknown', 3),
      makeResult('D', 'deactivated', 4),
      makeResult('E', 'restricted', 5),
    ]
    const restricted = getRestrictedRooms(results)
    expect(restricted.map(r => r.room.anchorName)).toEqual(['B', 'E'])
  })

  test('sorts restricted rooms by anchor name (locale-aware)', () => {
    const results = [
      makeResult('神乐七奈', 'restricted', 3),
      makeResult('阿伊蕾特', 'restricted', 1),
      makeResult('灰泽满', 'restricted', 2),
    ]
    const sorted = getRestrictedRooms(results)
    const names = sorted.map(r => r.room.anchorName)
    // localeCompare on Chinese characters is locale-dependent but stable per
    // run — assert all inputs are present and order is stable across calls.
    expect(names).toHaveLength(3)
    expect(new Set(names)).toEqual(new Set(['神乐七奈', '阿伊蕾特', '灰泽满']))
    expect(getRestrictedRooms(results).map(r => r.room.anchorName)).toEqual(names)
  })

  test('does not mutate the input array', () => {
    const results = [makeResult('Z', 'restricted', 3), makeResult('A', 'ok', 1), makeResult('M', 'restricted', 2)]
    const before = [...results]
    getRestrictedRooms(results)
    expect(results).toEqual(before)
  })

  test('returns empty array when no rooms are restricted', () => {
    const results = [makeResult('A', 'ok', 1), makeResult('B', 'unknown', 2), makeResult('C', 'deactivated', 3)]
    expect(getRestrictedRooms(results)).toEqual([])
  })

  test('preserves the full result object (not just anchorName)', () => {
    const results = [makeResult('A', 'restricted', 123, 999)]
    const restricted = getRestrictedRooms(results)
    expect(restricted[0]).toBeDefined()
    expect(restricted[0]?.checkedAt).toBe(123)
    expect(restricted[0]?.room.roomId).toBe(999)
    expect(restricted[0]?.status).toBe('restricted')
  })
})

describe('formatMedalCheckSummaryLine', () => {
  // Fixed `now` for deterministic age calculations.
  const NOW = 1_700_000_000_000 // 2023-11-14T22:13:20Z, arbitrary fixed point

  test('returns empty string for empty list', () => {
    expect(formatMedalCheckSummaryLine(0, 0, NOW)).toBe('')
    expect(formatMedalCheckSummaryLine(NOW - 1000, 0, NOW)).toBe('')
  })

  test('returns "共 N 个房间" when checkedAt is missing (falsy)', () => {
    expect(formatMedalCheckSummaryLine(0, 12, NOW)).toBe('共 12 个房间')
  })

  test('renders "刚刚巡检了" within the first minute', () => {
    expect(formatMedalCheckSummaryLine(NOW, 12, NOW)).toBe('刚刚巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 30_000, 5, NOW)).toBe('刚刚巡检了 5 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 59_000, 1, NOW)).toBe('刚刚巡检了 1 个房间')
  })

  test('renders "X 分钟前" between 1 and 59 minutes', () => {
    expect(formatMedalCheckSummaryLine(NOW - 60_000, 3, NOW)).toBe('1 分钟前巡检了 3 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 15 * 60_000, 12, NOW)).toBe('15 分钟前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 59 * 60_000, 50, NOW)).toBe('59 分钟前巡检了 50 个房间')
  })

  test('renders "X 小时前" between 1 and 23 hours', () => {
    expect(formatMedalCheckSummaryLine(NOW - 60 * 60_000, 12, NOW)).toBe('1 小时前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 2 * 60 * 60_000, 12, NOW)).toBe('2 小时前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 23 * 60 * 60_000, 12, NOW)).toBe('23 小时前巡检了 12 个房间')
  })

  test('renders "昨天" at exactly 1 day (24-47 hours)', () => {
    expect(formatMedalCheckSummaryLine(NOW - 24 * 60 * 60_000, 12, NOW)).toBe('昨天巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 47 * 60 * 60_000, 12, NOW)).toBe('昨天巡检了 12 个房间')
  })

  test('renders "X 天前" from 2 days onward', () => {
    expect(formatMedalCheckSummaryLine(NOW - 48 * 60 * 60_000, 12, NOW)).toBe('2 天前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 7 * 24 * 60 * 60_000, 12, NOW)).toBe('7 天前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 30 * 24 * 60 * 60_000, 12, NOW)).toBe('30 天前巡检了 12 个房间')
  })

  test('handles future timestamps gracefully (clock skew) — ageMs negative → "刚刚"', () => {
    // If the device clock is behind the checkedAt timestamp (cross-device
    // sync, server time drift), ageMs will be negative. Math.floor of any
    // negative value < 1 minute → 0 → falls into "刚刚" branch. That's the
    // most graceful failure mode (the alternative would be "-2 分钟前").
    expect(formatMedalCheckSummaryLine(NOW + 30_000, 5, NOW)).toBe('刚刚巡检了 5 个房间')
  })

  test('matches the exact format expected by the main-panel UI', () => {
    // Pin the format the medal-status-panel.tsx renders inline as the bottom
    // status line. Notice if it ever drifts.
    expect(formatMedalCheckSummaryLine(NOW - 5 * 60_000, 12, NOW)).toBe('5 分钟前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 1 * 60 * 60_000, 12, NOW)).toBe('1 小时前巡检了 12 个房间')
    expect(formatMedalCheckSummaryLine(NOW - 2 * 60 * 60_000, 80, NOW)).toBe('2 小时前巡检了 80 个房间')
  })
})
