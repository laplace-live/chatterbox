import type { TextareaHTMLAttributes } from 'preact'
import { forwardRef } from 'preact/compat'

import { cn } from '../../lib/cn'

type TextareaBase = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'class' | 'className'>

export interface TextareaProps extends TextareaBase {
  className?: string
}

// forwardRef required: Preact 10 strips `ref` from plain function components, so the ref never reaches the DOM without it.
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { disabled, className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      disabled={disabled}
      class={cn(
        'box-border w-full',
        'px-1 py-0.5',
        'rounded border border-ga4 border-solid',
        'bg-bg1 text-inherit',
        'leading-[1.4] outline-none',
        'min-h-10 resize-y',
        'cursor-text disabled:cursor-not-allowed disabled:opacity-60',
        'transition',
        'focus:border-brand',
        className
      )}
      {...props}
    />
  )
})
