/**
 * State-machine tests for the SC pin strip queue.
 *
 * All tests use deterministic timestamps (no fake-timer libraries) — the
 * state module takes `now` as an explicit parameter, so tests just pass
 * whatever they want. This is the same DI pattern used elsewhere
 * (gm-fetch._setGmXhrForTests, meme-fetch._setMemeFetchDepsForTests).
 */

import { describe, expect, test } from 'bun:test'

import type { CustomChatEvent } from '../src/lib/custom-chat-events'

import {
  AUTO_ROTATE_INTERVAL_MS,
  currentSC,
  dismissCurrent,
  enqueue,
  initialState,
  isAutoRotateEligible,
  jumpTo,
  makeActiveSC,
  next,
  type PinStripState,
  pauseFor,
  prev,
  resume,
  tick,
  toggleStickCurrent,
  USER_INTERACTION_PAUSE_MS,
} from '../src/lib/custom-chat-sc-pinstrip-state'

function mkSC(id: string, amountYuan: number, opts: Partial<CustomChatEvent> = {}): CustomChatEvent {
  return {
    id,
    kind: 'superchat',
    text: `text-${id}`,
    uname: opts.uname ?? `user-${id}`,
    uid: null,
    time: '00:00',
    isReply: false,
    source: 'ws',
    badges: [],
    amount: amountYuan,
    ...opts,
  }
}

describe('initialState', () => {
  test('empty queue, -1 index, not paused', () => {
    const s = initialState()
    expect(s.active).toEqual([])
    expect(s.currentIndex).toBe(-1)
    expect(s.pauseUntil).toBe(0)
    expect(currentSC(s)).toBeNull()
  })
})

describe('makeActiveSC — input validation', () => {
  test('non-superchat returns null', () => {
    expect(makeActiveSC({ ...mkSC('a', 100), kind: 'gift' }, 1000)).toBeNull()
    expect(makeActiveSC({ ...mkSC('a', 100), kind: 'danmaku' }, 1000)).toBeNull()
  })
  test('amount missing / zero / negative returns null', () => {
    expect(makeActiveSC({ ...mkSC('a', 100), amount: undefined }, 1000)).toBeNull()
    expect(makeActiveSC(mkSC('a', 0), 1000)).toBeNull()
    expect(makeActiveSC(mkSC('a', -100), 1000)).toBeNull()
  })
  test('valid SC sets pinnedAt + expiresAt correctly', () => {
    const sc = makeActiveSC(mkSC('a', 100), 1000)!
    expect(sc).not.toBeNull()
    expect(sc.id).toBe('a')
    expect(sc.amountYuan).toBe(100)
    expect(sc.tier.id).toBe('T3')
    expect(sc.pinnedAt).toBe(1000)
    expect(sc.expiresAt).toBe(1000 + 60_000) // T3 = 60s
    expect(sc.stuck).toBe(false)
  })
})

describe('enqueue — basic', () => {
  test('first SC arrives → active=[it], current=0', () => {
    const sc = makeActiveSC(mkSC('a', 100), 1000)!
    const s = enqueue(initialState(), sc, 1000)
    expect(s.active.length).toBe(1)
    expect(s.currentIndex).toBe(0)
    expect(currentSC(s)?.id).toBe('a')
  })
  test('second SC arrives → current advances to it (newest gets attention)', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 200), 2000)!, 2000)
    expect(s.active.length).toBe(2)
    expect(s.currentIndex).toBe(1)
    expect(currentSC(s)?.id).toBe('b')
  })
  test('duplicate id is a no-op (WS + DOM double-emit defense)', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 2000)!, 2000)
    expect(s.active.length).toBe(1)
  })
})

describe('enqueue — user-paused mode keeps visible card put', () => {
  test('SC arrives during user pause → joins queue but current stays', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 1500)!, 1500)
    // User pauses at t=2000 (e.g. swiped left to look at 'a')
    s = prev(s, 2000, true)
    expect(s.currentIndex).toBe(0)
    expect(s.pauseUntil).toBe(2000 + USER_INTERACTION_PAUSE_MS)
    // New SC arrives at t=3000 (still in pause window) — should NOT advance
    s = enqueue(s, makeActiveSC(mkSC('c', 100), 3000)!, 3000)
    expect(s.active.length).toBe(3)
    expect(s.currentIndex).toBe(0) // still on 'a'
  })
})

describe('tick — expiry removes SCs and adjusts currentIndex', () => {
  test('expired SC is removed; currentIndex follows current card by id', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 30), 1000)!, 1000) // expires at 16000
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000) // expires at 62000
    // Currently on 'b' (last enqueued). Tick at t=20000 → 'a' expired but
    // 'b' alive; 'b' still current, but now at index 0.
    s = tick(s, 20_000)
    expect(s.active.length).toBe(1)
    expect(s.active[0].id).toBe('b')
    expect(s.currentIndex).toBe(0)
  })
  test('current SC expires → fall back to same numeric position (clamped)', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000) // expires 61000
    s = enqueue(s, makeActiveSC(mkSC('b', 30), 2000)!, 2000) // expires 17000
    // currentIndex is 1 ('b'). At t=20000 'b' expires; 'a' survives. Current
    // had index 1, clamped to len-1=0, so we end on 'a'.
    s = tick(s, 20_000)
    expect(s.active.length).toBe(1)
    expect(s.active[0].id).toBe('a')
    expect(s.currentIndex).toBe(0)
  })
  test('all SCs expire → currentIndex = -1, active = []', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 30), 1000)!, 1000)
    s = tick(s, 100_000)
    expect(s.active).toEqual([])
    expect(s.currentIndex).toBe(-1)
  })
  test('no-op when nothing expired', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    const sBefore = s
    s = tick(s, 5_000)
    expect(s).toBe(sBefore) // referential equality — same state object
  })
  test('stuck SCs survive past their natural expiry', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 30), 1000)!, 1000) // would expire at 16000
    s = toggleStickCurrent(s)
    s = tick(s, 100_000)
    expect(s.active.length).toBe(1)
    expect(s.active[0].stuck).toBe(true)
  })
})

