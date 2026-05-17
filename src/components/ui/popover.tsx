import type { ComponentChildren, VNode } from 'preact'
import { cloneElement, createContext, isValidElement } from 'preact'
import { useContext, useEffect, useRef } from 'preact/hooks'

import { cn } from '../../lib/cn'

// === Popover ============================================================
//
// shadcn-style compound popover. <Popover> sets up a relative-positioned
// wrapper that contains both the trigger and the content; <PopoverContent>
// is absolutely positioned against that wrapper so it floats next to the
// trigger.
//
// Layout caveat: same as Combobox — the popover is positioned absolutely
// against the wrapper. Inside the floating Configurator panel the dialog
// itself is `overflow-hidden` (optimized) / `overflow-y-auto` (legacy),
// so a popover that overflows the dialog edges will be clipped. Pick
// `side` / `align` to give the content room within the dialog bounds, or
// constrain the content's own size.

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  // Wrapper bounds drive outside-click detection — a click is "inside"
  // when it lands anywhere in here (trigger OR content), so clicking
  // the trigger to toggle and clicking content rows both stay open
  // unless they explicitly close themselves.
  wrapperRef: { current: HTMLDivElement | null }
}

const PopoverContext = createContext<PopoverContextValue | null>(null)

function usePopover(): PopoverContextValue {
  const ctx = useContext(PopoverContext)
  if (!ctx) throw new Error('Popover.* must be used inside <Popover>')
  return ctx
}

export interface PopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ComponentChildren
  className?: string
}

export function Popover({ open, onOpenChange, className, children }: PopoverProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  return (
    <PopoverContext.Provider value={{ open, setOpen: onOpenChange, wrapperRef }}>
      {/* `relative` establishes the positioning context for
          PopoverContent's absolute layout AND the bounding box for the
          outside-click test. `inline-block` keeps the wrapper inline so
          a Popover sitting inside a flex / inline row doesn't break the
          row's layout. */}
      <div ref={wrapperRef} class={cn('relative inline-block', className)}>
        {children}
      </div>
    </PopoverContext.Provider>
  )
}

// === PopoverTrigger =====================================================
//
// Clones its single element child to inject an onClick that toggles the
// popover. Any existing onClick on the child is preserved and runs first,
// so a consumer keeping their own click behaviour (analytics, focus
// management, etc.) still gets it on top of the toggle.

export interface PopoverTriggerProps {
  children: VNode
}

export function PopoverTrigger({ children }: PopoverTriggerProps) {
  const { open, setOpen } = usePopover()
  if (!isValidElement(children)) return children as unknown as VNode

  const originalOnClick = (children.props as { onClick?: (e: MouseEvent) => void } | null)?.onClick

  // cloneElement's prop typing is `Partial<P>` which we can't statically
  // satisfy across arbitrary VNodes — the `as Record<string, unknown>`
  // cast tells TS "trust me, this prop name is universally accepted on
  // HTMLElement-shaped children". Function-component children that don't
  // forward onClick will silently swallow the toggle; for those, prefer
  // the controlled form (own the `open` signal at the call site and pass
  // `onClick` directly).
  return cloneElement(children, {
    onClick: (e: MouseEvent) => {
      if (typeof originalOnClick === 'function') originalOnClick(e)
      setOpen(!open)
    },
  } as Record<string, unknown>)
}

// === PopoverContent =====================================================
//
// Absolute-positioned content shown when `open` is true. Outside-click
// (mousedown anywhere outside the Popover wrapper) and Escape both close.

export type PopoverSide = 'top' | 'bottom'
export type PopoverAlign = 'start' | 'center' | 'end'

export interface PopoverContentProps {
  children: ComponentChildren
  /** Which vertical edge of the trigger the popover sits beside. */
  side?: PopoverSide
  /** How the popover is aligned along the horizontal axis. */
  align?: PopoverAlign
  className?: string
}

export function PopoverContent({ children, side = 'bottom', align = 'start', className }: PopoverContentProps) {
  const { open, setOpen, wrapperRef } = usePopover()

  // mousedown (not click) so a gesture that ends in a drag-select doesn't
  // swallow the close — matches the Combobox close behaviour for
  // consistency across the dialog.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // composedPath() pierces shadow-DOM boundaries; e.target alone is
      // retargeted to the shadow host on a document-level listener and
      // would incorrectly fire "outside" for clicks inside the popover.
      const wrapper = wrapperRef.current
      if (wrapper && !e.composedPath().includes(wrapper)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!open) return null

  // top:    popover sits ABOVE the trigger (its bottom edge meets the trigger's top).
  // bottom: popover sits BELOW the trigger (its top edge meets the trigger's bottom).
  const sideClass = side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
  // start:  popover's left edge aligns with the trigger's left edge.
  // end:    popover's right edge aligns with the trigger's right edge.
  // center: popover is centered horizontally on the trigger.
  const alignClass = align === 'end' ? 'right-0' : align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'

  return (
    <div
      role='dialog'
      class={cn(
        'absolute z-50',
        sideClass,
        alignClass,
        'rounded border border-ga3 border-solid',
        'bg-bg1',
        'shadow-[0_4px_12px_rgba(0,0,0,.15)]',
        'overflow-hidden',
        className
      )}
    >
      {children}
    </div>
  )
}
