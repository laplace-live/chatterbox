import type { ComponentChildren, CSSProperties, HTMLAttributes } from 'preact'

import { ensureUiStyles } from './styles'

// === Accordion ============================================================
//
// Optional outer wrapper for grouping multiple AccordionItems vertically.
// Each AccordionItem manages its own open state; the wrapper is purely
// layout. For a single collapsible panel, use AccordionItem directly.

type AccordionBase = Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'class' | 'className'>

export interface AccordionProps extends AccordionBase {
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function Accordion({ style, class: className, className: classNameAlt, children, ...props }: AccordionProps) {
  ensureUiStyles()
  const cls = ['lpc-ui-accordion', className, classNameAlt].filter(Boolean).join(' ')
  return (
    <div class={cls} style={{ display: 'flex', flexDirection: 'column', ...style }} {...props}>
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

type AccordionItemBase = Omit<HTMLAttributes<HTMLDetailsElement>, 'style' | 'class' | 'className' | 'open' | 'onToggle'>

export interface AccordionItemProps extends AccordionItemBase {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function AccordionItem({
  open,
  onOpenChange,
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: AccordionItemProps) {
  ensureUiStyles()
  const cls = ['lpc-ui-accordion-item', className, classNameAlt].filter(Boolean).join(' ')
  return (
    <details
      open={open}
      onToggle={e => {
        onOpenChange?.(e.currentTarget.open)
      }}
      class={cls}
      style={style}
      {...props}
    >
      {children}
    </details>
  )
}

// === AccordionTrigger =====================================================
//
// Renders a <summary> with the children on the left and a chevron on the
// right. The chevron rotates 180° when the parent <details> is open via the
// CSS rule injected by ensureUiStyles().

type AccordionTriggerBase = Omit<HTMLAttributes<HTMLElement>, 'style' | 'class' | 'className'>

export interface AccordionTriggerProps extends AccordionTriggerBase {
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function AccordionTrigger({
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: AccordionTriggerProps) {
  ensureUiStyles()
  const cls = ['lpc-ui-accordion-trigger', className, classNameAlt].filter(Boolean).join(' ')
  return (
    <summary
      class={cls}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '.5em',
        cursor: 'pointer',
        userSelect: 'none',
        fontWeight: 'bold',
        background: 'var(--Ga1, #eee)',
        padding: '2px 4px',
        borderRadius: '2px',
        // Belt-and-suspenders with the CSS rule: hides the default
        // disclosure triangle in browsers that respect `list-style: none`.
        listStyle: 'none',
        ...style,
      }}
      {...props}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      <svg
        class='lpc-ui-accordion-chevron'
        xmlns='http://www.w3.org/2000/svg'
        width='12'
        height='12'
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        stroke-width='3'
        stroke-linecap='round'
        stroke-linejoin='round'
        style={{ flexShrink: 0, transition: 'transform .15s ease' }}
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

type AccordionContentBase = Omit<HTMLAttributes<HTMLDivElement>, 'style' | 'class' | 'className'>

export interface AccordionContentProps extends AccordionContentBase {
  style?: CSSProperties
  class?: string
  className?: string
  children?: ComponentChildren
}

export function AccordionContent({
  style,
  class: className,
  className: classNameAlt,
  children,
  ...props
}: AccordionContentProps) {
  ensureUiStyles()
  const cls = ['lpc-ui-accordion-content', className, classNameAlt].filter(Boolean).join(' ')
  return (
    <div class={cls} style={style} {...props}>
      {children}
    </div>
  )
}
