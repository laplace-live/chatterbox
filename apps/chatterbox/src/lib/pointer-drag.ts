/** Pointer-capture surface `startPointerDrag` needs: an `HTMLElement` or a test double. */
export interface DragTarget extends EventTarget {
  setPointerCapture(pointerId: number): void
  hasPointerCapture(pointerId: number): boolean
  releasePointerCapture(pointerId: number): void
}

// Overlapping drags share the body overrides; the saved styles come back when the last one ends.
let activeDrags = 0
let savedCursor = ''
let savedUserSelect = ''

/**
 * Track `pointerId` from its `pointerdown` on `target` until release, with the body cursor and
 * text selection locked meanwhile. `onEnd` runs once however the drag ends. Returns an idempotent cancel.
 */
export function startPointerDrag(
  target: DragTarget,
  pointerId: number,
  { onMove, onEnd, cursor }: { onMove: (e: PointerEvent) => void; onEnd?: () => void; cursor: string }
): () => void {
  try {
    target.setPointerCapture(pointerId)
  } catch {
    // Synthetic or already-released pointers can't be captured; the window listeners still see them.
  }
  const { style } = document.body
  if (activeDrags++ === 0) {
    savedCursor = style.cursor
    savedUserSelect = style.userSelect
  }
  style.cursor = cursor
  style.userSelect = 'none'

  const listeners = new AbortController()
  const end = () => {
    if (listeners.signal.aborted) return
    listeners.abort()
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    if (--activeDrags === 0) {
      style.cursor = savedCursor
      style.userSelect = savedUserSelect
    }
    onEnd?.()
  }
  const endIfOurs = (e: Event) => {
    if ('pointerId' in e && e.pointerId === pointerId) end()
  }
  // Window capture phase sees this pointer's events whether or not the capture above took.
  const options = { capture: true, signal: listeners.signal }
  window.addEventListener(
    'pointermove',
    e => {
      if (e.pointerId !== pointerId) return
      if (e.buttons === 0) end()
      else onMove(e)
    },
    options
  )
  window.addEventListener('pointerup', endIfOurs, options)
  window.addEventListener('pointercancel', endIfOurs, options)
  // Not capture: element blurs pass window in the capture phase; only the window's own blur should end the drag.
  window.addEventListener('blur', end, { signal: listeners.signal })
  target.addEventListener('lostpointercapture', endIfOurs, { signal: listeners.signal })
  return end
}
