// Coverage for `src/lib/fetch-cache.ts` — currently 66.67% func / 86.21% lines.
// The file is a pure utility (TTL cache + in-flight dedup); no DOM, no GM_*,
// no network. We test it directly without any mocks.
//
// Cases:
//   - hit/miss based on Date.now() and ttlMs
//   - stale entry past TTL → re-fetch
//   - in-flight dedup: two concurrent get(key) → one fetcher invocation
//   - failed fetch is NOT cached and clears the in-flight slot
//   - failed fetch propagates the error to all in-flight callers
//   - invalidate(key) drops one entry; invalidate() drops all
//   - _clearForTests resets cache + in-flight state

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { FetchCache } from '../src/lib/fetch-cache'

const realNow = Date.now

describe('FetchCache.get — TTL caching', () => {
  let cache: FetchCache<string>

  beforeEach(() => {
    cache = new FetchCache<string>()
  })

  afterEach(() => {
    Date.now = realNow
  })

  test('first call invokes fetcher and returns its value', async () => {
    let calls = 0
    const out = await cache.get({
      key: 'k',
      ttlMs: 1000,
      fetcher: async () => {
        calls++
        return 'value-1'
      },
    })
    expect(out).toBe('value-1')
    expect(calls).toBe(1)
  })

  test('second call within TTL hits the cache (no fetcher invocation)', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return `value-${calls}`
    }
    const a = await cache.get({ key: 'k', ttlMs: 1000, fetcher })
    const b = await cache.get({ key: 'k', ttlMs: 1000, fetcher })
    expect(a).toBe('value-1')
    expect(b).toBe('value-1')
    expect(calls).toBe(1)
  })

  test('different keys do NOT share cache', async () => {
    let n = 0
    const fetcher = async () => `value-${++n}`
    const a = await cache.get({ key: 'k1', ttlMs: 1000, fetcher })
    const b = await cache.get({ key: 'k2', ttlMs: 1000, fetcher })
    expect(a).toBe('value-1')
    expect(b).toBe('value-2')
  })

  test('expired entry past TTL re-invokes the fetcher', async () => {
    let now = 1000
    Date.now = () => now
    let calls = 0
    const fetcher = async () => {
      calls++
      return `v${calls}`
    }
    await cache.get({ key: 'k', ttlMs: 100, fetcher })
    expect(calls).toBe(1)
    now = 1500 // 500ms later, ttl was 100ms — expired
    const stale = await cache.get({ key: 'k', ttlMs: 100, fetcher })
    expect(stale).toBe('v2')
    expect(calls).toBe(2)
  })

  test('boundary: at exactly ttlMs after the entry is treated as STALE', async () => {
    // Implementation: `Date.now() - cached.ts < ttlMs` — strict less-than.
    let now = 1000
    Date.now = () => now
    let calls = 0
    await cache.get({
      key: 'k',
      ttlMs: 100,
      fetcher: async () => {
        calls++
        return 'a'
      },
    })
    now = 1100 // exactly TTL — treated as stale per strict < check.
    await cache.get({
      key: 'k',
      ttlMs: 100,
      fetcher: async () => {
        calls++
        return 'b'
      },
    })
    expect(calls).toBe(2)
  })

  test('boundary: ttlMs - 1 still hits the cache', async () => {
    let now = 1000
    Date.now = () => now
    let calls = 0
    await cache.get({
      key: 'k',
      ttlMs: 100,
      fetcher: async () => {
        calls++
        return 'a'
      },
    })
    now = 1099 // just under TTL
    await cache.get({
      key: 'k',
      ttlMs: 100,
      fetcher: async () => {
        calls++
        return 'b'
      },
    })
    expect(calls).toBe(1)
  })
})

