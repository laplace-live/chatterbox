import type { HTMLAttributes } from 'preact/compat'

import { cn } from '../../lib/cn'

type SeparatorBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className' | 'role'>

export interface SeparatorProps extends SeparatorBase {
  /** Line orientation; `vertical` needs the parent to have an explicit height or be a flex container. */
  orientation?: 'horizontal' | 'vertical'
  /** When true (default), hidden from assistive tech (mirrors shadcn/Radix). */
  decorative?: boolean
  className?: string
}

// Preflight is disabled here, so a bare `border` renders nothing without an explicit `*-solid` style.
const BASE_CLASS = 'shrink-0 bg-transparent border-0 border-ga2'
const ORIENTATION_CLASS: Record<NonNullable<SeparatorProps['orientation']>, string> = {
  horizontal: 'w-full h-0 border-t border-t-solid',
  vertical: 'h-full w-0 border-l border-l-solid self-stretch',
}

/** Visual divider; a plain `<div>` (not `<hr />`) to avoid user-agent margin in flex/grid layouts. */
export function Separator({ orientation = 'horizontal', decorative = true, className, ...props }: SeparatorProps) {
  // aria-orientation is only valid alongside role="separator".
  const a11yProps = decorative
    ? ({ role: 'none' } as const)
    : ({ role: 'separator', 'aria-orientation': orientation } as const)
  return <div {...a11yProps} class={cn(BASE_CLASS, ORIENTATION_CLASS[orientation], className)} {...props} />
}
