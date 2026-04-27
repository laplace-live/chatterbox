import type { ButtonHTMLAttributes, ComponentChildren, CSSProperties } from 'preact'

import { ensureUiStyles } from './styles'

export type ButtonVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link'
export type ButtonSize = 'sm' | 'default' | 'lg' | 'icon'

// `style` is narrowed from Preact's `Signalish<string | CSSProperties>` to a
// plain object so we can spread our defaults in. `class` is narrowed similarly
// for the same reason. Consumers needing a Signal-driven style/class can wrap
// the component themselves.
type ButtonBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'style' | 'class' | 'className'>

export interface ButtonProps extends ButtonBase {
  variant?: ButtonVariant
  size?: ButtonSize
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

const SIZE_STYLES: Record<ButtonSize, CSSProperties> = {
  sm: { padding: '1px 6px', minHeight: '18px' },
  default: { padding: '4px 10px', minHeight: '24px' },
  lg: { padding: '6px 14px', minHeight: '28px' },
  icon: { padding: '0', width: '24px', height: '24px' },
}

const VARIANT_STYLES: Record<ButtonVariant, CSSProperties> = {
  default: {
    background: '#36a185',
    color: '#fff',
    border: '1px solid #36a185',
  },
  secondary: {
    background: 'var(--Ga1_s, rgba(0,0,0,.04))',
    color: 'inherit',
    border: '1px solid var(--Ga4, #999)',
  },
  destructive: {
    background: 'transparent',
    color: '#d44',
    border: '1px solid #d44',
  },
  outline: {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid var(--Ga4, #999)',
  },
  ghost: {
    background: 'transparent',
    color: 'inherit',
    border: '1px solid transparent',
  },
  link: {
    background: 'transparent',
    color: '#288bb8',
    border: '1px solid transparent',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
    padding: '0',
    minHeight: 'auto',
  },
}

export function Button({
  variant = 'default',
  size = 'default',
  type = 'button',
  disabled,
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: ButtonProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-button', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <button
      type={type}
      disabled={disabled}
      class={cls}
      data-variant={variant}
      data-size={size}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '.25em',
        borderRadius: '4px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: 'inherit',
        fontFamily: 'inherit',
        lineHeight: 1.2,
        userSelect: 'none',
        whiteSpace: 'nowrap',
        boxSizing: 'border-box',
        transition: 'filter .12s ease',
        ...SIZE_STYLES[size],
        ...VARIANT_STYLES[variant],
        ...style,
      }}
      {...props}
    >
      {children}
    </button>
  )
}
