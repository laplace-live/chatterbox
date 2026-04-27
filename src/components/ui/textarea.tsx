import type { CSSProperties, TextareaHTMLAttributes } from 'preact'
import { forwardRef } from 'preact/compat'

import { ensureUiStyles } from './styles'

type TextareaBase = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style' | 'class' | 'className'>

export interface TextareaProps extends TextareaBase {
  style?: CSSProperties
  class?: string
  className?: string
}

// Wrapped in `forwardRef` so consumers (e.g. LogPanel's auto-scroll
// useEffect) can attach a ref to the underlying <textarea>. Preact 10
// strips `ref` from the props of a plain function component during
// `createElement`, so without forwardRef the ref silently never reaches
// the DOM and `ref.current` stays null.
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { disabled, style, class: className, className: classNameAlt, ...props },
  ref
) {
  ensureUiStyles()

  const cls = ['lpc-ui-textarea', className, classNameAlt].filter(Boolean).join(' ')

  return (
    <textarea
      ref={ref}
      disabled={disabled}
      class={cls}
      style={{
        boxSizing: 'border-box',
        padding: '2px 4px',
        border: '1px solid var(--Ga4, #999)',
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
})
