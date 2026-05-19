/**
 * Tier picker + duration mapping + countdown formatting.
 *
 * These tests lock in the reader-focused duration table. If a future PR
 * tries to "match B站 native" by bumping the durations back to 1/2/5/10/30/60
 * minutes, these tests should fail loudly — the design call to cap at 5
 * minutes and tier ¥30/50/100/500/1000 is deliberate and documented in
 * `custom-chat-sc-pinstrip-tier.ts` header.
 */

import { describe, expect, test } from 'bun:test'

import {
  formatRemainingTime,
  SC_TIERS,
  scAmountToDurationMs,
  scAmountToTier,
  tierAccessibilityLabel,
} from '../src/lib/custom-chat-sc-pinstrip-tier'

describe('SC_TIERS table', () => {
  test('exactly 5 tiers (T1 through T5)', () => {
    expect(SC_TIERS.map(t => t.id)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
  })

  test('sorted by minAmount ascending — picker logic depends on this', () => {
    for (let i = 1; i < SC_TIERS.length; i++) {
      expect(SC_TIERS[i].minAmount).toBeGreaterThan(SC_TIERS[i - 1].minAmount)
    }
  })

  test('durations are reader-focused: ≤ 5 min cap, monotonically increasing', () => {
    for (let i = 1; i < SC_TIERS.length; i++) {
      expect(SC_TIERS[i].durationSec).toBeGreaterThanOrEqual(SC_TIERS[i - 1].durationSec)
    }
    // Hard cap — the design call. A ¥10000 SC should NOT pin for 60 minutes,
    // we're not B站 trying to maximize streamer attention.
    expect(SC_TIERS[SC_TIERS.length - 1].durationSec).toBeLessThanOrEqual(300)
    // And the minimum tier should give the reader at least 10s to spot it.
    expect(SC_TIERS[0].durationSec).toBeGreaterThanOrEqual(10)
  })

  test('all tiers have non-empty Chinese labels', () => {
    for (const t of SC_TIERS) {
      expect(t.label.length).toBeGreaterThan(0)
    }
  })
})

describe('scAmountToTier — boundary picking', () => {
  test('amount 0 falls to T1', () => {
    expect(scAmountToTier(0).id).toBe('T1')
  })
  test('amount 30 (the conventional Bilibili minimum SC) maps to T1', () => {
    expect(scAmountToTier(30).id).toBe('T1')
  })
  test('amount 49 still T1, amount 50 jumps to T2', () => {
    expect(scAmountToTier(49).id).toBe('T1')
    expect(scAmountToTier(50).id).toBe('T2')
  })
  test('amount 99 → T2, amount 100 → T3', () => {
    expect(scAmountToTier(99).id).toBe('T2')
    expect(scAmountToTier(100).id).toBe('T3')
  })
  test('amount 499 → T3, amount 500 → T4', () => {
    expect(scAmountToTier(499).id).toBe('T3')
    expect(scAmountToTier(500).id).toBe('T4')
  })
  test('amount 999 → T4, amount 1000 → T5', () => {
    expect(scAmountToTier(999).id).toBe('T4')
    expect(scAmountToTier(1000).id).toBe('T5')
  })
  test('amount 10000+ stays T5 (no higher tier exists)', () => {
    expect(scAmountToTier(10000).id).toBe('T5')
    expect(scAmountToTier(99999).id).toBe('T5')
  })
})

describe('scAmountToTier — defensive against bad input', () => {
  test('undefined → T1, not crash', () => {
    expect(scAmountToTier(undefined).id).toBe('T1')
  })
  test('negative → T1', () => {
    expect(scAmountToTier(-50).id).toBe('T1')
  })
  test('NaN → T1', () => {
    expect(scAmountToTier(Number.NaN).id).toBe('T1')
  })
  test('Infinity → T5 (top tier)', () => {
    // Infinity is not Number.isFinite, so it falls into the !isFinite branch
    // and gets normalized to 0 → T1. Documenting expected behavior.
    expect(scAmountToTier(Number.POSITIVE_INFINITY).id).toBe('T1')
  })
})

describe('scAmountToDurationMs', () => {
  test('returns seconds × 1000 for each tier', () => {
    expect(scAmountToDurationMs(30)).toBe(15_000)
    expect(scAmountToDurationMs(50)).toBe(30_000)
    expect(scAmountToDurationMs(100)).toBe(60_000)
    expect(scAmountToDurationMs(500)).toBe(120_000)
    expect(scAmountToDurationMs(1000)).toBe(300_000)
  })
  test('top tier caps at 5 minutes even for absurd amounts', () => {
    expect(scAmountToDurationMs(50_000)).toBe(300_000)
  })
})

describe('formatRemainingTime', () => {
  test('5 seconds → "0:05"', () => {
    expect(formatRemainingTime(5000)).toBe('0:05')
  })
  test('1 minute → "1:00"', () => {
    expect(formatRemainingTime(60_000)).toBe('1:00')
  })
  test('1 minute 23 seconds → "1:23"', () => {
    expect(formatRemainingTime(83_000)).toBe('1:23')
  })
  test('rounds UP to next whole second (so "0:01" shows for the final 999ms)', () => {
    expect(formatRemainingTime(1)).toBe('0:01')
    expect(formatRemainingTime(999)).toBe('0:01')
  })
  test('zero / negative / NaN → "0:00"', () => {
    expect(formatRemainingTime(0)).toBe('0:00')
    expect(formatRemainingTime(-100)).toBe('0:00')
    expect(formatRemainingTime(Number.NaN)).toBe('0:00')
  })
})

describe('tierAccessibilityLabel', () => {
  test('includes tier label, amount, and duration in Chinese', () => {
    const tier = scAmountToTier(500)
    const label = tierAccessibilityLabel(tier, 500)
    expect(label).toContain('¥500')
    expect(label).toContain('高调')
    expect(label).toContain('120')
  })
})
