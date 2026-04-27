import type { CSSProperties, TextareaHTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

type TextareaBase = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style' | 'class' | 'className'>

export interface TextareaProps extends TextareaBase {
  style?: CSSProperties
  class?: string
  className?: string
}

export function Textarea({ disabled, style, class: className, className: classNameAlt, ...props }: TextareaProps) {
  ensureUiStyles()

  const cls = ['lpc-ui-textarea', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <textarea
      disabled={disabled}
      class={cls}
      style={{
        boxSizing: 'border-box',
        padding: '6px 8px',
        border: '1px solid var(--Ga2, #ccc)',
        borderRadius: '4px',
        background: 'var(--bg1, #fff)',
        color: 'inherit',
        outline: 'none',
        fontSize: 'inherit',
        fontFamily: 'inherit',
        lineHeight: 1.4,
        resize: 'vertical',
        minHeight: '40px',
        width: '100%',
        cursor: disabled ? 'not-allowed' : 'text',
        opacity: disabled ? 0.6 : 1,
        transition: 'border-color .12s ease',
        ...style,
      }}
      {...props}
    />
  )
}
