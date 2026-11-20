export interface FloatingRect {
  right: number
  bottom: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export const FLOATING_INPUT_MIN_WIDTH = 180
// Move bar, one textarea line and the medal/emote row.
export const FLOATING_INPUT_MIN_HEIGHT = 66

/** First-run rect: bottom-right, just above the StatusBar. After that the user's last rect is remembered. */
export const DEFAULT_FLOATING_RECT: Readonly<FloatingRect> = { right: 8, bottom: 44, width: 240, height: 84 }

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Clamp `rect` inside `viewport` while enforcing minimum dimensions. */
export function clampFloatingRect(rect: FloatingRect, viewport: ViewportSize): FloatingRect {
  const maxWidth = Math.max(FLOATING_INPUT_MIN_WIDTH, viewport.width)
  const maxHeight = Math.max(FLOATING_INPUT_MIN_HEIGHT, viewport.height)
  const width = clamp(Math.round(rect.width), FLOATING_INPUT_MIN_WIDTH, maxWidth)
  const height = clamp(Math.round(rect.height), FLOATING_INPUT_MIN_HEIGHT, maxHeight)
  const right = clamp(Math.round(rect.right), 0, Math.max(0, viewport.width - width))
  const bottom = clamp(Math.round(rect.bottom), 0, Math.max(0, viewport.height - height))
  return { right, bottom, width, height }
}

/** Translate `startRect` by `(dx, dy)`, keeping its size unchanged and inside `viewport`. */
export function moveFloatingRect(
  startRect: FloatingRect,
  dx: number,
  dy: number,
  viewport: ViewportSize
): FloatingRect {
  return clampFloatingRect(
    {
      right: startRect.right - dx,
      bottom: startRect.bottom - dy,
      width: startRect.width,
      height: startRect.height,
    },
    viewport
  )
}

/** Resize `startRect` from its bottom-right corner by `(dx, dy)`; the top-left corner stays put and the box on screen. */
export function resizeFloatingRect(startRect: FloatingRect, dx: number, dy: number): FloatingRect {
  // `right`/`bottom` are the gaps to the viewport edge, so the corner may grow by at most those.
  const width = clamp(Math.round(startRect.width + dx), FLOATING_INPUT_MIN_WIDTH, startRect.width + startRect.right)
  const height = clamp(
    Math.round(startRect.height + dy),
    FLOATING_INPUT_MIN_HEIGHT,
    startRect.height + startRect.bottom
  )
  return {
    right: startRect.right + startRect.width - width,
    bottom: startRect.bottom + startRect.height - height,
    width,
    height,
  }
}
