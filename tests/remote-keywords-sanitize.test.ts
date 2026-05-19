// Regression tests for the H-sec audit fix: `fetchRemoteKeywords` previously
// stored whatever the CDN returned, with no schema validation. A compromised
// CDN could inject huge maps or non-string values that propagate into
// `applyReplacements` and outgoing danmaku.

import { describe, expect, test } from 'bun:test'

import {
  REMOTE_KEYWORDS_MAX_GLOBAL,
  REMOTE_KEYWORDS_MAX_PER_ROOM,
  REMOTE_KEYWORDS_MAX_ROOMS,
  REMOTE_KEYWORDS_MAX_VALUE_LEN,
  sanitizeKeywordsRecord,
  sanitizeRemoteKeywords,
} from '../src/lib/remote-keywords-sanitize'

// Local re-export — used by the boundary test below. Kept private to the
// production module so callers can't lean on it; the test reaches in via
// the same module export surface as the public functions.
const REMOTE_KEYWORDS_MAX_KEY_LEN = 200

describe('sanitizeKeywordsRecord', () => {
  test('keeps well-formed string entries', () => {
    expect(sanitizeKeywordsRecord({ foo: 'bar', baz: 'qux' }, 100)).toEqual({ foo: 'bar', baz: 'qux' })
  })

  test('drops non-string keys/values silently', () => {
    expect(
      sanitizeKeywordsRecord(
        {
          foo: 'ok',
          bar: 42,
          baz: null,
          qux: { nested: 'no' },
        },
        100
      )
    ).toEqual({ foo: 'ok' })
  })

  test('rejects non-object inputs', () => {
    expect(sanitizeKeywordsRecord(null, 100)).toEqual({})
    expect(sanitizeKeywordsRecord('string', 100)).toEqual({})
    expect(sanitizeKeywordsRecord([['foo', 'bar']], 100)).toEqual({})
  })

  test('caps entries at maxEntries', () => {
    const huge: Record<string, string> = {}
    for (let i = 0; i < 5; i++) huge[`k${i}`] = `v${i}`
    expect(Object.keys(sanitizeKeywordsRecord(huge, 3))).toHaveLength(3)
  })

  test('drops over-long values', () => {
    const oversize = 'x'.repeat(REMOTE_KEYWORDS_MAX_VALUE_LEN + 1)
    expect(sanitizeKeywordsRecord({ ok: 'short', bad: oversize }, 100)).toEqual({ ok: 'short' })
  })

  test('drops empty keys', () => {
    expect(sanitizeKeywordsRecord({ '': 'no-empty-key' }, 100)).toEqual({})
  })

  // Audit A11: a `" "` (whitespace-only) key passed `length > 0` and survived
  // sanitization. `applyReplacements` would then `split(" ")` every outgoing
  // danmaku and rewrite every space, corrupting one row at a time across the
  // whole client. Lock the trim()-based check in.
  test('drops whitespace-only keys (audit A11)', () => {
    expect(sanitizeKeywordsRecord({ ' ': 'attack' }, 100)).toEqual({})
    expect(sanitizeKeywordsRecord({ '\t\n  ': 'attack' }, 100)).toEqual({})
    expect(sanitizeKeywordsRecord({ '   　  ': 'attack' }, 100)).toEqual({})
    // Mixed: whitespace key dropped, real keys kept.
    expect(sanitizeKeywordsRecord({ ' ': 'evil', real: 'safe' }, 100)).toEqual({ real: 'safe' })
  })

  test('keeps keys whose content has surrounding whitespace but a non-empty trimmed value', () => {
    // We strip whitespace-only, not all-whitespace-containing — replacing
    // " hello " with " hi " is a legitimate use case.
    expect(sanitizeKeywordsRecord({ ' hello ': 'world' }, 100)).toEqual({ ' hello ': 'world' })
  })

  test('FROM length boundary: exactly MAX_KEY_LEN is kept; +1 is dropped (locks > vs >=)', () => {
    // Mutant flip from `from.length > REMOTE_KEYWORDS_MAX_KEY_LEN` to `>=`
    // would drop the boundary case (the at-limit key). Without this test
    // both versions look identical against the existing oversize-drop test.
    const exactKey = 'x'.repeat(REMOTE_KEYWORDS_MAX_KEY_LEN) // length === 200
    const overKey = 'x'.repeat(REMOTE_KEYWORDS_MAX_KEY_LEN + 1) // length === 201
    expect(sanitizeKeywordsRecord({ [exactKey]: 'kept' }, 100)).toEqual({ [exactKey]: 'kept' })
    expect(sanitizeKeywordsRecord({ [overKey]: 'dropped' }, 100)).toEqual({})
  })

  test('TO length boundary: exactly MAX_VALUE_LEN is kept; +1 is dropped (locks > vs >=)', () => {
    const exactVal = 'v'.repeat(REMOTE_KEYWORDS_MAX_VALUE_LEN)
    const overVal = 'v'.repeat(REMOTE_KEYWORDS_MAX_VALUE_LEN + 1)
    expect(sanitizeKeywordsRecord({ ok: exactVal }, 100)).toEqual({ ok: exactVal })
    expect(sanitizeKeywordsRecord({ ok: overVal }, 100)).toEqual({})
  })

  test('non-string `to` value is dropped (kills CondExpr false on L25)', () => {
    // Use values whose `.length` access is benign (not null/undefined) so
    // the mutated path doesn't crash — we want to observe the *behavior*
    // change (entry kept vs dropped), not a throw. The CondExpr-false
    // mutant on `typeof to !== 'string'` lets non-string `to` through;
    // a strict-equality assertion below catches the leak.
    expect(sanitizeKeywordsRecord({ a: 42 as unknown as string }, 100)).toEqual({})
    expect(sanitizeKeywordsRecord({ a: true as unknown as string }, 100)).toEqual({})
    expect(sanitizeKeywordsRecord({ a: {} as unknown as string }, 100)).toEqual({})
  })

  test('non-string TO does not crash on .length and the entry is dropped', () => {
    // Mutation-test trap: the `typeof to !== 'string'` half of the L25 guard
    // is what prevents the next line's `to.length` from blowing up on `null`
    // or `undefined`. If a mutant disables the guard, this call would throw
    // a TypeError. Assert non-throw explicitly so the regression surfaces.
    expect(() =>
      sanitizeKeywordsRecord(
        { a: 'ok', b: null as unknown as string, c: undefined as unknown as string, d: 42 as unknown as string },
        100
      )
    ).not.toThrow()
    expect(
      sanitizeKeywordsRecord(
        { a: 'ok', b: null as unknown as string, c: undefined as unknown as string, d: 42 as unknown as string },
        100
      )
    ).toEqual({ a: 'ok' })
  })
})

