/**
 * Shared 【】-wrapping helpers for danmaku content. Wrapping is per-segment, so
 * the split length must reserve the two wrapper graphemes up front or a wrapped
 * segment overruns the configured max length.
 */

import { getDanmakuUnits } from './utils'

export const BRACKET_OPEN = '【'
export const BRACKET_CLOSE = '】'

/** Graphemes consumed by the 【】 wrapper (one open + one close). */
export const BRACKET_RESERVE = BRACKET_OPEN.length + BRACKET_CLOSE.length

/** Half-width danmaku units consumed by the 【】 wrapper (`2 + 2 = 4` under Bilibili's `utilDanmuLength`). */
export const BRACKET_UNIT_RESERVE = getDanmakuUnits(BRACKET_OPEN + BRACKET_CLOSE)

/**
 * Effective split length once the wrapper's reserved graphemes are removed.
 * @returns `maxLen` untouched when `wrap` is off; otherwise clamped to a min of 1.
 */
export function wrapSplitLen(maxLen: number, wrap: boolean): number {
  return wrap ? Math.max(1, maxLen - BRACKET_RESERVE) : maxLen
}

/** Effective split budget in half-width danmaku units once the 【】 wrapper is reserved. */
export function wrapSplitUnits(maxUnits: number, wrap: boolean): number {
  return wrap ? Math.max(1, maxUnits - BRACKET_UNIT_RESERVE) : maxUnits
}

/** Wrap a single segment in 【】 when enabled; otherwise return it as-is. */
export function wrapSegment(segment: string, wrap: boolean): string {
  return wrap ? `${BRACKET_OPEN}${segment}${BRACKET_CLOSE}` : segment
}

/** Strip a single outer 【…】 wrapper (non-empty, with no interior `】`), or `null` when not wrapped. */
export function unwrapSegment(segment: string): string | null {
  if (!segment.startsWith(BRACKET_OPEN) || !segment.endsWith(BRACKET_CLOSE)) return null
  const inner = segment.slice(BRACKET_OPEN.length, -BRACKET_CLOSE.length)
  return inner && !inner.includes(BRACKET_CLOSE) ? inner : null
}
