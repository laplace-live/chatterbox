import type { ComponentChildren, CSSProperties, SelectHTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

// `size` on a native <select> turns it into a multi-line list-box of N rows
// (e.g. <select size={5}>). Drop it from the surface API to avoid confusion
// with shadcn-style `size` props on other components.
type NativeSelectBase = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'style' | 'class' | 'className'>

export interface NativeSelectProps extends NativeSelectBase {
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function NativeSelect({
  disabled,
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: NativeSelectProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-select', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <select
      disabled={disabled}
      class={cls}
      style={{
        boxSizing: 'border-box',
        // Right-side padding leaves room for the native dropdown arrow.
        padding: '1px 4px 1px 2px',
        border: '1px solid var(--Ga4, #999)',
        borderRadius: '4px',
        background: 'var(--bg1, #fff)',
        color: 'inherit',
        outline: 'none',
        fontSize: 'inherit',
        fontFamily: 'inherit',
        lineHeight: 1,
        minHeight: '20px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
        ...style,
      }}
      {...props}
    >
      {children}
    </select>
  )
}
