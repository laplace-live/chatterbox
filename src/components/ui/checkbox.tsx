import type { ComponentChildren, CSSProperties, InputHTMLAttributes } from 'preact'

import { Label } from './label'
import { ensureUiStyles } from './styles'

type CheckboxBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children' | 'style' | 'class' | 'className'>

export interface CheckboxProps extends CheckboxBase {
  // Optional inline label. When provided, the input is rendered nested
  // inside a <label>, so clicking the label text always toggles the
  // checkbox even when no `id` is supplied (HTML allows both explicit
  // `htmlFor` association and implicit nesting; we use both, which is
  // valid and resolves to the same element).
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
    <Label
      htmlFor={id}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '.25em',
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: disabled ? '#999' : undefined,
        userSelect: 'none',
      }}
    >
      {input}
      {label}
    </Label>
  )
}
