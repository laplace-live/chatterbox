import type { InputHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

// Drop native `size` (character-count attr) to avoid clashing with shadcn-style `size` props.
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
        'focus:border-brand',
        className
      )}
      {...props}
    />
  )
}
