export type PopoverSide = 'top' | 'bottom'
export type PopoverAlign = 'start' | 'center' | 'end'

export interface PopoverRect {
  top: number
  left: number
  width: number
  height: number
}

export interface PopoverSize {
  width: number
  height: number
}

export interface PopoverViewport {
  width: number
  height: number
}

export interface PopoverPlacement {
  left: number
  top: number
  /** Cap for the content box so a too-tall popover scrolls instead of bleeding off-screen. */
  maxHeight: number
  /** The side actually used after any flip — lets the caller mirror its enter animation. */
  side: PopoverSide
}

export interface PopoverPositionOptions {
  side: PopoverSide
  align: PopoverAlign
  /** Gap between the trigger and the content edge. Mirrors the old mt-1/mb-1 (4px). */
  gap?: number
  /** Minimum breathing room kept from every viewport edge. */
  margin?: number
}

const DEFAULT_GAP = 4
const DEFAULT_MARGIN = 8

/**
 * Pure geometry for the floating Popover/Combobox content.
 *
 * The component renders the content as `position: fixed` (so it escapes the
 * Configurator dialog's `overflow` clip) and applies the `left`/`top`/
 * `maxHeight` returned here, computed from the trigger's and content's
 * `getBoundingClientRect`s in viewport coordinates.
 *
 * Contract:
 *   - Prefer `opts.side`, but FLIP to the opposite side when the content
 *     can't fit on the preferred side and the opposite side has more room.
 *     This is what fixes a trigger near the top edge opening upward into a
 *     clip — it now opens downward instead.
 *   - `maxHeight` is capped to the available space on the chosen side, so a
 *     popover taller than the room scrolls internally rather than running
 *     off-screen.
 *   - Horizontally, align to the trigger (start/center/end), then clamp the
 *     box inside the viewport margins. If the content is wider than the
 *     viewport, pin it to the left margin.
 */
export function computePopoverPosition(
  trigger: PopoverRect,
  content: PopoverSize,
  viewport: PopoverViewport,
  opts: PopoverPositionOptions
): PopoverPlacement {
  const gap = opts.gap ?? DEFAULT_GAP
  const margin = opts.margin ?? DEFAULT_MARGIN

  // --- Vertical: pick a side (flipping when the preferred one is cramped),
  //     then cap the height to that side's available space. ---
  const spaceAbove = trigger.top - margin - gap
  const spaceBelow = viewport.height - (trigger.top + trigger.height) - margin - gap

  let side = opts.side
  if (side === 'top' && content.height > spaceAbove && spaceBelow > spaceAbove) {
    side = 'bottom'
  } else if (side === 'bottom' && content.height > spaceBelow && spaceAbove > spaceBelow) {
    side = 'top'
  }

  const available = side === 'top' ? spaceAbove : spaceBelow
  const maxHeight = Math.max(0, available)
  const height = Math.min(content.height, maxHeight)
  const top = side === 'top' ? trigger.top - gap - height : trigger.top + trigger.height + gap

  // --- Horizontal: align to the trigger, then clamp into the viewport. ---
  let left: number
  if (opts.align === 'end') {
    left = trigger.left + trigger.width - content.width
  } else if (opts.align === 'center') {
    left = trigger.left + trigger.width / 2 - content.width / 2
  } else {
    left = trigger.left
  }

  const minLeft = margin
  const maxLeft = viewport.width - margin - content.width
  // When the content is wider than the available width (maxLeft < minLeft),
  // there's nothing to clamp into — pin to the left margin and let the
  // content's own width handling (truncate / scroll) take over.
  left = maxLeft >= minLeft ? Math.min(Math.max(left, minLeft), maxLeft) : minLeft

  return { left, top, maxHeight, side }
}
