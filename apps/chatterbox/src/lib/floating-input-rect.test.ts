import { describe, expect, it } from 'bun:test'

import {
  clampFloatingRect,
  defaultFloatingRect,
  FLOATING_INPUT_DEFAULT_BOTTOM,
  FLOATING_INPUT_DEFAULT_HEIGHT,
  FLOATING_INPUT_DEFAULT_RIGHT,
  FLOATING_INPUT_DEFAULT_WIDTH,
  FLOATING_INPUT_MIN_HEIGHT,
  FLOATING_INPUT_MIN_WIDTH,
  moveFloatingRect,
  resizeFloatingRect,
} from './floating-input-rect'

const VIEWPORT = { width: 1280, height: 720 }

describe('clampFloatingRect & defaultFloatingRect', () => {
  it('enforces minimum size and keeps the box inside viewport', () => {
    expect(clampFloatingRect({ left: -20, top: -10, width: 50, height: 10 }, VIEWPORT)).toEqual({
      left: 0,
      top: 0,
      width: FLOATING_INPUT_MIN_WIDTH,
      height: FLOATING_INPUT_MIN_HEIGHT,
    })

    expect(clampFloatingRect({ left: 1200, top: 700, width: 240, height: 80 }, VIEWPORT)).toEqual({
      left: 1040,
      top: 640,
      width: 240,
      height: 80,
    })
  })

  it('places the default box at the fixed bottom-right Bilibili input offset', () => {
    expect(defaultFloatingRect(VIEWPORT)).toEqual({
      left: VIEWPORT.width - FLOATING_INPUT_DEFAULT_RIGHT - FLOATING_INPUT_DEFAULT_WIDTH,
      top: VIEWPORT.height - FLOATING_INPUT_DEFAULT_BOTTOM - FLOATING_INPUT_DEFAULT_HEIGHT,
      width: FLOATING_INPUT_DEFAULT_WIDTH,
      height: FLOATING_INPUT_DEFAULT_HEIGHT,
    })
  })
})

describe('moveFloatingRect', () => {
  it('moves while preserving size and clamping to viewport edges', () => {
    const start = { left: 900, top: 600, width: 220, height: 50 }
    expect(moveFloatingRect(start, -100, -50, VIEWPORT)).toEqual({
      left: 800,
      top: 550,
      width: 220,
      height: 50,
    })
    expect(moveFloatingRect(start, 500, 500, VIEWPORT)).toEqual({
      left: 1060,
      top: 670,
      width: 220,
      height: 50,
    })
  })
})

describe('resizeFloatingRect', () => {
  const start = { left: 900, top: 600, width: 220, height: 50 }

  it('expands and shrinks symmetrically in all four directions while anchoring opposite edges', () => {
    expect(resizeFloatingRect(start, 'w', -80, 0, VIEWPORT)).toEqual({
      left: 820,
      top: 600,
      width: 300,
      height: 50,
    })
    expect(resizeFloatingRect(start, 'e', 60, 0, VIEWPORT)).toEqual({
      left: 900,
      top: 600,
      width: 280,
      height: 50,
    })
    expect(resizeFloatingRect(start, 'n', 0, -100, VIEWPORT)).toEqual({
      left: 900,
      top: 500,
      width: 220,
      height: 150,
    })
    expect(resizeFloatingRect(start, 's', 0, 40, VIEWPORT)).toEqual({
      left: 900,
      top: 600,
      width: 220,
      height: 90,
    })
  })

  it('clamps shrink to minimum dimensions without shifting opposite edges', () => {
    const shrunkW = resizeFloatingRect(start, 'w', 500, 0, VIEWPORT)
    expect(shrunkW.width).toBe(FLOATING_INPUT_MIN_WIDTH)
    expect(shrunkW.left + shrunkW.width).toBe(start.left + start.width)

    const shrunkN = resizeFloatingRect(start, 'n', 0, 500, VIEWPORT)
    expect(shrunkN.height).toBe(FLOATING_INPUT_MIN_HEIGHT)
    expect(shrunkN.top + shrunkN.height).toBe(start.top + start.height)
  })

  it('handles corner drags (nw/se) without escaping viewport', () => {
    expect(resizeFloatingRect(start, 'se', 500, 500, VIEWPORT)).toEqual({
      left: 900,
      top: 600,
      width: 380,
      height: 120,
    })
    expect(resizeFloatingRect(start, 'nw', -2000, -2000, VIEWPORT)).toEqual({
      left: 0,
      top: 0,
      width: 1120,
      height: 650,
    })
  })
})
