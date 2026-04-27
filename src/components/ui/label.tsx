import type { ComponentChildren, CSSProperties, LabelHTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

type LabelBase = Omit<LabelHTMLAttributes<HTMLLabelElement>, 'style' | 'class' | 'className'>

export interface LabelProps extends LabelBase {
  // When true, grays out the label text and applies a not-allowed cursor.
  // shadcn solves this with a `peer-disabled` Tailwind utility tied to the
  // sibling input's :disabled state, but inline styles can't read sibling
  // state, so consumers pass it explicitly here.
  disabled?: boolean
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function Label({
  disabled,
  htmlFor,
  for: forProp,
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: LabelProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-label', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <label
      htmlFor={htmlFor ?? forProp}
      class={cls}
      style={{
        cursor: disabled ? 'not-allowed' : 'inherit',
        color: disabled ? '#999' : undefined,
        userSelect: 'none',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 1,
        flexShrink: 0,
        ...style,
      }}
      {...props}
    >
      {children}
    </label>
  )
}
