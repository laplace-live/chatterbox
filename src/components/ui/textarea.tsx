import type { TextareaHTMLAttributes } from 'preact'
import { forwardRef } from 'preact/compat'

import { cn } from '../../lib/cn'

type TextareaBase = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'class' | 'className'>

export interface TextareaProps extends TextareaBase {
  className?: string
}

// Wrapped in `forwardRef` so consumers (e.g. LogPanel's auto-scroll
// useEffect) can attach a ref to the underlying <textarea>. Preact 10
// strips `ref` from the props of a plain function component during
// `createElement`, so without forwardRef the ref silently never reaches
// the DOM and `ref.current` stays null.
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { disabled, className, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      disabled={disabled}
      class={cn(
        'lc:box-border lc:w-full',
        'lc:px-1 lc:py-0.5',
        'lc:border lc:border-solid lc:border-ga4 lc:rounded',
        'lc:bg-bg1 lc:text-inherit',
        'lc:outline-none lc:leading-[1.4]',
        'lc:resize-y lc:min-h-10',
        'lc:cursor-text lc:disabled:cursor-not-allowed lc:disabled:opacity-60',
        'lc:transition',
        'lc:focus:border-brand',
        className
      )}
      {...props}
    />
  )
})
