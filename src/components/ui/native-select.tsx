import type { SelectHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

// `size` on a native <select> turns it into a multi-line list-box of N rows
// (e.g. <select size={5}>). Drop it from the surface API to avoid confusion
// with shadcn-style `size` props on other components.
type NativeSelectBase = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'class' | 'className'>

export interface NativeSelectProps extends NativeSelectBase {
  className?: string
}

export function NativeSelect({ disabled, className, children, ...props }: NativeSelectProps) {
  return (
    <select
      disabled={disabled}
      class={cn(
        'box-border',
        // Right-side padding leaves room for the native dropdown arrow.
        'py-px pr-1 pl-0.5',
        'rounded border border-ga4 border-solid',
        'bg-bg1 text-inherit',
        'min-h-5 leading-none outline-none',
        'cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
        'transition',
        'focus:border-brand',
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}