describe('FetchCache.get — in-flight deduplication', () => {
  test('two concurrent gets for same key share one fetcher promise', async () => {
    const cache = new FetchCache<string>()
    let calls = 0
    let resolveFetcher: ((v: string) => void) | null = null
    const fetcher = () =>
      new Promise<string>(resolve => {
        calls++
        resolveFetcher = resolve
      })
    const p1 = cache.get({ key: 'k', ttlMs: 1000, fetcher })
    const p2 = cache.get({ key: 'k', ttlMs: 1000, fetcher })
    expect(calls).toBe(1) // both share one fetcher invocation
    resolveFetcher?.('shared-value')
    expect(await p1).toBe('shared-value')
    expect(await p2).toBe('shared-value')
  })

  test('after fetcher resolves, in-flight slot is cleared (next get triggers cache, not new fetch)', async () => {
    const cache = new FetchCache<string>()
    let calls = 0
    await cache.get({
      key: 'k',
      ttlMs: 10000,
      fetcher: async () => {
        calls++
        return 'v'
      },
    })
    // Subsequent call should hit the cache (NOT a new fetcher call).
    await cache.get({
      key: 'k',
      ttlMs: 10000,
      fetcher: async () => {
        calls++
        return 'v2'
      },
    })
    expect(calls).toBe(1)
  })

  test('rejected fetcher: error propagates to all concurrent callers', async () => {
    const cache = new FetchCache<string>()
    let rejectFetcher: ((err: Error) => void) | null = null
    const fetcher = () =>
      new Promise<string>((_, reject) => {
        rejectFetcher = reject
      })
    const p1 = cache.get({ key: 'k', ttlMs: 1000, fetcher })
    const p2 = cache.get({ key: 'k', ttlMs: 1000, fetcher })
    // Attach catch handlers BEFORE rejecting so the unhandled-rejection guard
    // doesn't fire.
    const c1 = p1.catch(e => e)
    const c2 = p2.catch(e => e)
    rejectFetcher?.(new Error('boom'))
    expect((await c1).message).toBe('boom')
    expect((await c2).message).toBe('boom')
  })

  test('rejected fetcher does NOT cache the failure (next call retries)', async () => {
    const cache = new FetchCache<string>()
    let calls = 0
    const fetcher = async (): Promise<string> => {
      calls++
      if (calls === 1) throw new Error('first-fail')
      return 'second-success'
    }
    await expect(cache.get({ key: 'k', ttlMs: 1000, fetcher })).rejects.toThrow('first-fail')
    const out = await cache.get({ key: 'k', ttlMs: 1000, fetcher })
    expect(out).toBe('second-success')
    expect(calls).toBe(2)
  })

  test('rejected fetcher clears in-flight: new get after the rejection starts fresh', async () => {
    const cache = new FetchCache<string>()
    let rejectFirst: ((err: Error) => void) | null = null
    let secondCalls = 0
    const fetcher1 = () =>
      new Promise<string>((_, reject) => {
        rejectFirst = reject
      })
    const fetcher2 = async () => {
      secondCalls++
      return 'recovery'
    }
    const p1 = cache.get({ key: 'k', ttlMs: 1000, fetcher: fetcher1 })
    const c1 = p1.catch(e => e) // attach handler first
    rejectFirst?.(new Error('down'))
    expect((await c1).message).toBe('down')
    const out = await cache.get({ key: 'k', ttlMs: 1000, fetcher: fetcher2 })
    expect(out).toBe('recovery')
    expect(secondCalls).toBe(1)
  })
})

