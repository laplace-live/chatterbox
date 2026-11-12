/** Clearance (px) the status bar keeps from the viewport's left edge before collapsing. */
export const STATUS_BAR_EDGE_MARGIN = 8

/** Extra room (px) needed to leave compact mode, so a bar right at the threshold can't flap. */
export const STATUS_BAR_EXPAND_HYSTERESIS = 8

export interface StatusBarSlotWidth {
  /** Width of the compact-hidden label content inside the slot. */
  contentWidth: number
  /** Width the slot currently occupies in `barWidth`. */
  slotWidth: number
  /** Inside a manually folded group, which isn't part of the bar's expanded width. */
  folded: boolean
}

/** Fully expanded bar width: measured bar plus compact-hidden labels, skipping manually folded groups. */
export function expandedStatusBarWidth(barWidth: number, slots: Iterable<StatusBarSlotWidth>): number {
  let hiddenWidth = 0
  for (const slot of slots) {
    if (!slot.folded) hiddenWidth += slot.contentWidth - slot.slotWidth
  }
  return barWidth + hiddenWidth
}

/** Whether the status bar should drop its collapsible parts, given its fully expanded width. */
export function shouldCompactStatusBar(expandedWidth: number, viewportWidth: number, wasCompact: boolean): boolean {
  const available = viewportWidth - STATUS_BAR_EDGE_MARGIN - (wasCompact ? STATUS_BAR_EXPAND_HYSTERESIS : 0)
  return expandedWidth > available
}
