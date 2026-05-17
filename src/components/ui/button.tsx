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

// Base classes shared by every variant/size. The hover/active brightness
// previously lived in styles.ts as `:not(:disabled):hover { filter: ... }`;
// we now express that via the arbitrary-selector variant so disabled
// buttons stay un-darkened automatically.
const BASE_CLASS = [
  'lc:inline-flex lc:items-center lc:justify-center',
  'lc:gap-1 lc:rounded',
  'lc:cursor-pointer lc:disabled:cursor-not-allowed lc:disabled:opacity-50',
  'lc:leading-[1.2]',
  'lc:select-none lc:whitespace-nowrap lc:box-border',
  'lc:transition',
  'lc:[&:not(:disabled):hover]:brightness-[.96]',
  'lc:[&:not(:disabled):active]:brightness-[.9]',
].join(' ')

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'lc:px-1.5 lc:py-px lc:min-h-[18px]',
  default: 'lc:px-2.5 lc:py-1 lc:min-h-6',
  lg: 'lc:px-3.5 lc:py-1.5 lc:min-h-7',
  icon: 'lc:p-0 lc:w-6 lc:h-6',
}

// All variants set `border` + `border-solid` explicitly because preflight
// is disabled — without the style declaration the width-only `border`
// utility wouldn't render anything.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: 'lc:bg-brand lc:text-white lc:border lc:border-solid lc:border-brand',
  secondary: 'lc:bg-ga1s lc:text-inherit lc:border lc:border-solid lc:border-ga4',
  destructive: 'lc:bg-transparent lc:text-danger lc:border lc:border-solid lc:border-danger',
  outline: 'lc:bg-transparent lc:text-inherit lc:border lc:border-solid lc:border-ga4',
  ghost: 'lc:bg-transparent lc:text-inherit lc:border lc:border-solid lc:border-transparent',
  // `lc:p-0` / `lc:min-h-[auto]` win over the size class's `lc:px-2.5 lc:py-1
  // lc:min-h-6` because cn() (tailwind-merge) recognises `p` as superseding
  // `px`/`py`, and `min-h` as a single group where last wins.
  link: 'lc:bg-transparent lc:text-link lc:border lc:border-solid lc:border-transparent lc:underline lc:underline-offset-2 lc:p-0 lc:min-h-[auto]',
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
      class={cn(BASE_CLASS, SIZE_CLASS[size], VARIANT_CLASS[variant], className)}
      data-variant={variant}
      data-size={size}
      {...props}
    >
      {children}
    </button>
  )
}