describe('next/prev — navigation', () => {
  test('next wraps around', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    expect(s.currentIndex).toBe(1) // on 'b'
    s = next(s, 3000, true)
    expect(s.currentIndex).toBe(0) // wrapped to 'a'
    s = next(s, 4000, true)
    expect(s.currentIndex).toBe(1) // back to 'b'
  })
  test('prev wraps around', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = prev(s, 3000, true) // 1 → 0
    expect(s.currentIndex).toBe(0)
    s = prev(s, 4000, true) // 0 → 1 (wrap)
    expect(s.currentIndex).toBe(1)
  })
  test('userInitiated=true sets pauseUntil, false does not', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    const before = s.pauseUntil
    s = next(s, 3000, false) // auto-rotate
    expect(s.pauseUntil).toBe(before)
    s = next(s, 4000, true) // user
    expect(s.pauseUntil).toBe(4000 + USER_INTERACTION_PAUSE_MS)
  })
  test('no-op on empty queue', () => {
    const s = initialState()
    expect(next(s, 1000, true)).toBe(s)
    expect(prev(s, 1000, true)).toBe(s)
  })
})

describe('jumpTo', () => {
  test('valid index moves there + pauses', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = enqueue(s, makeActiveSC(mkSC('c', 100), 3000)!, 3000)
    s = jumpTo(s, 0, 5000)
    expect(s.currentIndex).toBe(0)
    expect(s.pauseUntil).toBe(5000 + USER_INTERACTION_PAUSE_MS)
  })
  test('out-of-range is no-op', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    const before = s
    expect(jumpTo(s, -1, 5000)).toBe(before)
    expect(jumpTo(s, 99, 5000)).toBe(before)
  })
})

describe('pause / resume', () => {
  test('pauseFor sets pauseUntil to now + durationMs', () => {
    const s = pauseFor(initialState(), 1000, 5000)
    expect(s.pauseUntil).toBe(6000)
  })
  test('resume clears pauseUntil', () => {
    let s = pauseFor(initialState(), 1000, 5000)
    s = resume(s)
    expect(s.pauseUntil).toBe(0)
  })
})

describe('dismissCurrent', () => {
  test('removes current SC + advances to neighbor at same numeric position', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = enqueue(s, makeActiveSC(mkSC('c', 100), 3000)!, 3000)
    // current is 'c' (index 2). Dismiss → 'c' removed, fall to clamped(2, len-1=1) = 1 ('b').
    s = dismissCurrent(s, 5000)
    expect(s.active.map(x => x.id)).toEqual(['a', 'b'])
    expect(s.currentIndex).toBe(1)
    expect(currentSC(s)?.id).toBe('b')
  })
  test('dismissing the last SC leaves empty queue with index -1', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = dismissCurrent(s, 5000)
    expect(s.active).toEqual([])
    expect(s.currentIndex).toBe(-1)
  })
  test('dismiss pauses auto-rotate so the next card does not whiplash', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = dismissCurrent(s, 5000)
    expect(s.pauseUntil).toBe(5000 + USER_INTERACTION_PAUSE_MS)
  })
})

describe('isAutoRotateEligible', () => {
  test('false when queue size ≤ 1 (nothing to rotate to)', () => {
    let s = initialState()
    expect(isAutoRotateEligible(s, 1000, 0)).toBe(false)
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    expect(isAutoRotateEligible(s, 5000, 0)).toBe(false)
  })
  test('false when paused', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = pauseFor(s, 5000, 10_000)
    expect(isAutoRotateEligible(s, 6000, 0)).toBe(false)
  })
  test('false within AUTO_ROTATE_INTERVAL_MS of last advance', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    const lastAdvance = 5000
    expect(isAutoRotateEligible(s, lastAdvance + AUTO_ROTATE_INTERVAL_MS - 1, lastAdvance)).toBe(false)
    expect(isAutoRotateEligible(s, lastAdvance + AUTO_ROTATE_INTERVAL_MS, lastAdvance)).toBe(true)
  })
})

describe('toggleStickCurrent', () => {
  test('toggles stuck flag on current card only', () => {
    let s = initialState()
    s = enqueue(s, makeActiveSC(mkSC('a', 100), 1000)!, 1000)
    s = enqueue(s, makeActiveSC(mkSC('b', 100), 2000)!, 2000)
    s = toggleStickCurrent(s) // toggles 'b' (current)
    expect(s.active[0].stuck).toBe(false)
    expect(s.active[1].stuck).toBe(true)
    s = toggleStickCurrent(s) // back off
    expect(s.active[1].stuck).toBe(false)
  })
  test('no-op on empty queue', () => {
    const s = initialState()
    expect(toggleStickCurrent(s)).toBe(s)
  })
})

describe('integration — realistic event flow', () => {
  test('busy room: 5 SCs arrive in 10s, auto-rotate eligible after settle', () => {
    let s = initialState()
    let last = 0
    for (let i = 0; i < 5; i++) {
      const t = 1000 + i * 2000
      s = enqueue(s, makeActiveSC(mkSC(`s${i}`, 100), t)!, t)
      last = t
    }
    expect(s.active.length).toBe(5)
    expect(s.currentIndex).toBe(4) // newest
    // 4 seconds after last enqueue with no user input → auto-rotate fires
    expect(isAutoRotateEligible(s, last + AUTO_ROTATE_INTERVAL_MS, last)).toBe(true)
  })
})
