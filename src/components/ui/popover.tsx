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

// shadcn-style compound popover. PopoverContent is `position: fixed` (not
// absolute) so it escapes the Configurator dialog's `overflow` clip near the
// dialog's edges; the dialog sets no transform/filter so the viewport stays
// the containing block. It still inherits the dialog's CSS vars via the DOM tree.

interface PopoverContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  // Bounds for outside-click detection: a click anywhere inside (trigger OR
  // content) counts as "inside" and stays open.
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
      {/* `inline-block` so a Popover inside a flex/inline row doesn't break the row's layout. */}
      <div ref={wrapperRef} class={cn('relative inline-block', className)}>
        {children}
      </div>
    </PopoverContext.Provider>
  )
}

// Clones its element child to inject a toggle onClick; any existing onClick is
// preserved and runs first.

export interface PopoverTriggerProps {
  children: VNode
}

export function PopoverTrigger({ children }: PopoverTriggerProps) {
  const { open, setOpen } = usePopover()
  if (!isValidElement(children)) return children as unknown as VNode

  const originalOnClick = (children.props as { onClick?: (e: MouseEvent) => void } | null)?.onClick

  // Gotcha: function-component children that don't forward onClick silently
  // swallow the toggle; for those use the controlled form instead.
  return cloneElement(children, {
    onClick: (e: MouseEvent) => {
      if (typeof originalOnClick === 'function') originalOnClick(e)
      setOpen(!open)
    },
  } as Record<string, unknown>)
}

// Fixed-positioned content shown when `open`. Outside-click (mousedown) and Escape close it.

export type { PopoverAlign, PopoverSide }

export interface PopoverContentProps {
  children: ComponentChildren
  /** Which vertical edge of the trigger the popover sits beside. */
  side?: PopoverSide
  /** How the popover is aligned along the horizontal axis. */
  align?: PopoverAlign
  /** Stretch content to the trigger's measured width (select-style dropdowns). */
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
  // `null` until the first measure pass; content renders hidden meanwhile
  // (must be in the DOM to measure) so it never flashes at the wrong spot.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  // px when `matchTriggerWidth`, else null; separate from `placement` to keep geometry width-agnostic.
  const [width, setWidth] = useState<number | null>(null)

  // mousedown (not click) so a drag-select gesture doesn't swallow the close.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      // composedPath() pierces shadow DOM; e.target alone is retargeted to the
      // shadow host on a document listener and would misfire "outside".
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

  // Measure and place the fixed box, re-running on scroll (capture phase so the
  // dialog's inner panel scroll counts too), resize, and content resize.
  // useLayoutEffect so the first placement lands before paint.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const reposition = () => {
      const wrapper = wrapperRef.current
      const content = contentRef.current
      if (!wrapper || !content) return
      // Wrapper is inline-block and content is out of flow, so its rect IS the trigger's rect.
      const t = wrapper.getBoundingClientRect()
      // offsetWidth/scrollHeight report NATURAL size, so the maxHeight cap
      // below never feeds back into re-measuring.
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
        // Fixed so the dialog's overflow can't clip us; overflow-y-auto scrolls
        // tall popovers, overflow-x hidden preserves the rounded edge.
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
