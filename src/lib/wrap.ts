/**
 * Shared 【】-wrapping helpers for danmaku content. Wrapping is per-segment, so
 * the split length must reserve the two wrapper graphemes up front or a wrapped
 * segment overruns the configured max length.
 */

export const BRACKET_OPEN = '【'
export const BRACKET_CLOSE = '】'

/** Graphemes consumed by the 【】 wrapper (one open + one close). */
export const BRACKET_RESERVE = BRACKET_OPEN.length + BRACKET_CLOSE.length

/**
 * Effective split length once the wrapper's reserved graphemes are removed.
 * @returns `maxLen` untouched when `wrap` is off; otherwise clamped to a min of 1.
 */
export function wrapSplitLen(maxLen: number, wrap: boolean): number {
  return wrap ? Math.max(1, maxLen - BRACKET_RESERVE) : maxLen
}

/** Wrap a single segment in 【】 when enabled; otherwise return it as-is. */
export function wrapSegment(segment: string, wrap: boolean): string {
  return wrap ? `${BRACKET_OPEN}${segment}${BRACKET_CLOSE}` : segment
}
