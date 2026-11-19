import { cn } from 'cn'
import type { HTMLAttributes } from 'preact'

type ScrollAreaBase = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'className'>

export interface ScrollAreaProps extends ScrollAreaBase {
  className?: string
}

/** shadcn-style scroll container: native scrolling with slim, theme-tinted scrollbars; children render directly inside it. */
export function ScrollArea({ className, children, ...props }: ScrollAreaProps) {
  return (
    <div
      data-slot='scroll-area'
      class={cn(
        'relative overflow-auto',
        'scrollbar-thin scrollbar-thumb-ga3',
        // Chrome tab-focuses scrollers without focusable children; inset so an ancestor's overflow can't clip the ring.
        'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand/50 focus-visible:outline-solid',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
