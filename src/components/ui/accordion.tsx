import type { HTMLAttributes } from 'preact'

import { cn } from '../../lib/cn'

// === Accordion ============================================================
//
// Optional outer wrapper for grouping multiple AccordionItems vertically.
// Each AccordionItem manages its own open state; the wrapper is purely
// layout. For a single collapsible panel, use AccordionItem directly.

type AccordionBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'>

export interface AccordionProps extends AccordionBase {
  className?: string
}

export function Accordion({ className, children, ...props }: AccordionProps) {
  return (
    <div class={cn('lc-flex lc-flex-col', className)} {...props}>
      {children}
    </div>
  )
}

// === AccordionItem ========================================================
//
// Renders a native <details> element. Controlled via `open` + `onOpenChange`
// — the existing codebase pattern of a Signal-backed boolean maps to it as
// `<AccordionItem open={sig.value} onOpenChange={v => sig.value = v}>`.
// If `open` is undefined the element is uncontrolled (browser handles the
// toggle, `onOpenChange` still fires).

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

// === AccordionTrigger =====================================================
//
// Renders a <summary> with the children on the left and a chevron on the
// right. The chevron rotates 180° when the parent <details> has the `open`
// attribute, expressed as the arbitrary variant `[details[open]_&]:` —
// which compiles to the CSS selector `details[open] .chevron`.

type AccordionTriggerBase = Omit<HTMLAttributes<HTMLElement>, 'class' | 'className'>

export interface AccordionTriggerProps extends AccordionTriggerBase {
  className?: string
}

export function AccordionTrigger({ className, children, ...props }: AccordionTriggerProps) {
  return (
    <summary
      class={cn(
        'lc-flex lc-items-center lc-justify-between lc-gap-2',
        'lc-cursor-pointer lc-select-none lc-font-bold',
        'lc-bg-ga1 lc-px-1 lc-py-0.5 lc-rounded-sm',
        // Hide the disclosure triangle two ways: `list-style: none` for browsers
        // that respect it, and the WebKit-specific pseudo-element for Safari.
        'lc-list-none',
        '[&::-webkit-details-marker]:lc-hidden',
        className
      )}
      {...props}
    >
      <span class='lc-flex-1 lc-min-w-0'>{children}</span>
      <svg
        class={'lc-shrink-0 lc-transition-transform [details[open]_&]:lc-rotate-180'}
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

// === AccordionContent =====================================================
//
// Plain wrapper for the body. Kept as a separate component so consumers can
// add padding / spacing in one place if they want, without touching the
// trigger.

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
