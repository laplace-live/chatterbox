import { cn } from 'cn'
import { type ComponentChildren, createContext } from 'preact'
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { shouldCompactStatusBar } from '../lib/status-bar-layout'

const COLLAPSIBLE_SELECTOR = '[data-status-bar-collapsible]'

/** Base look shared by status bar buttons; callers add the background. */
export const STATUS_BAR_BUTTON_CLASS = cn(
  'appearance-none border-none outline-none',
  'cursor-pointer select-none',
  'inline-flex h-8 items-center rounded px-2 text-white',
  'hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset'
)

const CompactContext = createContext(false)

/** Whether the status bar has collapsed its items to icons for lack of room. */
export function useStatusBarCompact(): boolean {
  return useContext(CompactContext)
}

/**
 * Bottom-right fixed bar owning position, z-index, and spacing; membership comes from children.
 * Goes compact, hiding every `StatusBarCollapsible`, while the expanded bar would overflow the viewport.
 */
export function StatusBar({ children }: { children: ComponentChildren }) {
  const barRef = useRef<HTMLDivElement>(null)
  const [compact, setCompact] = useState(false)

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    let raf = 0

    const measure = () => {
      raf = 0
      let hiddenWidth = 0
      for (const slot of bar.querySelectorAll<HTMLElement>(COLLAPSIBLE_SELECTOR)) {
        const content = slot.firstElementChild
        if (content instanceof HTMLElement) hiddenWidth += content.offsetWidth - slot.offsetWidth
      }
      const viewportWidth = document.documentElement.clientWidth
      setCompact(prev => shouldCompactStatusBar(bar.offsetWidth + hiddenWidth, viewportWidth, prev))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }

    const resizes = new ResizeObserver(schedule)
    resizes.observe(bar)
    // Collapsed labels can't resize the bar, so their text changes are caught here instead.
    const mutations = new MutationObserver(schedule)
    mutations.observe(bar, { subtree: true, childList: true, characterData: true })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      cancelAnimationFrame(raf)
      resizes.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [])

  return (
    <CompactContext.Provider value={compact}>
      <div
        ref={barRef}
        data-slot='status-bar'
        // `w-max` keeps the measured width natural instead of clamped to the viewport.
        class='fixed right-1 bottom-1 z-2147483647 flex w-max items-center gap-1'
      >
        {children}
      </div>
    </CompactContext.Provider>
  )
}

/** Item part hidden in compact mode; stays mounted at zero width (and inert) so the bar can keep measuring it. */
export function StatusBarCollapsible({ children }: { children: ComponentChildren }) {
  const compact = useStatusBarCompact()
  return (
    <span data-status-bar-collapsible='' inert={compact} class={cn('flex', compact && 'w-0 overflow-hidden')}>
      <span class='flex w-max items-center'>{children}</span>
    </span>
  )
}
