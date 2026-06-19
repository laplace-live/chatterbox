import type { ComponentChildren, VNode } from 'preact'
import { cloneElement, createContext, isValidElement } from 'preact'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { cn } from '../../lib/cn'
import {
  computePopoverPosition,
  type PopoverAlign,
  type PopoverPlacement,
  type PopoverSide,
} from '../../lib/popover-position'

// === Popover ============================================================
//
// shadcn-style compound popover. <Popover> sets up a relative-positioned
// wrapper that contains both the trigger and the content. <PopoverContent>
// renders as `position: fixed`, with its coordinates computed from the
// trigger's bounding rect (see `computePopoverPosition`).
//
// Why fixed and not absolute: inside the Configurator panel the dialog is
// `overflow-hidden` (optimized) / `overflow-y-auto` (legacy). An absolutely
// positioned child is clipped by that overflow, so a popover near the
// dialog's top or bottom edge gets cut off. A fixed element's containing
// block is the viewport — the dialog is itself `fixed` and sets no
// transform/filter, so it never becomes a containing block for fixed
// descendants — so the content escapes the clip. It still inherits the
// dialog's CSS vars (e.g. `--laplace-chatterbox-dialog-width`) because it
// stays in the DOM tree; only its positioning scheme changes. The
// positioner flips sides and caps height to keep it on screen.

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
// Fixed-positioned content shown when `open` is true. Coordinates are
// computed from the trigger's rect so it escapes the Configurator dialog's
// `overflow` clip instead of being cut off near the dialog's edges.
// Outside-click (mousedown anywhere outside the Popover wrapper) and Escape
// both close.

export type { PopoverAlign, PopoverSide }

export interface PopoverContentProps {
  children: ComponentChildren
  /** Which vertical edge of the trigger the popover sits beside. */
  side?: PopoverSide
  /** How the popover is aligned along the horizontal axis. */
  align?: PopoverAlign
  /**
   * Stretch the content to the trigger's measured width — for select-style
   * popovers (Combobox) whose dropdown lines up under the trigger instead of
   * sizing to its own content.
   */
  matchTriggerWidth?: boolean
  className?: string
}

export function PopoverContent({
  children,
  side = 'bottom',
  align = 'start',
  matchTriggerWidth,
  className,
}: PopoverContentProps) {
  const { open, setOpen, wrapperRef } = usePopover()
  const contentRef = useRef<HTMLDivElement>(null)
  // Computed fixed-position box. `null` until the first measure pass runs —
  // during that pass the content renders hidden (it must be in the DOM to be
  // measured) so it never flashes at the wrong spot.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  // Trigger-matched width (px) when `matchTriggerWidth` is set, else null
  // (content sizes itself). Kept apart from `placement` so the pure geometry
  // stays width-agnostic.
  const [width, setWidth] = useState<number | null>(null)

  // mousedown (not click) so a gesture that ends in a drag-select doesn't
  // swallow the close — matches the Combobox close behaviour for
  // consistency across the dialog.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // composedPath() pierces shadow-DOM boundaries; e.target alone is
      // retargeted to the shadow host on a document-level listener and
      // would incorrectly fire "outside" for clicks inside the popover.
      // The content is `fixed` but still a DOM descendant of the wrapper,
      // so it stays "inside" for this test.
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

  // Measure the trigger + content and place the fixed box. While open it
  // re-runs on scroll (capture phase, so the dialog's INNER panel scroll
  // counts too — not just window scroll), window resize, and content resize
  // (async data loading in, switching emote packages) so the popover stays
  // glued to its trigger. useLayoutEffect so the first placement lands
  // before paint.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const reposition = () => {
      const wrapper = wrapperRef.current
      const content = contentRef.current
      if (!wrapper || !content) return
      // The wrapper is `inline-block` around the trigger and the fixed
      // content is out of flow, so the wrapper's rect IS the trigger's rect.
      const t = wrapper.getBoundingClientRect()
      // offsetWidth / scrollHeight report the content's NATURAL size,
      // independent of the maxHeight cap applied below — so re-measuring
      // never feeds the clamped height back into the computation.
      // When matching the trigger width, feed that width in as the content
      // width so horizontal alignment/clamping reflect the width we'll apply.
      const contentWidth = matchTriggerWidth ? t.width : content.offsetWidth
      const next = computePopoverPosition(
        { top: t.top, left: t.left, width: t.width, height: t.height },
        { width: contentWidth, height: content.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { side, align }
      )
      setPlacement(prev =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight &&
        prev.side === next.side
          ? prev
          : next
      )
      setWidth(matchTriggerWidth ? t.width : null)
    }
    reposition()

    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(reposition)
    }
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    const observer = new ResizeObserver(schedule)
    if (contentRef.current) observer.observe(contentRef.current)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      observer.disconnect()
    }
  }, [open, side, align, matchTriggerWidth])

  if (!open) return null

  return (
    <div
      ref={contentRef}
      role='dialog'
      class={cn(
        // Fixed (not absolute) so the dialog's overflow can't clip us; the
        // positioner keeps us inside the viewport. overflow-y-auto lets a
        // popover taller than the available space scroll rather than
        // overflow the screen; overflow-x stays hidden for the rounded edge.
        'fixed z-50',
        'rounded ring ring-ga6/30',
        'bg-bg1',
        'shadow-md',
        'overflow-y-auto overflow-x-hidden',
        className
      )}
      style={
        placement
          ? {
              left: `${placement.left}px`,
              top: `${placement.top}px`,
              maxHeight: `${placement.maxHeight}px`,
              ...(width !== null ? { width: `${width}px` } : null),
            }
          : { visibility: 'hidden' }
      }
    >
      {children}
    </div>
  )
}
