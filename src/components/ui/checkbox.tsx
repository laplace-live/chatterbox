import type { ComponentChildren, InputHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'
import { Label } from './label'

type CheckboxBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children' | 'class' | 'className'>

export interface CheckboxProps extends CheckboxBase {
  // Inline label; nested in <label> so clicks toggle even without an `id`.
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
        // Override app.tsx's dialog-wide `input { border }` that boxes the checkbox.
        'border-none',
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
