import { describe, expect, test } from 'bun:test'

import { stripCardCountSuffix } from '../src/lib/custom-chat-pricing'

/**
 * Regression tests for the gift / guard card text suffix stripper.
 *
 * Background (Jobs 2026-05-18): Bilibili source data for gift / guard cards
 * has the count baked into `message.text` (e.g. "送出 嘉年华 × 1"). The
 * chatterbox custom chat renders this raw text inside the card bubble — but
 * we also overlay a `.lc-chat-merge-count` "×N" badge for "this same gift
 * arrived N times in 9s" duplicate folding. Two ×'s with two different
 * meanings on the same card = reader confusion. We strip the trailing count
 * from the rendered text since the count is already shown in the fields row
 * ("数量 / x1") above.
 *
 * These tests pin the regex behavior — esp. the "only at end" rule, since a
 * naive global replace would eat any "x3" the user typed in the middle of
 * an SC text message.
 */
describe('stripCardCountSuffix', () => {
  test('strips Chinese × suffix on gift text', () => {
    expect(stripCardCountSuffix('送出 嘉年华 × 1')).toBe('送出 嘉年华')
    expect(stripCardCountSuffix('送出 嘉年华 ×1')).toBe('送出 嘉年华')
    expect(stripCardCountSuffix('送出 嘉年华×1')).toBe('送出 嘉年华')
  })

  test('strips lowercase x suffix (B站 alternative form)', () => {
    expect(stripCardCountSuffix('投喂 小花花 x66')).toBe('投喂 小花花')
    expect(stripCardCountSuffix('投喂 小花花x66')).toBe('投喂 小花花')
    expect(stripCardCountSuffix('投喂 小花花 x 66')).toBe('投喂 小花花')
  })

  test('strips uppercase X suffix (case insensitive)', () => {
    expect(stripCardCountSuffix('开通了舰长 X3')).toBe('开通了舰长')
  })

  test('strips two-digit counts', () => {
    expect(stripCardCountSuffix('送出 辣条 × 999')).toBe('送出 辣条')
  })

  test('tolerates trailing whitespace', () => {
    expect(stripCardCountSuffix('送出 嘉年华 × 1   ')).toBe('送出 嘉年华')
    expect(stripCardCountSuffix('送出 嘉年华 ×1\t')).toBe('送出 嘉年华')
  })

  test('keeps text with no count suffix unchanged', () => {
    expect(stripCardCountSuffix('送出 嘉年华')).toBe('送出 嘉年华')
    expect(stripCardCountSuffix('主播声音太好听了!求一首晴天')).toBe('主播声音太好听了!求一首晴天')
  })

  test('does NOT strip × N from middle of text — only trailing', () => {
    // SC text or danmaku might mention x3 / × 5 mid-sentence. Don't touch it.
    expect(stripCardCountSuffix('喷火 x3 被房管警告')).toBe('喷火 x3 被房管警告')
    expect(stripCardCountSuffix('主播 × 2 桌台开了')).toBe('主播 × 2 桌台开了')
  })

  test('handles empty / whitespace-only input', () => {
    expect(stripCardCountSuffix('')).toBe('')
    expect(stripCardCountSuffix('   ')).toBe('   ')
  })

  test('only strips the LAST suffix when there are multiple x N patterns', () => {
    // "送出 5x打火机 × 3" — naive global replace would eat the 5x too. We want
    // only the trailing × 3 stripped.
    expect(stripCardCountSuffix('送出 5x打火机 × 3')).toBe('送出 5x打火机')
  })

  test('does not strip dangling numbers without × prefix', () => {
    // "嘉年华 1" (no ×) must NOT be treated as count suffix — the 1 might be
    // part of the gift name (e.g. "节日礼物 1"). Without the × delimiter we
    // can't tell, so we keep the text as-is.
    expect(stripCardCountSuffix('节日礼物 1')).toBe('节日礼物 1')
  })
})
