import type { TargetedPointerEvent } from 'preact'

import { cn } from '../lib/cn'
import { activeTab, dialogOpen, dialogWidth, optimizeLayout } from '../lib/store'
import { AboutTab } from './about-tab'
import { AutoBlendControls } from './auto-blend-controls'
import { AutoSendControls } from './auto-send-controls'
import { LogPanel } from './log-panel'
import { MemesList } from './memes-list'
import { NormalSendTab } from './normal-send-tab'
import { SettingsTab } from './settings-tab'
import { SttTab } from './stt-tab'
import { Tabs } from './tabs'

// Width clamps for the resize handle. MIN keeps the action rows (input +
// 2-3 buttons) on a single line so the dialog never collapses into a
// nothing-fits state. MAX caps at 900 to stop someone dragging past the
// viewport on widescreen monitors; we also subtract a viewport margin at
// drag time so smaller windows clamp tighter.
const DIALOG_MIN_WIDTH = 180
const DIALOG_MAX_WIDTH = 900
const DIALOG_VIEWPORT_MARGIN = 40

// Single source of truth for "what width is this dialog allowed to be right
// now?". Used at three call sites — render, drag start, and drag move — so
// they can't drift apart. In particular: capturing `dialogWidth.value`
// directly at drag start would anchor the gesture to a stored value the
// user can't see (e.g. 800 px persisted from a wider session, but the
// viewport caps the visible width at 360), making the first ~hundreds of
// pixels of drag a no-op against the clamp.
function clampWidth(raw: number): number {
  const viewportMax = Math.min(DIALOG_MAX_WIDTH, window.innerWidth - DIALOG_VIEWPORT_MARGIN)
  return Math.max(DIALOG_MIN_WIDTH, Math.min(raw, viewportMax))
}

export function Configurator() {
  const tab = activeTab.value
  const visible = dialogOpen.value
  const optimized = optimizeLayout.value
  // Clamp at READ time too so a stored 800 from a wider session doesn't
  // overflow a now-narrower viewport. Drag writes are also clamped, so
  // once the user resizes anything the persisted value rejoins the
  // viewport-aware envelope automatically.
  const width = clampWidth(dialogWidth.value)

  // Three layout shapes for the dialog:
  // 1. Hidden when `dialogOpen` is false.
  // 2. Visible + optimized: full-height flex column with hidden overflow
  //    (children opt back into scroll where appropriate).
  // 3. Visible + non-optimized: legacy block layout that grows to its
  //    content up to the viewport height.
  const dialogClass = cn(
    'lc-fixed lc-right-1 lc-bottom-[calc(4px_+_30px)] lc-z-[2147483647]',
    'lc-bg-bg1 lc-rounded lc-min-w-[50px]',
    'lc-shadow-[0_0_0_1px_var(--Ga2,rgba(0,0,0,.2))]',
    !visible && 'lc-hidden',
    visible && optimized && 'lc-flex lc-flex-col lc-h-[calc(100vh_-_110px)] lc-overflow-hidden',
    visible && !optimized && 'lc-block lc-max-h-[calc(100vh_-_110px)] lc-overflow-y-auto'
  )

  // All four tab panels share the visibility/layout shape: in optimized
  // mode the panel itself owns the vertical scroll (since the dialog is
  // overflow-hidden), and in legacy mode the dialog scrolls and the panel
  // grows naturally. Fasong's meme list still has its own internal scroll
  // container (capped at lc-max-h-[240px]) so a long meme list doesn't
  // monopolize the panel viewport.
  const panelClass = (active: boolean) =>
    cn(
      // `<Tabs />` already lives inside the dialog, so panel-level horizontal
      // padding belongs here on the per-tab wrapper rather than the dialog.
      'lc-px-[10px]',
      !active && 'lc-hidden',
      active && optimized && 'lc-flex-1 lc-min-h-0 lc-overflow-y-auto',
      active && !optimized && 'lc-block'
    )

  return (
    <div
      id='laplace-chatterbox-dialog'
      class={dialogClass}
      style={{ width: `${width}px`, '--laplace-chatterbox-dialog-width': `${width}px` }}
    >
      <ResizeHandle />
      <Tabs />

      <div class={panelClass(tab === 'fasong')}>
        <AutoSendControls />
        <div class='lc-my-1'>
          <AutoBlendControls />
        </div>
        <div class='lc-my-1'>
          <MemesList />
        </div>
        <NormalSendTab />
      </div>

      <div class={panelClass(tab === 'tongchuan')}>
        <SttTab />
      </div>

      <div class={panelClass(tab === 'settings')}>
        <SettingsTab />
      </div>

      <div class={panelClass(tab === 'about')}>
        <AboutTab />
      </div>

      <div class='lc-px-[10px] lc-pb-[5px]'>
        <LogPanel />
      </div>
    </div>
  )
}

