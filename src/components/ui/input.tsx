import type { InputHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

// `size` on a native <input> is the rendered character-count attribute (e.g.
// <input size={20}>). Drop it from the surface API to avoid confusion with
// shadcn-style `size` props on other components.
type InputBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'class' | 'className'>

export interface InputProps extends InputBase {
  className?: string
}

export function Input({ type = 'text', disabled, className, ...props }: InputProps) {
  return (
    <input
      type={type}
      disabled={disabled}
      class={cn(
        'box-border',
        'px-1 py-px',
        'rounded border border-ga4 border-solid',
        'bg-bg1 text-inherit',
        'min-h-5 leading-none outline-none',
        'cursor-text disabled:cursor-not-allowed disabled:opacity-60',
        'transition',
        // Replaces the previous `.lc-ui-input:focus { border-color: ... }` rule
        // from styles.ts.
        'focus:border-brand',
        className
      )}
      {...props}
    />
  )
}
