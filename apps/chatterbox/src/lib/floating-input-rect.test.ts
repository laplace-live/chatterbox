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
    const start = { right: 160, bottom: 70, width: 220, height: 70 }
    expect(moveFloatingRect(start, -100, -50, VIEWPORT)).toEqual({
      right: 260,
      bottom: 120,
      width: 220,
      height: 70,
    })
    expect(moveFloatingRect(start, 500, 500, VIEWPORT)).toEqual({
      right: 0,
      bottom: 0,
      width: 220,
      height: 70,
    })
    expect(moveFloatingRect(start, -2000, -2000, VIEWPORT)).toEqual({
      right: 1060,
      bottom: 650,
      width: 220,
      height: 70,
    })
  })
})

describe('resizeFloatingRect', () => {
  const start = { right: 160, bottom: 70, width: 220, height: 90 }

  it('grows and shrinks from the bottom-right corner, keeping the top-left corner fixed', () => {
    expect(resizeFloatingRect(start, 60, 40)).toEqual({ right: 100, bottom: 30, width: 280, height: 130 })
    expect(resizeFloatingRect(start, -20, -10)).toEqual({ right: 180, bottom: 80, width: 200, height: 80 })
  })

  it('clamps to the minimum size and the viewport edges', () => {
    const shrunk = resizeFloatingRect(start, -500, -500)
    expect(shrunk).toEqual({
      right: start.right + start.width - FLOATING_INPUT_MIN_WIDTH,
      bottom: start.bottom + start.height - FLOATING_INPUT_MIN_HEIGHT,
      width: FLOATING_INPUT_MIN_WIDTH,
      height: FLOATING_INPUT_MIN_HEIGHT,
    })
    expect(resizeFloatingRect(start, 500, 500)).toEqual({ right: 0, bottom: 0, width: 380, height: 160 })
  })
})
