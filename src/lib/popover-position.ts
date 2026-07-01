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
 * Pure geometry for the floating Popover/Combobox content, in viewport coords.
 * Flips to the opposite side when the preferred side is too cramped, caps
 * `maxHeight` to the chosen side's room (so it scrolls, not bleeds off-screen),
 * and clamps horizontally into the viewport margins.
 */
export function computePopoverPosition(
  trigger: PopoverRect,
  content: PopoverSize,
  viewport: PopoverViewport,
  opts: PopoverPositionOptions
): PopoverPlacement {
  const gap = opts.gap ?? DEFAULT_GAP
  const margin = opts.margin ?? DEFAULT_MARGIN

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
  // Content wider than viewport (maxLeft < minLeft): pin to left margin.
  left = maxLeft >= minLeft ? Math.min(Math.max(left, minLeft), maxLeft) : minLeft

  return { left, top, maxHeight, side }
}