/**
 * Drag handle pinned to the LEFT edge of the dialog. The panel is anchored
 * at `right: 1px`, so dragging left grows the panel and dragging right
 * shrinks it — matches the "grab the edge that's free to move" affordance
 * users expect from resizable side-panels.
 *
 * Implementation notes:
 *
 * - `setPointerCapture` keeps pointer events flowing to the handle even
 *   when the cursor leaves the 6 px strip — without it, a fast drag would
 *   detach mid-gesture as soon as the mouse outpaced the panel.
 * - We toggle `cursor` / `userSelect` on `document.body` for the duration
 *   of the drag so the cursor stays `ew-resize` over arbitrary B站 DOM and
 *   so dragging fast doesn't accidentally select chat text behind the
 *   dialog. Both are cleared in the same handler that releases capture.
 * - `clampWidth` re-reads `window.innerWidth` on every call, so resizing
 *   the browser window mid-drag tightens the upper bound live and matches
 *   what the user sees on screen.
 */
function ResizeHandle() {
  // `TargetedPointerEvent<HTMLDivElement>` (Preact's typed wrapper) narrows
  // `currentTarget` to the actual `<div>` we mounted, so the body of the
  // handler reads `target.setPointerCapture` / `target.addEventListener`
  // without any `as HTMLElement` rescue cast.
  const onPointerDown = (e: TargetedPointerEvent<HTMLDivElement>) => {
    // Block click-through into the underlying dialog (the handle sits over
    // the first ~6 px of the panel content) and stop the host page from
    // initiating its own drag/select gesture.
    e.preventDefault()
    e.stopPropagation()

    const target = e.currentTarget
    const startX = e.clientX
    // Anchor on the width the dialog is ACTUALLY rendered at, not the raw
    // persisted value. Otherwise a stored 800 with a viewport-clamped
    // visible 360 would force the user to drag 440+ px before any visual
    // change occurs (the delta would just chip away at the gap between
    // 800 and the clamp).
    const startWidth = clampWidth(dialogWidth.value)

    target.setPointerCapture(e.pointerId)

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent) => {
      // Right-anchored panel: leftward motion (negative ev.clientX delta)
      // must INCREASE width, hence `startX - currentX` rather than the
      // usual `currentX - startX`. `clampWidth` re-reads `window.innerWidth`
      // each call so resizing the browser mid-drag tightens the upper
      // bound live, matching what the user sees on screen.
      const delta = startX - ev.clientX
      dialogWidth.value = clampWidth(startWidth + delta)
    }

    const onEnd = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId)
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onEnd)
      target.removeEventListener('pointercancel', onEnd)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }

    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onEnd)
    target.addEventListener('pointercancel', onEnd)
  }

  return (
    <div
      class={cn(
        // Absolute inside the fixed dialog: `position: fixed` itself
        // establishes a containing block, so no extra `relative` needed.
        'lc-absolute lc-left-0 lc-top-0 lc-bottom-0 lc-w-[3px]',
        'lc-cursor-ew-resize lc-select-none',
        // Sit above tab buttons / panels so the strip is always grabbable.
        // The dialog itself is at the script's z-index ceiling, so this
        // only races with our own children.
        'lc-z-10',
        // Subtle hover/active feedback so the affordance is discoverable
        // without a permanent visual seam down the panel edge.
        'hover:lc-bg-ga3 active:lc-bg-ga4'
      )}
      // `touch-action: none` opts out of the browser's default pan/zoom
      // gesture so a touch-drag scrolls the panel width instead of the
      // page. Inline because UnoCSS doesn't ship a `lc-touch-none`
      // utility under our slimmed-down preset.
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      title='拖动以调整面板宽度'
    />
  )
}
