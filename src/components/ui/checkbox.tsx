import type { ComponentChildren, InputHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'
import { Label } from './label'

type CheckboxBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children' | 'class' | 'className'>

export interface CheckboxProps extends CheckboxBase {
  // Optional inline label. When provided, the input is rendered nested
  // inside a <label>, so clicking the label text always toggles the
  // checkbox even when no `id` is supplied (HTML allows both explicit
  // `htmlFor` association and implicit nesting; we use both, which is
  // valid and resolves to the same element).
  label?: ComponentChildren
  className?: string
}

const LABEL_WRAP_CLASS = 'inline-flex items-center gap-1 cursor-pointer'

export function Checkbox({ label, id, disabled, className, ...props }: CheckboxProps) {
  const input = (
    <input
      type='checkbox'
      id={id}
      disabled={disabled}
      class={cn(
        'm-0 accent-brand',
        'cursor-pointer disabled:cursor-not-allowed',
        // Override the dialog-wide `input { border: 1px solid }` rule from
        // app.tsx that would otherwise paint a black square around the native
        // checkbox.
        'border-none',
        // Replaces the previous `.lc-ui-checkbox:focus-visible` rule from
        // styles.ts.
        'focus-visible:outline focus-visible:outline-brand focus-visible:outline-solid focus-visible:outline-offset-1',
        className
      )}
      {...props}
    />
  )

  if (label === undefined || label === null || label === false) return input

  return (
    <Label htmlFor={id} disabled={!!disabled} className={LABEL_WRAP_CLASS}>
      {input}
      {label}
    </Label>
  )
}
