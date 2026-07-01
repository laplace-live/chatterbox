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

// MIN keeps action rows on one line; MAX caps drag on widescreen; margin clamps smaller windows tighter.
const DIALOG_MIN_WIDTH = 180
const DIALOG_MAX_WIDTH = 900
const DIALOG_VIEWPORT_MARGIN = 40

/** Clamp a width to the current viewport-aware envelope; re-reads window.innerWidth each call, so resizing the browser mid-drag tightens the bound live. */
export function clampWidth(raw: number): number {
  const viewportMax = Math.min(DIALOG_MAX_WIDTH, window.innerWidth - DIALOG_VIEWPORT_MARGIN)
  return Math.max(DIALOG_MIN_WIDTH, Math.min(raw, viewportMax))
}

export function Configurator() {
  const tab = activeTab.value
  const visible = dialogOpen.value
  const optimized = optimizeLayout.value
  // Clamp at read time so a stored width from a wider session doesn't overflow a narrower viewport.
  const width = clampWidth(dialogWidth.value)

  // Optimized: panel owns the scroll (dialog is overflow-hidden). Legacy: dialog scrolls, panel grows.
  const panelClass = (active: boolean) =>
    cn(
      // Horizontal padding lives on the per-tab wrapper, not the dialog (which also holds `<Tabs />`).
      'px-[10px]',
      !active && 'hidden',
      active && optimized && 'min-h-0 flex-1 overflow-y-auto',
      active && !optimized && 'block'
    )

  return (
    <div
      id='laplace-chatterbox-dialog'
      // Visible+optimized: flex column, overflow-hidden (children opt back into scroll). Non-optimized: legacy block growing to viewport height.
      // z-index sits one below the corner cluster so InfoButton's popover (trapped in the cluster's stacking context) can render over this dialog.
      className={cn(
        'fixed right-1 bottom-[calc(34px)] z-2147483646 text-[13px]',
        'min-w-12.5 rounded bg-bg1 shadow-md ring ring-ga6/30',
        !visible && 'hidden',
        visible && optimized && 'flex h-[calc(100vh-110px)] flex-col overflow-hidden',
        visible && !optimized && 'block max-h-[calc(100vh-110px)] overflow-y-auto'
      )}
      style={{ width: `${width}px`, '--laplace-chatterbox-dialog-width': `${width}px` }}
    >
      <ResizeHandle />
      <Tabs />

      <div class={panelClass(tab === 'fasong')}>
        <AutoSendControls />
        <div class='my-1'>
          <AutoBlendControls />
        </div>
        <div class='my-1'>
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

      <div class='px-2.5 pb-1.25'>
        <LogPanel />
      </div>
    </div>
  )
}

/**
 * Drag handle on the left edge of the right-anchored dialog (drag left grows, right shrinks).
 * - `setPointerCapture` keeps events flowing when the cursor outpaces the narrow strip mid-drag.
 * - Toggles `document.body` cursor/userSelect during the drag so the cursor stays `ew-resize` and fast drags don't select page text.
 */
function ResizeHandle() {
  const onPointerDown = (e: TargetedPointerEvent<HTMLDivElement>) => {
    // Block click-through into the dialog and the host page's own drag/select gesture.
    e.preventDefault()
    e.stopPropagation()

    const target = e.currentTarget
    const startX = e.clientX
    // Anchor on the rendered width, not the raw persisted value, or a clamped stored width makes the first px of drag a no-op.
    const startWidth = clampWidth(dialogWidth.value)

    target.setPointerCapture(e.pointerId)

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent) => {
      // Right-anchored: leftward motion increases width, hence `startX - currentX`.
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
        // Absolute against the fixed dialog, which already establishes a containing block.
        'absolute top-0 bottom-0 left-0 w-0.75',
        'cursor-ew-resize select-none',
        // Sit above tab buttons / panels so the strip is always grabbable.
        'z-10',
        // Hover/active feedback so the affordance is discoverable without a permanent seam.
        'hover:bg-ga3 active:bg-ga4'
      )}
      // `touch-action: none` so a touch-drag resizes instead of panning the page; inline since our UnoCSS preset lacks `touch-none`.
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      title='拖动以调整面板宽度'
    />
  )
}
