export interface FloatingRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ViewportSize {
  width: number
  height: number
}

export type ResizeEdge = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se'

export const FLOATING_INPUT_MIN_WIDTH = 180
export const FLOATING_INPUT_MIN_HEIGHT = 44

// Fixed default matching B站's 300px chat panel input box (196x56, sitting above the status bar fold button).
export const FLOATING_INPUT_DEFAULT_WIDTH = 196
export const FLOATING_INPUT_DEFAULT_HEIGHT = 56
export const FLOATING_INPUT_DEFAULT_RIGHT = 98
export const FLOATING_INPUT_DEFAULT_BOTTOM = 11

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

/** Clamp `rect` inside `viewport` while enforcing minimum dimensions. */
export function clampFloatingRect(rect: FloatingRect, viewport: ViewportSize): FloatingRect {
  const maxWidth = Math.max(FLOATING_INPUT_MIN_WIDTH, viewport.width)
  const maxHeight = Math.max(FLOATING_INPUT_MIN_HEIGHT, viewport.height)
  const width = clamp(Math.round(rect.width), FLOATING_INPUT_MIN_WIDTH, maxWidth)
  const height = clamp(Math.round(rect.height), FLOATING_INPUT_MIN_HEIGHT, maxHeight)
  const left = clamp(Math.round(rect.left), 0, Math.max(0, viewport.width - width))
  const top = clamp(Math.round(rect.top), 0, Math.max(0, viewport.height - height))
  return { left, top, width, height }
}

/** Fixed initial rect calibrated to B站's live-room chat input position and size. */
export function defaultFloatingRect(viewport: ViewportSize): FloatingRect {
  return clampFloatingRect(
    {
      left: viewport.width - FLOATING_INPUT_DEFAULT_RIGHT - FLOATING_INPUT_DEFAULT_WIDTH,
      top: viewport.height - FLOATING_INPUT_DEFAULT_BOTTOM - FLOATING_INPUT_DEFAULT_HEIGHT,
      width: FLOATING_INPUT_DEFAULT_WIDTH,
      height: FLOATING_INPUT_DEFAULT_HEIGHT,
    },
    viewport
  )
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
      left: startRect.left + dx,
      top: startRect.top + dy,
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
  const right = startRect.left + startRect.width
  const bottom = startRect.top + startRect.height

  let left = startRect.left
  let top = startRect.top
  let width = startRect.width
  let height = startRect.height

  if (edge.includes('w')) {
    const maxW = Math.max(FLOATING_INPUT_MIN_WIDTH, right)
    width = clamp(Math.round(startRect.width - dx), FLOATING_INPUT_MIN_WIDTH, maxW)
    left = right - width
  } else if (edge.includes('e')) {
    const maxW = Math.max(FLOATING_INPUT_MIN_WIDTH, viewport.width - startRect.left)
    width = clamp(Math.round(startRect.width + dx), FLOATING_INPUT_MIN_WIDTH, maxW)
  }

  if (edge.includes('n')) {
    const maxH = Math.max(FLOATING_INPUT_MIN_HEIGHT, bottom)
    height = clamp(Math.round(startRect.height - dy), FLOATING_INPUT_MIN_HEIGHT, maxH)
    top = bottom - height
  } else if (edge.includes('s')) {
    const maxH = Math.max(FLOATING_INPUT_MIN_HEIGHT, viewport.height - startRect.top)
    height = clamp(Math.round(startRect.height + dy), FLOATING_INPUT_MIN_HEIGHT, maxH)
  }

  return { left, top, width, height }
}
