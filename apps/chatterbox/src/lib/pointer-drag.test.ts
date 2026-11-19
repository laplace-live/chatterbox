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

  it('ignores lostpointercapture for other pointerIds and preserves original body styles across concurrent drags', () => {
    const prevDocument = globalThis.document
    const fakeBody = { style: { cursor: 'auto', userSelect: 'text' } }
    globalThis.document = { body: fakeBody } as unknown as Document
    try {
      const targetA = createFakeTarget(true)
      const targetB = createFakeTarget(true)
      const onMove = mock(() => {})

      startPointerDrag(targetA as unknown as Element, { pointerId: 1 } as PointerEvent, {
        onMove,
        cursor: 'grabbing',
      })
      startPointerDrag(targetB as unknown as Element, { pointerId: 2 } as PointerEvent, {
        onMove,
        cursor: 'ew-resize',
      })

      expect(fakeBody.style.cursor).toBe('ew-resize')
      expect(fakeBody.style.userSelect).toBe('none')

      // Mismatched lostpointercapture pointerId does not prematurely end drag A.
      targetA.emit('lostpointercapture', { pointerId: 999 })
      expect(targetA.listenerCount('pointermove')).toBe(1)

      // Ending drag A first keeps userSelect disabled and drag B's cursor active.
      targetA.emit('pointerup', { pointerId: 1 })
      expect(fakeBody.style.userSelect).toBe('none')
      expect(fakeBody.style.cursor).toBe('ew-resize')

      // Ending drag B restores the original body styles from before drag A started.
      targetB.emit('pointerup', { pointerId: 2 })
      expect(fakeBody.style.cursor).toBe('auto')
      expect(fakeBody.style.userSelect).toBe('text')
    } finally {
      globalThis.document = prevDocument
    }
  })

  it('registers window pointermove fallback when capture fails and removes it on cleanup', () => {
    const prevDocument = globalThis.document
    const prevWindow = globalThis.window
    const fakeBody = { style: { cursor: '', userSelect: '' } }
    const winListeners = new Map<string, Set<EventListener>>()
    const fakeWindow = {
      addEventListener: mock((type: string, fn: EventListener) => {
        let set = winListeners.get(type)
        if (!set) {
          set = new Set()
          winListeners.set(type, set)
        }
        set.add(fn)
      }),
      removeEventListener: mock((type: string, fn: EventListener) => {
        winListeners.get(type)?.delete(fn)
      }),
      emit(type: string, event: unknown) {
        for (const fn of [...(winListeners.get(type) ?? [])]) fn(event as Event)
      },
    }
    globalThis.document = { body: fakeBody } as unknown as Document
    globalThis.window = fakeWindow as unknown as Window & typeof globalThis
    try {
      const target = createFakeTarget(false)
      const onMove = mock(() => {})

      startPointerDrag(target as unknown as Element, { pointerId: 4 } as PointerEvent, {
        onMove,
        cursor: 'grabbing',
      })

      const sharedEvent = { pointerId: 4, buttons: 1, clientX: 25 }
      target.emit('pointermove', sharedEvent)
      fakeWindow.emit('pointermove', sharedEvent)
      expect(onMove).toHaveBeenCalledTimes(1)

      fakeWindow.emit('pointermove', { pointerId: 4, buttons: 1, clientX: 40 })
      expect(onMove).toHaveBeenCalledTimes(2)

      fakeWindow.emit('pointerup', { pointerId: 4 })
      expect(winListeners.get('pointermove')?.size ?? 0).toBe(0)
      expect(fakeBody.style.cursor).toBe('')
      expect(fakeBody.style.userSelect).toBe('')
    } finally {
      globalThis.document = prevDocument
      globalThis.window = prevWindow
    }
  })
})
