import { describe, expect, it } from 'bun:test'

import {
  clampFloatingRect,
  DEFAULT_FLOATING_RECT,
  FLOATING_INPUT_MIN_HEIGHT,
  FLOATING_INPUT_MIN_WIDTH,
  moveFloatingRect,
  resizeFloatingRect,
} from './floating-input-rect'

const VIEWPORT = { width: 1280, height: 720 }

describe('clampFloatingRect', () => {
  it('enforces minimum size and keeps the box inside viewport', () => {
    expect(clampFloatingRect({ right: -20, bottom: -10, width: 50, height: 10 }, VIEWPORT)).toEqual({
      right: 0,
      bottom: 0,
      width: FLOATING_INPUT_MIN_WIDTH,
      height: FLOATING_INPUT_MIN_HEIGHT,
    })

    expect(clampFloatingRect({ right: 1200, bottom: 700, width: 240, height: 80 }, VIEWPORT)).toEqual({
      right: 1040,
      bottom: 640,
      width: 240,
      height: 80,
    })
  })

  it('keeps a bottom-right rect anchored as the viewport grows', () => {
    expect(clampFloatingRect(DEFAULT_FLOATING_RECT, { width: 1335, height: 750 })).toEqual(DEFAULT_FLOATING_RECT)
    expect(clampFloatingRect(DEFAULT_FLOATING_RECT, { width: 1536, height: 860 })).toEqual(DEFAULT_FLOATING_RECT)
  })
})

describe('moveFloatingRect', () => {
  it('moves while preserving size and clamping to viewport edges', () => {
    const start = { right: 160, bottom: 70, width: 220, height: 60 }
    expect(moveFloatingRect(start, -100, -50, VIEWPORT)).toEqual({
      right: 260,
      bottom: 120,
      width: 220,
      height: 60,
    })
    expect(moveFloatingRect(start, 500, 500, VIEWPORT)).toEqual({
      right: 0,
      bottom: 0,
      width: 220,
      height: 60,
    })
    expect(moveFloatingRect(start, -2000, -2000, VIEWPORT)).toEqual({
      right: 1060,
      bottom: 660,
      width: 220,
      height: 60,
    })
  })
})

describe('resizeFloatingRect', () => {
  const start = { right: 160, bottom: 70, width: 220, height: 50 }

  it('expands and shrinks symmetrically in all four directions while anchoring opposite edges', () => {
    expect(resizeFloatingRect(start, 'w', -80, 0, VIEWPORT)).toEqual({
      right: 160,
      bottom: 70,
      width: 300,
      height: 50,
    })
    expect(resizeFloatingRect(start, 'e', 60, 0, VIEWPORT)).toEqual({
      right: 100,
      bottom: 70,
      width: 280,
      height: 50,
    })
    expect(resizeFloatingRect(start, 'n', 0, -100, VIEWPORT)).toEqual({
      right: 160,
      bottom: 70,
      width: 220,
      height: 150,
    })
    expect(resizeFloatingRect(start, 's', 0, 40, VIEWPORT)).toEqual({
      right: 160,
      bottom: 30,
      width: 220,
      height: 90,
    })
  })

  it('clamps shrink to minimum dimensions without shifting opposite edges', () => {
    const shrunkW = resizeFloatingRect(start, 'w', 500, 0, VIEWPORT)
    expect(shrunkW.width).toBe(FLOATING_INPUT_MIN_WIDTH)
    expect(shrunkW.right).toBe(start.right)

    const shrunkE = resizeFloatingRect(start, 'e', -500, 0, VIEWPORT)
    expect(shrunkE.width).toBe(FLOATING_INPUT_MIN_WIDTH)
    expect(shrunkE.right + shrunkE.width).toBe(start.right + start.width)

    const shrunkN = resizeFloatingRect(start, 'n', 0, 500, VIEWPORT)
    expect(shrunkN.height).toBe(FLOATING_INPUT_MIN_HEIGHT)
    expect(shrunkN.bottom).toBe(start.bottom)

    const shrunkS = resizeFloatingRect(start, 's', 0, -500, VIEWPORT)
    expect(shrunkS.height).toBe(FLOATING_INPUT_MIN_HEIGHT)
    expect(shrunkS.bottom + shrunkS.height).toBe(start.bottom + start.height)
  })

  it('handles corner drags (nw/se) without escaping viewport', () => {
    expect(resizeFloatingRect(start, 'se', 500, 500, VIEWPORT)).toEqual({
      right: 0,
      bottom: 0,
      width: 380,
      height: 120,
    })
    expect(resizeFloatingRect(start, 'nw', -2000, -2000, VIEWPORT)).toEqual({
      right: 160,
      bottom: 70,
      width: 1120,
      height: 650,
    })
  })
})
