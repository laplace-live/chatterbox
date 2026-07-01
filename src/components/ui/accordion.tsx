import type { HTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

// Optional layout-only wrapper; each AccordionItem owns its open state.

type AccordionBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'>

export interface AccordionProps extends AccordionBase {
  className?: string
}

export function Accordion({ className, children, ...props }: AccordionProps) {
  return (
    <div class={cn('flex flex-col', className)} {...props}>
      {children}
    </div>
  )
}

// Native <details>; controlled via `open`+`onOpenChange`. Undefined `open` =
// uncontrolled, but `onOpenChange` still fires.

type AccordionItemBase = Omit<HTMLAttributes<HTMLDetailsElement>, 'class' | 'className' | 'open' | 'onToggle'>

export interface AccordionItemProps extends AccordionItemBase {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
}

export function AccordionItem({ open, onOpenChange, className, children, ...props }: AccordionItemProps) {
  return (
    <details
      open={open}
      onToggle={e => {
        onOpenChange?.(e.currentTarget.open)
      }}
      class={cn(className) || undefined}
      {...props}
    >
      {children}
    </details>
  )
}

// The `[details[open]_&]:` variant compiles to `details[open] .chevron`.

type AccordionTriggerBase = Omit<HTMLAttributes<HTMLElement>, 'class' | 'className'>

export interface AccordionTriggerProps extends AccordionTriggerBase {
  className?: string
}

export function AccordionTrigger({ className, children, ...props }: AccordionTriggerProps) {
  return (
    <summary
      class={cn(
        'sticky top-0 z-10 flex items-center justify-between gap-2',
        'cursor-pointer select-none font-bold',
        'rounded-sm bg-ga1 px-1 py-0.5',
        // Hide disclosure triangle: list-none plus WebKit pseudo-element for Safari.
        'list-none',
        '[&::-webkit-details-marker]:hidden',
        className
      )}
      {...props}
    >
      <span class='min-w-0 flex-1'>{children}</span>
      <svg
        class={'shrink-0 transition-transform [details[open]_&]:rotate-180'}
        xmlns='http://www.w3.org/2000/svg'
        width='12'
        height='12'
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        stroke-width='3'
        stroke-linecap='round'
        stroke-linejoin='round'
        aria-hidden='true'
      >
        <path d='m6 9 6 6 6-6' />
      </svg>
    </summary>
  )
}

// Separate body wrapper so consumers can add padding/spacing in one place.

type AccordionContentBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'>

export interface AccordionContentProps extends AccordionContentBase {
  className?: string
}

export function AccordionContent({ className, children, ...props }: AccordionContentProps) {
  return (
    <div class={cn(className) || undefined} {...props}>
      {children}
    </div>
  )
}
