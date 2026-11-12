import { describe, expect, test } from 'bun:test'

import {
  expandedStatusBarWidth,
  STATUS_BAR_EDGE_MARGIN,
  STATUS_BAR_EXPAND_HYSTERESIS,
  shouldCompactStatusBar,
} from './status-bar-layout'

const VIEWPORT = 1000
const FITS_EXACTLY = VIEWPORT - STATUS_BAR_EDGE_MARGIN

describe('shouldCompactStatusBar', () => {
  test('stays expanded while the expanded bar fits', () => {
    expect(shouldCompactStatusBar(FITS_EXACTLY, VIEWPORT, false)).toBe(false)
  })

  test('collapses once the expanded bar would overflow', () => {
    expect(shouldCompactStatusBar(FITS_EXACTLY + 1, VIEWPORT, false)).toBe(true)
  })

  // Hysteresis: a bar sitting right at the edge must not toggle on every sub-pixel re-measure.
  test('stays compact inside the hysteresis band', () => {
    expect(shouldCompactStatusBar(FITS_EXACTLY, VIEWPORT, true)).toBe(true)
    expect(shouldCompactStatusBar(FITS_EXACTLY - STATUS_BAR_EXPAND_HYSTERESIS + 1, VIEWPORT, true)).toBe(true)
  })

  test('expands once there is room past the hysteresis band', () => {
    expect(shouldCompactStatusBar(FITS_EXACTLY - STATUS_BAR_EXPAND_HYSTERESIS, VIEWPORT, true)).toBe(false)
  })
})

describe('expandedStatusBarWidth', () => {
  test('adds compact-hidden label widths to the measured bar', () => {
    expect(expandedStatusBarWidth(100, [{ contentWidth: 80, slotWidth: 20, folded: false }])).toBe(160)
  })

  test('skips labels inside a manually folded group', () => {
    expect(expandedStatusBarWidth(100, [{ contentWidth: 80, slotWidth: 20, folded: true }])).toBe(100)
  })

  test('handles folded and expanded labels together', () => {
    expect(
      expandedStatusBarWidth(300, [
        { contentWidth: 80, slotWidth: 20, folded: true },
        { contentWidth: 60, slotWidth: 24, folded: false },
        { contentWidth: 40, slotWidth: 16, folded: false },
      ])
    ).toBe(360)
  })

  test('returns the measured width for no slots', () => {
    expect(expandedStatusBarWidth(250, [])).toBe(250)
  })
})
