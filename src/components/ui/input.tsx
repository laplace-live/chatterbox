import type { CSSProperties, InputHTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

// `size` on a native <input> is the rendered character-count attribute (e.g.
// <input size={20}>). Drop it from the surface API to avoid confusion with
// shadcn-style `size` props on other components.
type InputBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'style' | 'class' | 'className'>

export interface InputProps extends InputBase {
  style?: CSSProperties
  class?: string
  className?: string
}

export function Input({
  type = 'text',
  disabled,
  style,
  class: className,
  className: classNameAlt,
  ...props
}: InputProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-input', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <input
      type={type}
      disabled={disabled}
      class={cls}
      style={{
        boxSizing: 'border-box',
        padding: '4px 8px',
        border: '1px solid var(--Ga2, #ccc)',
        borderRadius: '4px',
        background: 'var(--bg1, #fff)',
        color: 'inherit',
        outline: 'none',
        fontSize: 'inherit',
        fontFamily: 'inherit',
        lineHeight: 1.2,
        minHeight: '24px',
        cursor: disabled ? 'not-allowed' : 'text',
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
        ...style,
      }}
      {...props}
    />
  )
}