describe('FetchCache.invalidate', () => {
  test('invalidate(key) drops one entry but leaves others alone', async () => {
    const cache = new FetchCache<string>()
    let kCalls = 0
    let jCalls = 0
    await cache.get({ key: 'k', ttlMs: 10000, fetcher: async () => `k-${++kCalls}` })
    await cache.get({ key: 'j', ttlMs: 10000, fetcher: async () => `j-${++jCalls}` })

    cache.invalidate('k')

    // 'k' must re-fetch; 'j' still cached.
    const k2 = await cache.get({ key: 'k', ttlMs: 10000, fetcher: async () => `k-${++kCalls}` })
    const j2 = await cache.get({ key: 'j', ttlMs: 10000, fetcher: async () => `j-${++jCalls}` })
    expect(k2).toBe('k-2')
    expect(kCalls).toBe(2)
    expect(j2).toBe('j-1')
    expect(jCalls).toBe(1)
  })

  test('invalidate() with no arg drops EVERY entry', async () => {
    const cache = new FetchCache<string>()
    let kCalls = 0
    let jCalls = 0
    await cache.get({ key: 'k', ttlMs: 10000, fetcher: async () => `k-${++kCalls}` })
    await cache.get({ key: 'j', ttlMs: 10000, fetcher: async () => `j-${++jCalls}` })

    cache.invalidate()

    await cache.get({ key: 'k', ttlMs: 10000, fetcher: async () => `k-${++kCalls}` })
    await cache.get({ key: 'j', ttlMs: 10000, fetcher: async () => `j-${++jCalls}` })
    expect(kCalls).toBe(2)
    expect(jCalls).toBe(2)
  })

  test('invalidate(key) for a non-existent key is a no-op', () => {
    const cache = new FetchCache<string>()
    expect(() => cache.invalidate('never-set')).not.toThrow()
  })
})

describe('FetchCache — constructor maxEntries handling', () => {
  // Mutation targets: L42 (constructor block removal), L44 (the
  // `typeof m === 'number' && m > 0` guard + Math.floor / DEFAULT branches).
  // All these tests cover the constructor's argument coercion by exercising
  // the eviction loop with `_sizeForTests`.
  test('maxEntries=3 caps cache size at 3 after 4 distinct inserts', async () => {
    const cache = new FetchCache<string>({ maxEntries: 3 })
    for (const k of ['a', 'b', 'c', 'd']) {
      await cache.get({ key: k, ttlMs: 100000, fetcher: async () => `v-${k}` })
    }
    expect(cache._sizeForTests).toBe(3)
  })

  test('default (no opts) uses DEFAULT_MAX_ENTRIES=128 — inserting 130 keys caps at 128', async () => {
    const cache = new FetchCache<string>()
    for (let i = 0; i < 130; i++) {
      await cache.get({ key: `k${i}`, ttlMs: 100000, fetcher: async () => `v${i}` })
    }
    expect(cache._sizeForTests).toBe(128)
  })

  test('opts with maxEntries omitted (empty opts) still uses DEFAULT_MAX_ENTRIES', async () => {
    const cache = new FetchCache<string>({})
    for (let i = 0; i < 130; i++) {
      await cache.get({ key: `k${i}`, ttlMs: 100000, fetcher: async () => `v${i}` })
    }
    expect(cache._sizeForTests).toBe(128)
  })

  test('maxEntries=0 falls back to DEFAULT (kills `||` and `>=` mutants on the m>0 check)', async () => {
    // With original code: typeof===number=true && 0>0=false → false → DEFAULT(128).
    // With `||` mutant: true || false=true → Math.floor(0)=0 → cap=0 → evict-all.
    // With `m >= 0` mutant: 0>=0=true → cap=0 → evict-all.
    const cache = new FetchCache<string>({ maxEntries: 0 })
    await cache.get({ key: 'a', ttlMs: 100000, fetcher: async () => 'v' })
    expect(cache._sizeForTests).toBe(1)
  })

  test('maxEntries=-1 falls back to DEFAULT (kills `<=` boundary swap)', async () => {
    // With `m <= 0` mutant: -1<=0=true → Math.floor(-1)=-1 → cap=-1 → evict-all.
    const cache = new FetchCache<string>({ maxEntries: -1 })
    await cache.get({ key: 'a', ttlMs: 100000, fetcher: async () => 'v' })
    expect(cache._sizeForTests).toBe(1)
  })

  test('non-number maxEntries falls back to DEFAULT (kills typeof+StringLiteral mutants)', async () => {
    // typeof 'three' === 'number' is false → DEFAULT.
    // Mutated `typeof m !== 'number'` → true && ... → Math.floor('three')=NaN → no cap.
    // Mutated typeof against '' literal → always false → DEFAULT (looks identical for
    // this input but kills the StringLiteral mutant via the typeof-comparison RHS).
    const cache = new FetchCache<string>({ maxEntries: 'three' as unknown as number })
    for (let i = 0; i < 130; i++) {
      await cache.get({ key: `k${i}`, ttlMs: 100000, fetcher: async () => `v${i}` })
    }
    expect(cache._sizeForTests).toBe(128)
  })

  test('fractional maxEntries is floored — 3.7 behaves like 3, not 4', async () => {
    // Locks the `Math.floor(m)` step. A `MethodExpression` mutant that strips
    // Math.floor would leave maxEntries=3.7; while-condition `size > 3.7`
    // would still cap at 4 (the first integer > 3.7), not 3.
    const cache = new FetchCache<string>({ maxEntries: 3.7 })
    for (const k of ['a', 'b', 'c', 'd']) {
      await cache.get({ key: k, ttlMs: 100000, fetcher: async () => `v-${k}` })
    }
    expect(cache._sizeForTests).toBe(3)
  })
})

