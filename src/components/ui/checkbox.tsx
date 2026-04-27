import type { ComponentChildren, CSSProperties, InputHTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

type CheckboxBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children' | 'style' | 'class' | 'className'>

export interface CheckboxProps extends CheckboxBase {
  // Optional inline label. When provided, the checkbox is wrapped in a
  // <span> with a sibling <label htmlFor={id}>, mirroring the
  // span/input/label triplet used elsewhere in this codebase.
  label?: ComponentChildren
  style?: CSSProperties
  class?: string
  className?: string
}

export function Checkbox({
  label,
  id,
  disabled,
  style,
  class: className,
  className: classNameAlt,
  ...props
}: CheckboxProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-checkbox', className, classNameAlt].filter(Boolean).join(' ')

  const input = (
    <input
      type='checkbox'
      id={id}
      disabled={disabled}
      class={cls}
      style={{
        accentColor: '#36a185',
        cursor: disabled ? 'not-allowed' : 'pointer',
        margin: 0,
        // Override the dialog-wide `input { border: 1px solid }` rule that
        // would otherwise paint a black square around the native checkbox.
        border: 'none',
        ...style,
      }}
      {...props}
    />
  )

  if (label === undefined || label === null || label === false) return input

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '.25em' }}>
      {input}
      <label
        htmlFor={id}
        style={{
          cursor: disabled ? 'not-allowed' : 'pointer',
          color: disabled ? '#999' : undefined,
          userSelect: 'none',
        }}
      >
        {label}
      </label>
    </span>
  )
}
