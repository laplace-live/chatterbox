import type { LabelHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

type LabelBase = Omit<LabelHTMLAttributes<HTMLLabelElement>, 'class' | 'className'>

export interface LabelProps extends LabelBase {
  // When true, grays out the label text and applies a not-allowed cursor.
  // shadcn solves this with a `peer-disabled` Tailwind utility tied to the
  // sibling input's :disabled state, but our checkbox nests the input
  // inside the label, so consumers pass it explicitly here.
  disabled?: boolean
  className?: string
}

export function Label({ disabled, htmlFor, for: forProp, className, children, ...props }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor ?? forProp}
      class={cn(
        'lc:select-none lc:leading-none lc:shrink-0',
        // `!` ensures the disabled state wins over any cursor set by consumers
        // via `className` (e.g. Checkbox's wrapper sets `cursor-pointer` when
        // the input is interactive).
        disabled && 'lc:cursor-not-allowed! lc:text-ga4',
        className
      )}
      {...props}
    >
      {children}
    </label>
  )
}
