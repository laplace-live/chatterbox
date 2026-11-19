export interface PointerDragOptions {
  onMove: (e: PointerEvent) => void
  cursor?: string
}

/**
 * Attach pointer drag listeners on `target` and return an idempotent cancel callback.
 * Restores body cursor and selection via `lostpointercapture`, window fallbacks, or cancel().
 */
export function startPointerDrag(
  target: Element,
  initialEvent: PointerEvent,
  { onMove, cursor }: PointerDragOptions
): () => void {
  const pointerId = initialEvent.pointerId
  try {
    target.setPointerCapture(pointerId)
  } catch {
    // Synthetic or already-released pointers cannot be captured; fall back to window/end events.
  }

  const prevCursor = document.body.style.cursor
  const prevUserSelect = document.body.style.userSelect
  if (cursor) document.body.style.cursor = cursor
  document.body.style.userSelect = 'none'

  const hasWindow = typeof window !== 'undefined'
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    target.removeEventListener('pointermove', handleMove)
    target.removeEventListener('pointerup', handleEnd)
    target.removeEventListener('pointercancel', handleEnd)
    target.removeEventListener('lostpointercapture', cleanup)
    if (hasWindow) {
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      window.removeEventListener('blur', handleBlur)
    }
    document.body.style.cursor = prevCursor
    document.body.style.userSelect = prevUserSelect
  }

  const releaseCapture = () => {
    if (target.isConnected !== false && target.hasPointerCapture?.(pointerId)) {
      try {
        target.releasePointerCapture(pointerId)
        return true
      } catch {
        // Fall through to direct cleanup if release rejects.
      }
    }
    return false
  }

  const endDrag = () => {
    if (!releaseCapture()) cleanup()
  }

  const handleMove = (ev: Event) => {
    const pe = ev as PointerEvent
    if (pe.pointerId !== pointerId) return
    if (pe.buttons === 0) {
      endDrag()
      return
    }
    onMove(pe)
  }

  const handleEnd = (ev: Event) => {
    const pe = ev as PointerEvent
    if (pe.pointerId !== pointerId) return
    endDrag()
  }

  const handleBlur = () => {
    endDrag()
  }

  target.addEventListener('pointermove', handleMove)
  target.addEventListener('pointerup', handleEnd)
  target.addEventListener('pointercancel', handleEnd)
  target.addEventListener('lostpointercapture', cleanup)
  if (hasWindow) {
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    window.addEventListener('blur', handleBlur)
  }

  return () => {
    releaseCapture()
    cleanup()
  }
}
