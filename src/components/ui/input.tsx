import { cn } from 'cn'
import type { InputHTMLAttributes } from 'preact'

type TextInputType = 'text' | 'password' | 'number' | 'email' | 'url' | 'search' | 'tel'

// Drop native `size` (character-count attr) to avoid clashing with shadcn-style `size` props.
type InputBase = Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'class' | 'className' | 'type' | 'role'>

export interface InputProps extends InputBase {
  type?: TextInputType
  className?: string
}

// One object per literal: Preact 11's per-`type` `<input>` union rejects a union-typed `type`.
type TypedInput = { [K in TextInputType]: { type: K } }[TextInputType]

export function Input({ type = 'text', disabled, className, ...props }: InputProps) {
  const typed: TypedInput = { type }
  return (
    <input
      {...typed}
      disabled={disabled}
      class={cn(
        'box-border',
        'px-1 py-px',
        'rounded border border-ga4 border-solid',
        'bg-bg1 text-inherit',
        'min-h-5 leading-none outline-none',
        'cursor-text disabled:cursor-not-allowed disabled:opacity-60',
        'transition',
        'focus:border-brand',
        className
      )}
      {...props}
    />
  )
}
