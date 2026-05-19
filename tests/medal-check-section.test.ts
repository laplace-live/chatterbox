import { describe, expect, mock, test } from 'bun:test'

// Per-UID storage migration for the medal-check section.
//
// The IIFE in medal-check-section.tsx migrates legacy flat GM keys
// (medalCheckResults, medalCheckStatus, medalCheckFilter) into the per-UID
// map under the currently logged-in DedeUserID. Each test uses a fresh
// module store and fresh `mock.module` calls so the IIFE re-runs against
// the mocked GM/cookie state for that test.
//
// Render-time UI behavior (badge text, disabled button) is not unit-tested
// here: this section uses `useEffect` for cookie polling, which requires a
// live render context that the project's lightweight bun:test setup does
// not provide.

type GMStore = Map<string, unknown>

function setupGmMock(store: GMStore) {
  const writes: Array<{ key: string; value: unknown }> = []
  mock.module('$', () => ({
    GM_addStyle: () => {},
    GM_deleteValue: (key: string) => {
      store.delete(key)
    },
    GM_getValue: <T>(key: string, defaultValue: T): T => (store.has(key) ? (store.get(key) as T) : defaultValue),
    GM_info: { script: { version: 'test' } },
    GM_setValue: (key: string, value: unknown) => {
      writes.push({ key, value })
      store.set(key, value)
    },
  }))
  return { writes }
}

function setApiMock(uid: string | undefined) {
  mock.module('../src/lib/api', () => ({
    getDedeUid: () => uid,
    fetchMedalRooms: async () => [],
    checkMedalRoomRestriction: async () => ({
      room: { roomId: 0, anchorName: '', anchorUid: null, medalName: '', source: 'medal-room-id' },
      status: 'ok' as const,
      signals: [],
      checkedAt: 0,
    }),
  }))
}

function loadFreshSection() {
  // Bun's `mock.module` swaps the module record but does not clear cached
  // importers. To re-trigger the IIFE we drop and re-import the section.
  //
  // 2026-05 (Jobs 式 #8): the migration IIFE moved out of medal-check-section
  // into `lib/medal-check-state.ts` when粉丝牌巡检 was promoted to the main
  // panel ("我的状态"). The settings section imports the state module, so
  // dropping both cache entries is necessary to re-trigger the IIFE.
  for (const path of ['../src/lib/medal-check-state', '../src/components/settings/medal-check-section']) {
    const cacheKey = require.resolve(path)
    delete require.cache[cacheKey]
  }
  return import('../src/components/settings/medal-check-section').then(m => m.MedalCheckSection)
}

describe('medal-check-section UID scoping', () => {
  test('migrates legacy flat values into the current UID slot and removes legacy keys', async () => {
    const store: GMStore = new Map()
    const legacyResults = [
      {
        room: { roomId: 1, anchorName: 'a', anchorUid: 1, medalName: 'm', source: 'medal-room-id' as const },
        status: 'ok' as const,
        signals: [],
        checkedAt: 1,
      },
    ]
    store.set('medalCheckResults', legacyResults)
    store.set('medalCheckStatus', '完成：1 个房间')
    store.set('medalCheckFilter', 'all')

    setupGmMock(store)
    setApiMock('12345')
    await loadFreshSection()
    // gmSignal persists writes on a 150 ms debounce.
    await new Promise(r => setTimeout(r, 200))

    expect(store.get('medalCheckResultsByUid')).toEqual({ '12345': legacyResults })
    expect(store.get('medalCheckStatusByUid')).toEqual({ '12345': '完成：1 个房间' })
    expect(store.get('medalCheckFilterByUid')).toEqual({ '12345': 'all' })
    expect(store.has('medalCheckResults')).toBe(false)
    expect(store.has('medalCheckStatus')).toBe(false)
    expect(store.has('medalCheckFilter')).toBe(false)
  })

  test('does not migrate when no UID is logged in', async () => {
    const store: GMStore = new Map()
    store.set('medalCheckResults', [{ note: 'untouched' }])
    store.set('medalCheckStatus', 'old status')

    setupGmMock(store)
    setApiMock(undefined) // skipcq: JS-W1042
    await loadFreshSection()
    await new Promise(r => setTimeout(r, 200))

    expect(store.get('medalCheckResults')).toEqual([{ note: 'untouched' }])
    expect(store.get('medalCheckStatus')).toBe('old status')
    expect(store.has('medalCheckResultsByUid')).toBe(false)
  })

  test('does not overwrite an existing UID slot with legacy data', async () => {
    const store: GMStore = new Map()
    store.set('medalCheckResults', [{ note: 'legacy' }])
    store.set('medalCheckResultsByUid', { '99999': [{ note: 'kept' }] })

    setupGmMock(store)
    setApiMock('99999')
    await loadFreshSection()
    await new Promise(r => setTimeout(r, 200))

    expect(store.get('medalCheckResultsByUid')).toEqual({ '99999': [{ note: 'kept' }] })
  })
})
