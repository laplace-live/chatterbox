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
        'lc-box-border',
        'lc-px-1 lc-py-px',
        'lc-border lc-border-solid lc-border-ga4 lc-rounded',
        'lc-bg-bg1 lc-text-inherit',
        'lc-outline-none lc-leading-none lc-min-h-5',
        'lc-cursor-text disabled:lc-cursor-not-allowed disabled:lc-opacity-60',
        'lc-transition',
        // Replaces the previous `.lc-ui-input:focus { border-color: ... }` rule
        // from styles.ts.
        'focus:lc-border-brand',
        className
      )}
      {...props}
    />
  )
}