describe('sanitizeRemoteKeywords', () => {
  test('passes through well-formed payloads', () => {
    const input = {
      global: { keywords: { hello: 'world' } },
      rooms: [{ room: '101', keywords: { foo: 'bar' } }],
    }
    expect(sanitizeRemoteKeywords(input)).toEqual({
      global: { keywords: { hello: 'world' } },
      rooms: [{ room: '101', keywords: { foo: 'bar' } }],
    })
  })

  test('returns empty object for non-object inputs', () => {
    expect(sanitizeRemoteKeywords(null)).toEqual({})
    expect(sanitizeRemoteKeywords('attack')).toEqual({})
    expect(sanitizeRemoteKeywords([])).toEqual({})
  })

  test('caps the number of rooms', () => {
    const rooms = Array.from({ length: REMOTE_KEYWORDS_MAX_ROOMS + 50 }, (_, i) => ({
      room: String(i),
      keywords: { foo: 'bar' },
    }))
    const out = sanitizeRemoteKeywords({ rooms })
    expect(out.rooms?.length).toBe(REMOTE_KEYWORDS_MAX_ROOMS)
  })

  test('caps per-room and global rule counts', () => {
    const tooManyGlobal: Record<string, string> = {}
    for (let i = 0; i < REMOTE_KEYWORDS_MAX_GLOBAL + 50; i++) tooManyGlobal[`k${i}`] = `v${i}`
    const tooManyRoom: Record<string, string> = {}
    for (let i = 0; i < REMOTE_KEYWORDS_MAX_PER_ROOM + 50; i++) tooManyRoom[`k${i}`] = `v${i}`

    const out = sanitizeRemoteKeywords({
      global: { keywords: tooManyGlobal },
      rooms: [{ room: '1', keywords: tooManyRoom }],
    })
    expect(Object.keys(out.global?.keywords ?? {})).toHaveLength(REMOTE_KEYWORDS_MAX_GLOBAL)
    expect(Object.keys(out.rooms?.[0]?.keywords ?? {})).toHaveLength(REMOTE_KEYWORDS_MAX_PER_ROOM)
  })

  test('coerces numeric room ids to strings; drops empty room ids', () => {
    const out = sanitizeRemoteKeywords({
      rooms: [
        { room: 101, keywords: { a: 'b' } },
        { room: '', keywords: { x: 'y' } },
        { room: null, keywords: { x: 'y' } },
      ],
    })
    expect(out.rooms).toEqual([{ room: '101', keywords: { a: 'b' } }])
  })

  test('drops malformed room entries silently', () => {
    const out = sanitizeRemoteKeywords({
      rooms: [null, 'not an object', { room: '101', keywords: { foo: 'bar' } }],
    })
    expect(out.rooms).toEqual([{ room: '101', keywords: { foo: 'bar' } }])
  })

  test('non-object/null/array globalSection is ignored (does not populate result.global)', () => {
    // Mutant flip on the global-section guard would let non-objects through
    // and crash on `(globalSection as Record).keywords`. We pass each falsy
    // shape and assert the function (a) doesn't throw and (b) leaves
    // `result.global` undefined (the safe default).
    expect(sanitizeRemoteKeywords({ global: null })).toEqual({})
    expect(sanitizeRemoteKeywords({ global: 'not an object' })).toEqual({})
    expect(sanitizeRemoteKeywords({ global: [] })).toEqual({})
    expect(sanitizeRemoteKeywords({ global: 42 })).toEqual({})
  })

  test('non-array rooms is ignored (does not iterate non-iterables)', () => {
    // Locks the `if (Array.isArray(obj.rooms))` guard. A mutant flipping to
    // `true` would attempt to iterate a non-iterable (or treat an object
    // map as an array) and either crash or produce garbage room entries.
    expect(sanitizeRemoteKeywords({ rooms: null })).toEqual({})
    expect(sanitizeRemoteKeywords({ rooms: 'string' })).toEqual({})
    expect(sanitizeRemoteKeywords({ rooms: { not: 'an array' } })).toEqual({})
    expect(sanitizeRemoteKeywords({ rooms: 42 })).toEqual({})
  })

  test('null/undefined entries in rooms[] are dropped without crashing (locks L52 guard)', () => {
    // L52 CondExpr-false mutant removes the `typeof entry !== 'object' ||
    // entry === null` guard → `null.room` throws. The existing
    // `drops malformed room entries silently` test should catch this via
    // an implicit throw, but pin it explicitly via not.toThrow + a
    // strict-equality check so the regression is unambiguous.
    expect(() => sanitizeRemoteKeywords({ rooms: [null, undefined, { room: '101' }] })).not.toThrow()
    const out = sanitizeRemoteKeywords({ rooms: [null, undefined, { room: '101' }] })
    expect(out.rooms).toEqual([{ room: '101', keywords: {} }])
  })

  test('room entry with `room: undefined` is dropped, not coerced to a sentinel string (kills L54 StringLiteral)', () => {
    // L54 mutates `roomEntry.room ?? ''` → `roomEntry.room ?? "Stryker was here!"`.
    // For room=undefined, original yields roomId='' → !roomId truthy → dropped.
    // Mutated yields roomId='Stryker was here!' → entry pushed with that as id.
    const out = sanitizeRemoteKeywords({
      rooms: [{ room: undefined as unknown as string, keywords: { a: 'b' } }],
    })
    expect(out.rooms).toEqual([])
  })

  test('room entry with `room` field missing entirely is dropped (same StringLiteral kill via undefined access)', () => {
    // `roomEntry.room` is `undefined` when the property is absent — same
    // codepath as the explicit `room: undefined` test above but documents
    // the realistic shape: a malformed JSON row from the upstream CDN.
    const out = sanitizeRemoteKeywords({
      rooms: [{ keywords: { a: 'b' } } as unknown as { room: string }],
    })
    expect(out.rooms).toEqual([])
  })

  test('top-level non-object/null/array input returns {} without throwing', () => {
    // Existing "returns empty object for non-object inputs" only covers a
    // happy-path assertion. Tighten by verifying the function never throws
    // on hostile inputs — `null.global` would crash if the top-level guard
    // were removed.
    expect(() => sanitizeRemoteKeywords(null)).not.toThrow()
    expect(() => sanitizeRemoteKeywords(undefined)).not.toThrow()
    expect(() => sanitizeRemoteKeywords([1, 2, 3])).not.toThrow()
    expect(() => sanitizeRemoteKeywords('hostile')).not.toThrow()
    expect(() => sanitizeRemoteKeywords(42)).not.toThrow()
    expect(() => sanitizeRemoteKeywords(true)).not.toThrow()
  })
})
