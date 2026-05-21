import type { HTMLAttributes } from 'preact/compat'

import { cn } from '../../lib/cn'

type SeparatorBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className' | 'role'>

export interface SeparatorProps extends SeparatorBase {
  /**
   * Orientation of the separator line.
   * - `horizontal` (default): a 1px line spanning the parent's width.
   * - `vertical`: a 1px line spanning the parent's height; the parent
   *   must have an explicit height or be a flex container.
   */
  orientation?: 'horizontal' | 'vertical'
  /**
   * When true, the separator is purely decorative and is hidden from
   * assistive tech (mirrors shadcn/Radix behaviour). Defaults to true
   * because separators in this app are always visual rhythm, not
   * navigation landmarks.
   */
  decorative?: boolean
  className?: string
}

// `border-0` + a single directional border keeps the line crisp on
// both axes — preflight is disabled in this project, so `border` alone
// would render nothing without an explicit `*-solid` style.
const BASE_CLASS = 'shrink-0 bg-transparent border-0 border-ga2'
const ORIENTATION_CLASS: Record<NonNullable<SeparatorProps['orientation']>, string> = {
  horizontal: 'w-full h-0 border-t border-t-solid',
  vertical: 'h-full w-0 border-l border-l-solid self-stretch',
}

/**
 * Visual divider between sibling content blocks. Mirrors the shadcn/ui
 * `<Separator />` API but rendered as a plain `<div>` so it composes
 * cleanly inside flex/grid layouts without inheriting the user-agent
 * `<hr />` margin baggage.
 */
export function Separator({ orientation = 'horizontal', decorative = true, className, ...props }: SeparatorProps) {
  // Decorative separators get `role="none"` and no aria-orientation
  // (the attribute is only meaningful when the element actually has the
  // separator role). When non-decorative, we set `role="separator"` so
  // aria-orientation is valid markup.
  const a11yProps = decorative
    ? ({ role: 'none' } as const)
    : ({ role: 'separator', 'aria-orientation': orientation } as const)
  return <div {...a11yProps} class={cn(BASE_CLASS, ORIENTATION_CLASS[orientation], className)} {...props} />
}
