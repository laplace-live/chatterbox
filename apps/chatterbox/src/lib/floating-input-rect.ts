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

export type ResizeEdge = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se'

export const FLOATING_INPUT_MIN_WIDTH = 180
// One textarea line plus the medal/emote row.
export const FLOATING_INPUT_MIN_HEIGHT = 52

/** First-run rect: bottom-right, just above the StatusBar. After that the user's last rect is remembered. */
export const DEFAULT_FLOATING_RECT: Readonly<FloatingRect> = { right: 8, bottom: 44, width: 240, height: 64 }

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

/** Resize `startRect` along `edge` by pointer delta `(dx, dy)` while anchoring opposite edges. */
export function resizeFloatingRect(
  startRect: FloatingRect,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  viewport: ViewportSize
): FloatingRect {
  let right = startRect.right
  let bottom = startRect.bottom
  let width = startRect.width
  let height = startRect.height

  if (edge.includes('w')) {
    const maxW = Math.max(FLOATING_INPUT_MIN_WIDTH, viewport.width - startRect.right)
    width = clamp(Math.round(startRect.width - dx), FLOATING_INPUT_MIN_WIDTH, maxW)
  } else if (edge.includes('e')) {
    const maxW = Math.max(FLOATING_INPUT_MIN_WIDTH, startRect.width + startRect.right)
    width = clamp(Math.round(startRect.width + dx), FLOATING_INPUT_MIN_WIDTH, maxW)
    right = startRect.right + startRect.width - width
  }

  if (edge.includes('n')) {
    const maxH = Math.max(FLOATING_INPUT_MIN_HEIGHT, viewport.height - startRect.bottom)
    height = clamp(Math.round(startRect.height - dy), FLOATING_INPUT_MIN_HEIGHT, maxH)
  } else if (edge.includes('s')) {
    const maxH = Math.max(FLOATING_INPUT_MIN_HEIGHT, startRect.height + startRect.bottom)
    height = clamp(Math.round(startRect.height + dy), FLOATING_INPUT_MIN_HEIGHT, maxH)
    bottom = startRect.bottom + startRect.height - height
  }

  return { right, bottom, width, height }
}
