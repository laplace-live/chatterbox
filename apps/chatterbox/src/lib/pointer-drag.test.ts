import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import { startPointerDrag } from './pointer-drag'

const originalDocument = Reflect.get(globalThis, 'document')
const originalWindow = Reflect.get(globalThis, 'window')
const body = { style: { cursor: '', userSelect: '' } }
let win = new EventTarget()

beforeEach(() => {
  body.style = { cursor: 'auto', userSelect: 'text' }
  win = new EventTarget()
  Reflect.set(globalThis, 'document', { body })
  Reflect.set(globalThis, 'window', win)
})

afterEach(() => {
  Reflect.set(globalThis, 'document', originalDocument)
  Reflect.set(globalThis, 'window', originalWindow)
})

function fakeTarget(capturable = true) {
  const captured = new Set<number>()
  return Object.assign(new EventTarget(), {
    setPointerCapture: mock((id: number) => {
      if (capturable) captured.add(id)
    }),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: mock((id: number) => {
      captured.delete(id)
    }),
  })
}

function pointer(type: string, init: { pointerId: number; buttons?: number; clientX?: number }) {
  return Object.assign(new Event(type), { buttons: 1, ...init })
}

const RESTORED = { cursor: 'auto', userSelect: 'text' }

describe('startPointerDrag', () => {
  it('tracks moves, then releases capture and restores body styles on pointerup', () => {
    const target = fakeTarget()
    const onMove = mock(() => {})
    startPointerDrag(target, 7, { onMove, cursor: 'ew-resize' })
    expect(body.style).toEqual({ cursor: 'ew-resize', userSelect: 'none' })

    win.dispatchEvent(pointer('pointermove', { pointerId: 7, clientX: 50 }))
    expect(onMove).toHaveBeenCalledTimes(1)

    win.dispatchEvent(pointer('pointerup', { pointerId: 7 }))
    expect(target.releasePointerCapture).toHaveBeenCalledWith(7)
    expect(body.style).toEqual(RESTORED)

    win.dispatchEvent(pointer('pointermove', { pointerId: 7 }))
    expect(onMove).toHaveBeenCalledTimes(1)
  })

  it('ends on a buttonless move without calling onMove or releasing an uncaptured pointer', () => {
    const target = fakeTarget(false)
    const onMove = mock(() => {})
    startPointerDrag(target, 9, { onMove, cursor: 'grabbing' })

    win.dispatchEvent(pointer('pointermove', { pointerId: 9, buttons: 0 }))
    expect(onMove).not.toHaveBeenCalled()
    expect(target.releasePointerCapture).not.toHaveBeenCalled()
    expect(body.style).toEqual(RESTORED)
  })

  it('ignores other pointers, and cancel() ends synchronously and idempotently', () => {
    const target = fakeTarget()
    const onMove = mock(() => {})
    const cancel = startPointerDrag(target, 3, { onMove, cursor: 'grabbing' })

    win.dispatchEvent(pointer('pointermove', { pointerId: 99 }))
    win.dispatchEvent(pointer('pointerup', { pointerId: 99 }))
    target.dispatchEvent(pointer('lostpointercapture', { pointerId: 99 }))
    expect(onMove).not.toHaveBeenCalled()
    expect(body.style.userSelect).toBe('none')

    cancel()
    cancel()
    expect(target.releasePointerCapture).toHaveBeenCalledTimes(1)
    expect(body.style).toEqual(RESTORED)
  })

  it('ends when the target loses capture or the window blurs', () => {
    const target = fakeTarget()
    startPointerDrag(target, 1, { onMove: () => {}, cursor: 'grabbing' })
    target.dispatchEvent(pointer('lostpointercapture', { pointerId: 1 }))
    expect(body.style).toEqual(RESTORED)

    startPointerDrag(fakeTarget(), 2, { onMove: () => {}, cursor: 'grabbing' })
    win.dispatchEvent(new Event('blur'))
    expect(body.style).toEqual(RESTORED)
  })

  it('keeps the body overrides until the last overlapping drag ends', () => {
    startPointerDrag(fakeTarget(), 1, { onMove: () => {}, cursor: 'grabbing' })
    startPointerDrag(fakeTarget(), 2, { onMove: () => {}, cursor: 'ew-resize' })
    expect(body.style).toEqual({ cursor: 'ew-resize', userSelect: 'none' })

    win.dispatchEvent(pointer('pointerup', { pointerId: 1 }))
    expect(body.style).toEqual({ cursor: 'ew-resize', userSelect: 'none' })

    win.dispatchEvent(pointer('pointerup', { pointerId: 2 }))
    expect(body.style).toEqual(RESTORED)
  })
})
