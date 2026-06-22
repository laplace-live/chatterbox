import type { ButtonHTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

export type ButtonVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link'
export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon'

// `class` is omitted to forbid the React-style `class={...}` form (consumers
// must use `className`). `className` is omitted from the base and re-declared
// as plain `string` so it can flow into cn() — the inherited Preact type is
// `Signalish<string | undefined>` which clsx/tailwind-merge can't handle.
// `style` keeps its inherited Signalish typing; we just forward it.
type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'class' | 'className'>

export interface ButtonProps extends ButtonBase {
  variant?: ButtonVariant
  size?: ButtonSize
  className?: string
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-1.5 py-px min-h-[18px]',
  default: 'px-2.5 py-1 min-h-6',
  lg: 'px-3.5 py-1.5 min-h-7',
  icon: 'p-0 w-6 h-6',
}

// All variants set `border` + `border-solid` explicitly because preflight
// is disabled — without the style declaration the width-only `border`
// utility wouldn't render anything.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: 'bg-brand text-white border border-solid border-brand',
  secondary: 'bg-ga1s text-inherit border border-solid border-ga4',
  destructive: 'bg-transparent text-danger border border-solid border-danger',
  outline: 'bg-transparent text-inherit border border-solid border-ga4',
  ghost: 'bg-transparent text-inherit border border-solid border-transparent',
  // `p-0` / `min-h-[auto]` win over the size class's `px-2.5 py-1
  // min-h-6` because cn() (tailwind-merge) recognises `p` as superseding
  // `px`/`py`, and `min-h` as a single group where last wins.
  link: 'bg-transparent text-link border border-solid border-transparent underline underline-offset-2 p-0 min-h-[auto]',
}

export function Button({
  variant = 'default',
  size = 'default',
  type = 'button',
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      class={cn(
        'inline-flex items-center justify-center shadow-sm',
        'gap-1 rounded',
        'cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
        'leading-[1.2]',
        'box-border select-none whitespace-nowrap',
        'transition',
        '[&:not(:disabled):hover]:brightness-[.96]',
        '[&:not(:disabled):active]:brightness-[.9]',
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className
      )}
      data-variant={variant}
      data-size={size}
      {...props}
    >
      {children}
    </button>
  )
}