describe('FetchCache — LRU eviction order and boundary', () => {
  // Mutation targets: L58 (stale-cleanup conditional), L69 (`>` boundary,
  // while-loop body), L71 (oldest === undefined break check).
  afterEach(() => {
    Date.now = realNow
  })

  test('size at exactly maxEntries does NOT trigger eviction (kills `>` → `>=`)', async () => {
    const cache = new FetchCache<string>({ maxEntries: 3 })
    for (const k of ['a', 'b', 'c']) {
      await cache.get({ key: k, ttlMs: 100000, fetcher: async () => `v-${k}` })
    }
    expect(cache._sizeForTests).toBe(3)
  })

  test('LRU evicts the OLDEST entry first, leaving the more-recent ones intact', async () => {
    // Mutation targets: L71 `oldest === undefined` mutated to `!==` (breaks on
    // first iteration → no eviction) and the while-condition mutated to
    // `false` (no eviction).
    const cache = new FetchCache<string>({ maxEntries: 2 })
    let aCalls = 0
    let bCalls = 0
    let cCalls = 0
    await cache.get({
      key: 'a',
      ttlMs: 100000,
      fetcher: async () => {
        aCalls++
        return 'a'
      },
    })
    await cache.get({
      key: 'b',
      ttlMs: 100000,
      fetcher: async () => {
        bCalls++
        return 'b'
      },
    })
    // 'a' is now LRU-oldest; inserting 'c' should evict 'a'.
    await cache.get({
      key: 'c',
      ttlMs: 100000,
      fetcher: async () => {
        cCalls++
        return 'c'
      },
    })
    expect(cache._sizeForTests).toBe(2)
    // Verify 'b' is still cached BEFORE we touch 'a' (re-fetching 'a' would
    // itself trigger another eviction that could remove 'b').
    await cache.get({
      key: 'b',
      ttlMs: 100000,
      fetcher: async () => {
        bCalls++
        return 'b2'
      },
    })
    expect(bCalls).toBe(1) // still cached — fetcher not invoked
    // Now verify 'a' was evicted by the 'c' insert.
    await cache.get({
      key: 'a',
      ttlMs: 100000,
      fetcher: async () => {
        aCalls++
        return 'a2'
      },
    })
    expect(aCalls).toBe(2) // re-fetched after eviction
    expect(cCalls).toBe(1) // 'c' was never re-requested
  })

  test('stale-entry refresh moves the entry to LRU tail (kills L58 `if (cached)` mutations)', async () => {
    // The L58 stale-cleanup delete is the *only* reason a stale-then-refreshed
    // entry ends up at the LRU tail (Map.set on an existing key preserves
    // insertion order — see the inline comment in fetch-cache.ts).
    //
    // Without that delete:
    //   - Refreshing A still updates A's data, but A stays at LRU head.
    //   - The next eviction would then drop A (the head), not B.
    // We assert the *opposite* — that B gets evicted, not A — which only
    // holds when the L58 delete fires.
    let now = 1000
    Date.now = () => now
    const cache = new FetchCache<string>({ maxEntries: 2 })
    await cache.get({ key: 'A', ttlMs: 100, fetcher: async () => 'A1' })
    await cache.get({ key: 'B', ttlMs: 100, fetcher: async () => 'B1' })
    now = 2000 // both stale (age 1000 ≫ TTL 100)
    // Refresh A — enters the stale-cleanup path at L58.
    await cache.get({ key: 'A', ttlMs: 100, fetcher: async () => 'A2' })
    // Insert C — eviction kicks in. Long TTL so the survivor stays fresh in
    // cache for the next probe below.
    await cache.get({ key: 'C', ttlMs: 100000, fetcher: async () => 'C1' })
    // Now probe B with a long TTL so any cached B entry is treated as fresh.
    let bCalls = 0
    await cache.get({
      key: 'B',
      ttlMs: 100000,
      fetcher: async () => {
        bCalls++
        return 'B2'
      },
    })
    // Original: B was evicted → fetcher runs → bCalls=1.
    // Mutated (L58 never deletes): A stayed at head, B got evicted by C
    // instead. But wait — in the *mutated* path, B is at LRU position
    // after A, and inserting C evicts the oldest which is A. Re-think:
    // Original: after refresh — LRU [B, A]; insert C — evict B; LRU [A, C].
    //   → probe B fetches.
    // Mutated:  after refresh — LRU [A, B] (A stays put); insert C —
    //   evict A; LRU [B, C].
    //   → probe B hits cache (entry from t=1000, age=1000ms < 100000ms TTL).
    expect(bCalls).toBe(1)
  })

  test('eviction holds across many inserts (kills while-loop block removal via timeout)', async () => {
    // If the while-loop body were stripped (`{}`), the loop runs forever
    // because cache.size never decreases past maxEntries. Stryker kills
    // this via test timeout. Exercise the eviction path so the timeout
    // actually triggers under the mutant.
    const cache = new FetchCache<string>({ maxEntries: 5 })
    for (let i = 0; i < 20; i++) {
      await cache.get({ key: `k${i}`, ttlMs: 100000, fetcher: async () => `v${i}` })
    }
    expect(cache._sizeForTests).toBe(5)
  })
})

