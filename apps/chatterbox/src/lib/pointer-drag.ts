export interface PointerDragOptions {
  onMove: (e: PointerEvent) => void
  cursor?: string
}

interface ActiveDragStyle {
  cursor?: string
}

const activeDragStyles: ActiveDragStyle[] = []
let savedBodyCursor = ''
let savedBodyUserSelect = ''

function syncBodyDragStyles(): void {
  if (activeDragStyles.length === 0) {
    document.body.style.cursor = savedBodyCursor
    document.body.style.userSelect = savedBodyUserSelect
    return
  }
  document.body.style.userSelect = 'none'
  const topCursor = [...activeDragStyles].reverse().find(entry => entry.cursor)?.cursor
  document.body.style.cursor = topCursor ?? savedBodyCursor
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
  let captured = false
  try {
    target.setPointerCapture(pointerId)
    captured = target.hasPointerCapture?.(pointerId) ?? true
  } catch {
    // Synthetic or already-released pointers cannot be captured; fall back to window/end events.
  }

  if (activeDragStyles.length === 0) {
    savedBodyCursor = document.body.style.cursor
    savedBodyUserSelect = document.body.style.userSelect
  }
  const styleEntry: ActiveDragStyle = { cursor }
  activeDragStyles.push(styleEntry)
  syncBodyDragStyles()

  const hasWindow = typeof window !== 'undefined'
  let cleaned = false
  let lastMoveEvent: Event | null = null

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    target.removeEventListener('pointermove', handleMove)
    target.removeEventListener('pointerup', handleEnd)
    target.removeEventListener('pointercancel', handleEnd)
    target.removeEventListener('lostpointercapture', handleLostCapture)
    if (hasWindow) {
      if (!captured) window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      window.removeEventListener('blur', handleBlur)
    }
    const idx = activeDragStyles.indexOf(styleEntry)
    if (idx >= 0) activeDragStyles.splice(idx, 1)
    syncBodyDragStyles()
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
    if (ev === lastMoveEvent) return
    lastMoveEvent = ev
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

  const handleLostCapture = (ev: Event) => {
    const pid = (ev as Partial<PointerEvent>).pointerId
    if (typeof pid === 'number' && pid !== pointerId) return
    cleanup()
  }

  const handleBlur = () => {
    endDrag()
  }

  target.addEventListener('pointermove', handleMove)
  target.addEventListener('pointerup', handleEnd)
  target.addEventListener('pointercancel', handleEnd)
  target.addEventListener('lostpointercapture', handleLostCapture)
  if (hasWindow) {
    if (!captured) window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    window.addEventListener('blur', handleBlur)
  }

  return () => {
    releaseCapture()
    cleanup()
  }
}
