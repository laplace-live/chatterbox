/**
 * Shared 【】-wrapping helpers for danmaku content.
 *
 * Both the 同传 (STT) and 常规发送 (normal send) flows can optionally wrap
 * each outgoing segment in full-width brackets so viewers can tell the
 * wrapped content apart from regular chat. The wrapping is applied
 * per-segment (every split chunk gets its own 【】), so the split length
 * has to reserve the two wrapper graphemes up front — otherwise a wrapped
 * segment would overrun the user's configured max length. These helpers
 * keep that "reserve then wrap" contract in one place so the two callers
 * can't drift apart.
 */

export const BRACKET_OPEN = '【'
export const BRACKET_CLOSE = '】'

/** Graphemes consumed by the 【】 wrapper (one open + one close). */
export const BRACKET_RESERVE = BRACKET_OPEN.length + BRACKET_CLOSE.length

/**
 * Effective split length once the wrapper's reserved graphemes are removed.
 * Returns `maxLen` untouched when wrapping is off. Never drops below 1 so a
 * tiny `maxLen` (e.g. 1 or 2) still yields a usable, positive split window.
 */
export function wrapSplitLen(maxLen: number, wrap: boolean): number {
  return wrap ? Math.max(1, maxLen - BRACKET_RESERVE) : maxLen
}

/** Wrap a single segment in 【】 when enabled; otherwise return it as-is. */
export function wrapSegment(segment: string, wrap: boolean): string {
  return wrap ? `${BRACKET_OPEN}${segment}${BRACKET_CLOSE}` : segment
}
