/** Clearance (px) the status bar keeps from the viewport's left edge before collapsing. */
export const STATUS_BAR_EDGE_MARGIN = 8

/** Extra room (px) needed to leave compact mode, so a bar right at the threshold can't flap. */
export const STATUS_BAR_EXPAND_HYSTERESIS = 8

/** Whether the status bar should drop its collapsible parts, given its fully expanded width. */
export function shouldCompactStatusBar(expandedWidth: number, viewportWidth: number, wasCompact: boolean): boolean {
  const available = viewportWidth - STATUS_BAR_EDGE_MARGIN - (wasCompact ? STATUS_BAR_EXPAND_HYSTERESIS : 0)
  return expandedWidth > available
}
