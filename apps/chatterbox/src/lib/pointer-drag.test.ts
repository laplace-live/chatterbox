import { describe, expect, it, mock } from 'bun:test'

import { startPointerDrag } from './pointer-drag'

function createFakeTarget(capturedInitially = true, isConnected = true) {
  const listeners = new Map<string, Set<EventListener>>()
  let captured = false
  return {
    isConnected,
    setPointerCapture: mock(() => {
      captured = capturedInitially
    }),
    hasPointerCapture: mock(() => captured),
    releasePointerCapture: mock(() => {
      captured = false
      for (const fn of listeners.get('lostpointercapture') ?? []) fn(new Event('lostpointercapture'))
    }),
    addEventListener: mock((type: string, fn: EventListener) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn)
    }),
    removeEventListener: mock((type: string, fn: EventListener) => {
      listeners.get(type)?.delete(fn)
    }),
    emit(type: string, event: unknown) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(event as Event)
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0
    },
  }
}

describe('startPointerDrag', () => {
  it('cleans up via lostpointercapture on pointerup and restores body styles', () => {
    const prevDocument = globalThis.document
    const fakeBody = { style: { cursor: 'auto', userSelect: 'text' } }
    globalThis.document = { body: fakeBody } as unknown as Document
    try {
      const target = createFakeTarget(true)
      const onMove = mock(() => {})

      startPointerDrag(target as unknown as Element, { pointerId: 7 } as PointerEvent, {
        onMove,
        cursor: 'ew-resize',
      })

      expect(fakeBody.style.cursor).toBe('ew-resize')
      expect(fakeBody.style.userSelect).toBe('none')

      target.emit('pointermove', { pointerId: 7, buttons: 1, clientX: 50 })
      expect(onMove).toHaveBeenCalledTimes(1)

      target.emit('pointerup', { pointerId: 7 })
      expect(target.releasePointerCapture).toHaveBeenCalledWith(7)
      expect(fakeBody.style.cursor).toBe('auto')
      expect(fakeBody.style.userSelect).toBe('text')
      expect(target.listenerCount('pointermove')).toBe(0)
      expect(target.listenerCount('lostpointercapture')).toBe(0)
    } finally {
      globalThis.document = prevDocument
    }
  })

  it('skips releasePointerCapture when uncaptured and ends drag when move has buttons === 0', () => {
    const prevDocument = globalThis.document
    const fakeBody = { style: { cursor: '', userSelect: '' } }
    globalThis.document = { body: fakeBody } as unknown as Document
    try {
      const target = createFakeTarget(false)
      const onMove = mock(() => {})

      startPointerDrag(target as unknown as Element, { pointerId: 9 } as PointerEvent, {
        onMove,
        cursor: 'grabbing',
      })

      target.emit('pointermove', { pointerId: 9, buttons: 0 })
      expect(onMove).not.toHaveBeenCalled()
      expect(target.releasePointerCapture).not.toHaveBeenCalled()
      expect(fakeBody.style.cursor).toBe('')
      expect(fakeBody.style.userSelect).toBe('')
      expect(target.listenerCount('pointermove')).toBe(0)
    } finally {
      globalThis.document = prevDocument
    }
  })

  it('ignores events from other pointerIds and cleans up synchronously on cancel()', () => {
    const prevDocument = globalThis.document
    const fakeBody = { style: { cursor: 'default', userSelect: 'auto' } }
    globalThis.document = { body: fakeBody } as unknown as Document
    try {
      const target = createFakeTarget(true)
      const onMove = mock(() => {})

      const cancel = startPointerDrag(target as unknown as Element, { pointerId: 3 } as PointerEvent, {
        onMove,
        cursor: 'grabbing',
      })

      target.emit('pointermove', { pointerId: 99, buttons: 1, clientX: 10 })
      target.emit('pointerup', { pointerId: 99 })
      expect(onMove).not.toHaveBeenCalled()
      expect(fakeBody.style.cursor).toBe('grabbing')
      expect(fakeBody.style.userSelect).toBe('none')

      cancel()
      expect(target.releasePointerCapture).toHaveBeenCalledWith(3)
      expect(fakeBody.style.cursor).toBe('default')
      expect(fakeBody.style.userSelect).toBe('auto')
      expect(target.listenerCount('pointermove')).toBe(0)
    } finally {
      globalThis.document = prevDocument
    }
  })

  it('cleans up directly without calling releasePointerCapture when target is disconnected', () => {
    const prevDocument = globalThis.document
    const fakeBody = { style: { cursor: '', userSelect: '' } }
    globalThis.document = { body: fakeBody } as unknown as Document
    try {
      const target = createFakeTarget(true, false)
      const onMove = mock(() => {})

      startPointerDrag(target as unknown as Element, { pointerId: 5 } as PointerEvent, {
        onMove,
        cursor: 'ns-resize',
      })

      target.emit('pointerup', { pointerId: 5 })
      expect(target.releasePointerCapture).not.toHaveBeenCalled()
      expect(fakeBody.style.cursor).toBe('')
      expect(fakeBody.style.userSelect).toBe('')
      expect(target.listenerCount('pointermove')).toBe(0)
    } finally {
      globalThis.document = prevDocument
    }
  })
})
