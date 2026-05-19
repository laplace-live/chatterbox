import { describe, expect, test } from 'bun:test'

import {
  ANCHOR_OFFSET,
  computePos,
  PICKER_GAP,
  PICKER_H,
  PICKER_W,
  type PickerRect,
} from '../src/lib/emote-picker-position'

// Realistic Bilibili Live right-rail viewport — chat panel sits in the right
// half of a 1920-wide window. The composer is anchored near the bottom.
const VW = 1920
const VH = 1080

function rect(left: number, top: number, width = 28, height = 28): PickerRect {
  return { left, top, right: left + width, bottom: top + height }
}

describe('emote picker positioning (computePos)', () => {
  test('returns a safe corner fallback when the anchor is missing', () => {
    expect(computePos(null, VW, VH)).toEqual({ bottom: PICKER_GAP, right: PICKER_GAP })
  })

  test('opens above the anchor when there is enough headroom', () => {
    // Anchor at bottom of viewport, well below PICKER_H.
    const pos = computePos(rect(1700, 1000), VW, VH)
    expect(pos.bottom).toBeGreaterThan(0)
    expect(pos.top).toBeUndefined()
    // bottom = vh - rect.top + ANCHOR_OFFSET = 1080 - 1000 + 4 = 84
    expect(pos.bottom).toBe(VH - 1000 + ANCHOR_OFFSET)
  })

  test('flips to below the anchor when there is not enough headroom above', () => {
    // Anchor at top of viewport — picker would overflow upward.
    const pos = computePos(rect(1700, 50), VW, VH)
    expect(pos.bottom).toBeUndefined()
    expect(pos.top).toBe(50 + 28 + ANCHOR_OFFSET)
  })

  test('uses bottom-anchor exactly at the headroom threshold', () => {
    // rect.top === PICKER_H + PICKER_GAP — boundary uses >= so this fits above.
    const pos = computePos(rect(1700, PICKER_H + PICKER_GAP), VW, VH)
    expect(pos.bottom).toBeDefined()
    expect(pos.top).toBeUndefined()
  })

  test('falls back to top-anchor one pixel below the headroom threshold', () => {
    const pos = computePos(rect(1700, PICKER_H + PICKER_GAP - 1), VW, VH)
    expect(pos.top).toBeDefined()
    expect(pos.bottom).toBeUndefined()
  })

  test('centers the picker on the anchor when there is room on both sides', () => {
    // Anchor's center at 1714 (1700 + 14). Picker width 320 → ideal left = 1554.
    const pos = computePos(rect(1700, 1000), VW, VH)
    expect(pos.left).toBe(1700 + 14 - PICKER_W / 2)
    expect(pos.right).toBeUndefined()
  })

  test('clamps the picker into the viewport when the anchor sits near the right edge', () => {
    // Anchor center near right edge → ideal left would push past viewport right.
    const pos = computePos(rect(VW - 50, 1000), VW, VH)
    // Should clamp to (vw - PICKER_W - PICKER_GAP).
    expect(pos.left).toBe(VW - PICKER_W - PICKER_GAP)
  })

  test('clamps the picker into the viewport when the anchor sits near the left edge', () => {
    // Anchor center near left edge → ideal left would be negative.
    const pos = computePos(rect(20, 1000), VW, VH)
    expect(pos.left).toBe(PICKER_GAP)
  })

  test('always returns left (never right) — picker is always positioned by left edge after center-anchoring', () => {
    const cases: PickerRect[] = [rect(20, 1000), rect(960, 1000), rect(1700, 1000), rect(VW - 10, 1000)]
    for (const r of cases) {
      const pos = computePos(r, VW, VH)
      expect(pos.right).toBeUndefined()
      expect(pos.left).toBeDefined()
    }
  })

  test('top + bottom never coexist; left + right never coexist', () => {
    const cases: PickerRect[] = [rect(40, 50), rect(40, 1000), rect(1700, 50), rect(1700, 1000)]
    for (const r of cases) {
      const pos = computePos(r, VW, VH)
      expect(pos.top !== undefined && pos.bottom !== undefined).toBe(false)
      // Center-anchoring uses `left` exclusively now; we still guarantee one side is set.
      expect(pos.top !== undefined || pos.bottom !== undefined).toBe(true)
      expect(pos.left !== undefined || pos.right !== undefined).toBe(true)
    }
  })

  test('exposed dimensions match the picker component constants', () => {
    expect(PICKER_W).toBe(320)
    expect(PICKER_H).toBe(360)
    expect(PICKER_GAP).toBeGreaterThan(0)
    expect(ANCHOR_OFFSET).toBeGreaterThan(0)
  })

  describe('flank-panel mode', () => {
    // Realistic chatterbox panel: 320px wide, glued to right edge with 8px gap.
    const panel = (): PickerRect => ({
      top: 100,
      bottom: 660,
      left: VW - 328,
      right: VW - 8,
    })
    // Trigger button somewhere inside the panel (the 手动发送 smiley).
    const triggerInPanel = (): PickerRect => rect(VW - 300, 600)

    test('places picker to the LEFT of the panel when room allows', () => {
      const pos = computePos(triggerInPanel(), VW, VH, panel())
      // Right-anchored: picker.right = vw - panel.left + GAP = vw - (vw - 328) + 8 = 336
      expect(pos.right).toBe(VW - panel().left + PICKER_GAP)
      expect(pos.left).toBeUndefined()
    })

    test('aligns picker vertically with the trigger center, clamped to viewport', () => {
      const pos = computePos(triggerInPanel(), VW, VH, panel())
      // Anchor center = (600 + 628) / 2 = 614. Ideal top = 614 - 180 = 434.
      // maxTop = VH - PICKER_H - PICKER_GAP = 1080 - 360 - 8 = 712. 434 < 712 so no clamp.
      expect(pos.top).toBe(614 - PICKER_H / 2)
      expect(pos.bottom).toBeUndefined()
    })

    test('clamps vertically to top of viewport when trigger sits near the top', () => {
      const trigger = rect(VW - 300, 0) // anchor center at y=14
      const pos = computePos(trigger, VW, VH, panel())
      // Ideal top = 14 - 180 = -166. Clamped to PICKER_GAP (8).
      expect(pos.top).toBe(PICKER_GAP)
    })

    test('clamps vertically to bottom of viewport when trigger sits near the bottom', () => {
      const trigger = rect(VW - 300, VH - 14)
      const pos = computePos(trigger, VW, VH, panel())
      // maxTop = VH - PICKER_H - PICKER_GAP = 712.
      expect(pos.top).toBe(VH - PICKER_H - PICKER_GAP)
    })

    test('falls back to centered-above mode when the panel leaves no left-side room', () => {
      // Narrow viewport: panel takes most of the width, no room to flank.
      const narrowVW = 380 // less than PICKER_W + 2*PICKER_GAP = 336
      const narrowPanel: PickerRect = { top: 100, bottom: 660, left: 60, right: 380 }
      const trigger = rect(80, 600)
      const pos = computePos(trigger, narrowVW, VH, narrowPanel)
      // Fall through to centered-above mode: should yield `left` (centered) and
      // `top` or `bottom`, NOT `right` (which would mean flank mode).
      expect(pos.right).toBeUndefined()
      expect(pos.left).toBeDefined()
    })

    test('flankRect null/undefined behaves identically to omitting it', () => {
      const trigger = triggerInPanel()
      const withoutFlank = computePos(trigger, VW, VH)
      const withNullFlank = computePos(trigger, VW, VH, null)
      const withUndefinedFlank = computePos(trigger, VW, VH, undefined)
      expect(withNullFlank).toEqual(withoutFlank)
      expect(withUndefinedFlank).toEqual(withoutFlank)
    })

    test('flank-mode picker never overlaps the panel horizontally', () => {
      const p = panel()
      const trigger = triggerInPanel()
      const pos = computePos(trigger, VW, VH, p)
      // pos.right is distance from viewport right edge to picker's right edge.
      // Picker's right edge in absolute coords = VW - pos.right
      const pickerRight = VW - (pos.right ?? 0)
      // Must be at or left of the panel's left edge (minus our gap).
      expect(pickerRight).toBeLessThanOrEqual(p.left - PICKER_GAP + 1) // +1 = floating-point slop
    })
  })
})
