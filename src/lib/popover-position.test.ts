import { describe, expect, test } from 'bun:test'

import { computePopoverPosition } from './popover-position'

/**
 * Pure geometry for the `position: fixed` popover; owns the "stay on screen"
 * contract: flip to the side with room, clamp horizontally, cap the height.
 * GAP (4px) is trigger spacing; MARGIN (8px) is kept from every viewport edge.
 */
describe('computePopoverPosition', () => {
  const viewport = { width: 1000, height: 800 }

  test('opens below the trigger when side=bottom has room', () => {
    const r = computePopoverPosition(
      { top: 100, left: 50, width: 60, height: 20 },
      { width: 200, height: 150 },
      viewport,
      { side: 'bottom', align: 'start' }
    )
    // top edge sits one GAP below the trigger's bottom (100 + 20 + 4)
    expect(r).toEqual({ left: 50, top: 124, maxHeight: 668, side: 'bottom' })
  })

  test('opens above the trigger when side=top has room', () => {
    const r = computePopoverPosition(
      { top: 600, left: 50, width: 60, height: 20 },
      { width: 200, height: 150 },
      viewport,
      { side: 'top', align: 'start' }
    )
    // bottom edge sits one GAP above the trigger's top: 600 - 4 - 150
    expect(r).toEqual({ left: 50, top: 446, maxHeight: 588, side: 'top' })
  })

  test('flips top→bottom when the trigger is near the top edge (the emote-selector bug)', () => {
    const r = computePopoverPosition(
      { top: 80, left: 50, width: 60, height: 20 },
      { width: 280, height: 360 },
      { width: 1000, height: 900 },
      { side: 'top', align: 'start' }
    )
    expect(r.side).toBe('bottom')
    expect(r.top).toBe(104) // 80 + 20 + 4, opens downward instead of clipping
    expect(r.maxHeight).toBe(788)
  })

  test('flips bottom→top when the trigger is near the bottom edge', () => {
    const r = computePopoverPosition(
      { top: 820, left: 50, width: 60, height: 20 },
      { width: 200, height: 300 },
      { width: 1000, height: 900 },
      { side: 'bottom', align: 'start' }
    )
    expect(r.side).toBe('top')
    expect(r.top).toBe(516) // 820 - 4 - 300
    expect(r.maxHeight).toBe(808)
  })

  test('align=end right-aligns the content to the trigger', () => {
    const r = computePopoverPosition(
      { top: 100, left: 500, width: 60, height: 20 },
      { width: 200, height: 100 },
      viewport,
      { side: 'bottom', align: 'end' }
    )
    // 500 + 60 - 200
    expect(r.left).toBe(360)
  })

  test('align=center centers the content on the trigger', () => {
    const r = computePopoverPosition(
      { top: 100, left: 500, width: 60, height: 20 },
      { width: 200, height: 100 },
      viewport,
      { side: 'bottom', align: 'center' }
    )
    // 500 + 30 - 100
    expect(r.left).toBe(430)
  })

  test('clamps to the right viewport edge when start-align would overflow', () => {
    const r = computePopoverPosition(
      { top: 100, left: 900, width: 60, height: 20 },
      { width: 280, height: 100 },
      viewport,
      { side: 'bottom', align: 'start' }
    )
    // viewport.width - MARGIN - content.width = 1000 - 8 - 280
    expect(r.left).toBe(712)
  })

  test('pins to the left margin when the content is wider than the viewport', () => {
    const r = computePopoverPosition(
      { top: 100, left: 50, width: 60, height: 20 },
      { width: 1200, height: 100 },
      viewport,
      { side: 'bottom', align: 'start' }
    )
    expect(r.left).toBe(8) // MARGIN
  })

  test('caps maxHeight to the available space so a tall popover scrolls', () => {
    const r = computePopoverPosition(
      { top: 400, left: 50, width: 60, height: 20 },
      { width: 200, height: 1000 },
      viewport,
      { side: 'bottom', align: 'start' }
    )
    // 1000px content can't fit below (368) so it flips to the roomier top
    // (388) and caps there; the component scrolls the overflow internally.
    expect(r.side).toBe('top')
    expect(r.maxHeight).toBe(388)
    expect(r.top).toBe(8) // 400 - 4 - 388, sits at the top margin
  })
})