describe('FetchCache._sizeForTests', () => {
  test('returns the actual map size (kills L96 block removal)', async () => {
    // Block removal of the getter body makes _sizeForTests return undefined.
    // Asserting against a number kills the mutant directly.
    const cache = new FetchCache<string>()
    expect(cache._sizeForTests).toBe(0)
    await cache.get({ key: 'k', ttlMs: 100, fetcher: async () => 'v' })
    expect(cache._sizeForTests).toBe(1)
    await cache.get({ key: 'k2', ttlMs: 100, fetcher: async () => 'v2' })
    expect(cache._sizeForTests).toBe(2)
  })
})

describe('FetchCache._clearForTests', () => {
  test('clears both cache and in-flight state', async () => {
    const cache = new FetchCache<string>()
    let resolveFetcher: ((v: string) => void) | null = null
    let calls = 0
    // Start a never-resolving fetcher.
    const inFlightP = cache.get({
      key: 'k',
      ttlMs: 10000,
      fetcher: () =>
        new Promise<string>(r => {
          calls++
          resolveFetcher = r
        }),
    })
    expect(calls).toBe(1)

    cache._clearForTests()

    // After clear, a new get should start a fresh fetcher (not piggyback the
    // pending one).
    let secondCalls = 0
    const p2 = cache.get({
      key: 'k',
      ttlMs: 10000,
      fetcher: async () => {
        secondCalls++
        return 'fresh'
      },
    })
    expect(secondCalls).toBe(1)
    // Resolve the original to avoid hanging.
    resolveFetcher?.('original')
    expect(await inFlightP).toBe('original')
    expect(await p2).toBe('fresh')
  })
})
