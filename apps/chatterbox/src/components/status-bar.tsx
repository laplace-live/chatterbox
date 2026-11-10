import { IconChevronsRight } from '@tabler/icons-preact'
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

/**
 * User-toggled group that folds its content away to the right; the chevron stays put as the
 * anchor. State is caller-owned so it can persist.
 */
export function StatusBarFold({
  collapsed,
  onToggle,
  children,
}: {
  collapsed: boolean
  onToggle: () => void
  children: ComponentChildren
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  // Width read right before a toggle, so an interrupted fold continues from where it is.
  const fromWidth = useRef(0)
  const mounted = useRef(false)

  // Width can't transition to/from `auto`, so pin the start width for the animation, then hand
  // the resting width back to the class (`w-0` / `w-auto`).
  useLayoutEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    const group = groupRef.current
    const content = contentRef.current
    if (!group || !content) return
    const to = collapsed ? 0 : content.offsetWidth
    group.style.transition = 'none'
    group.style.width = `${fromWidth.current}px`
    void group.offsetWidth
    group.style.transition = 'width 200ms ease-out'
    group.style.width = `${to}px`
    const settle = (e: TransitionEvent) => {
      if (e.target !== group || e.propertyName !== 'width') return
      group.style.transition = ''
      group.style.width = ''
    }
    group.addEventListener('transitionend', settle)
    return () => group.removeEventListener('transitionend', settle)
  }, [collapsed])

  const toggle = () => {
    fromWidth.current = groupRef.current?.getBoundingClientRect().width ?? contentRef.current?.offsetWidth ?? 0
    onToggle()
  }

  return (
    <>
      <div ref={groupRef} inert={collapsed} class={cn('min-w-0 overflow-hidden', collapsed ? 'w-0' : 'w-auto')}>
        <div ref={contentRef} class='flex w-max items-center gap-1'>
          {children}
        </div>
      </div>
      <button
        type='button'
        id='laplace-status-bar-fold'
        onClick={toggle}
        title={collapsed ? '展开主播信息' : '折叠主播信息'}
        aria-label={collapsed ? '展开主播信息' : '折叠主播信息'}
        aria-expanded={!collapsed}
        class={cn(STATUS_BAR_BUTTON_CLASS, 'w-7 justify-center px-0', 'bg-ga6')}
      >
        <IconChevronsRight
          size={16}
          stroke={2}
          aria-hidden='true'
          class={cn('transition-transform duration-200', collapsed && 'rotate-180')}
        />
      </button>
    </>
  )
}
