import { cn } from 'cn'
import type { TextareaHTMLAttributes } from 'preact'

type TextareaBase = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'class' | 'className'>

export interface TextareaProps extends TextareaBase {
  className?: string
}

export function Textarea({ disabled, className, ...props }: TextareaProps) {
  return (
    <textarea
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
}
