import type { LabelHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

type LabelBase = Omit<LabelHTMLAttributes<HTMLLabelElement>, 'class' | 'className'>

export interface LabelProps extends LabelBase {
  // Explicit (not `peer-disabled`) because our checkbox nests the input inside the label.
  disabled?: boolean
  className?: string
}

export function Label({ disabled, htmlFor, for: forProp, className, children, ...props }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor ?? forProp}
      class={cn(
        'shrink-0 select-none leading-none',
        // `!` so disabled wins over any cursor set by consumers via `className`.
        disabled && 'cursor-not-allowed! text-ga4',
        className
      )}
      {...props}
    >
      {children}
    </label>
  )
}
