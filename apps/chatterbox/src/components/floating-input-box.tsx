import { IconDotsDiagonal, IconGripHorizontal, IconMessage, IconMinus } from '@tabler/icons-preact'
import { cn } from 'cn'
import type { TargetedMouseEvent, TargetedPointerEvent } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import {
  clampFloatingRect,
  DEFAULT_FLOATING_RECT,
  type FloatingRect,
  moveFloatingRect,
  resizeFloatingRect,
  type ViewportSize,
} from '../lib/floating-input-rect'
import { describeLlmGap } from '../lib/llm-tasks'
import { handleNormalSendKeyDown, normalSendPolishing, normalSendPreview } from '../lib/normal-send'
import { startPointerDrag } from '../lib/pointer-drag'
import { fasongText, floatingInputMinimized, floatingInputRect, normalSendYolo } from '../lib/store'
import { EmoteSelector } from './emote-selector'
import { FansMedalSelector } from './fans-medal-selector'
import { STATUS_BAR_BUTTON_CLASS } from './status-bar'

function getViewportSize(): ViewportSize {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  }
}

// Cancel mousedown, not pointerdown: it still bubbles to close popovers but no longer steals focus or selects.
const preventFocus = (e: TargetedMouseEvent<HTMLElement>) => e.preventDefault()

/** Floating danmaku input box; mount only while enabled. Its rect and minimize state persist across reloads. */
export function FloatingInputBox() {
  const minimized = floatingInputMinimized.value
  const polishing = normalSendPolishing.value
  const [viewport, setViewport] = useState<ViewportSize>(getViewportSize)
  const [dragRect, setDragRect] = useState<FloatingRect | null>(null)
  const activeDragCancelRef = useRef<(() => void) | null>(null)

  const cancelActiveDrag = () => {
    activeDragCancelRef.current?.()
    activeDragCancelRef.current = null
  }

  useEffect(() => () => cancelActiveDrag(), [])

  // The status bar toggle can hide the box mid-drag.
  useEffect(() => {
    if (minimized) cancelActiveDrag()
  }, [minimized])

  useEffect(() => {
    const sync = () => {
      const next = getViewportSize()
      setViewport(prev => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    // The root's box tracks width changes window `resize` can miss (e.g. a scrollbar appearing).
    const observer = new ResizeObserver(sync)
    observer.observe(document.documentElement)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [])

  if (minimized) return null

  const renderRect = clampFloatingRect(dragRect ?? floatingInputRect.value ?? DEFAULT_FLOATING_RECT, viewport)
  const llmReady = describeLlmGap('normalSend') === null
  const { msgCount, charCount } = normalSendPreview.value

  const startDrag =
    (cursor: string, next: (start: FloatingRect, dx: number, dy: number, vp: ViewportSize) => FloatingRect) =>
    (e: TargetedPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      const { clientX: startX, clientY: startY } = e
      const startRect = renderRect
      const vp = viewport
      cancelActiveDrag()
      let last: FloatingRect | null = null
      activeDragCancelRef.current = startPointerDrag(e.currentTarget, e.pointerId, {
        cursor,
        onMove: ev => {
          last = next(startRect, ev.clientX - startX, ev.clientY - startY, vp)
          setDragRect(last)
        },
        // Persist once per drag: every `floatingInputRect` change is a GM storage write.
        onEnd: () => {
          if (last) floatingInputRect.value = last
          setDragRect(null)
        },
      })
    }

  return (
    <div
      id='laplace-chatterbox-floating-input'
      // z-2147483645 sits beneath Configurator (2147483646) and StatusBar (2147483647), keeping popovers bounded inside this stacking context.
      class='fixed z-2147483645 box-border flex flex-col rounded-md bg-bg1 text-[12px] shadow-md ring ring-ga4/50'
      style={{
        right: `${renderRect.right}px`,
        bottom: `${renderRect.bottom}px`,
        width: `${renderRect.width}px`,
        height: `${renderRect.height}px`,
      }}
    >
      <div class='relative h-[14px] shrink-0 rounded-t-md bg-ga2 text-ga5'>
        <div
          aria-hidden='true'
          onMouseDown={preventFocus}
          onPointerDown={startDrag('grabbing', moveFloatingRect)}
          title='拖动移动输入框'
          class='absolute inset-0 flex cursor-grab items-center justify-center select-none active:cursor-grabbing'
          style={{ touchAction: 'none' }}
        >
          <IconGripHorizontal size={12} stroke={2} />
        </div>
        <button
          type='button'
          onClick={() => {
            floatingInputMinimized.value = true
          }}
          title='最小化输入框'
          aria-label='最小化输入框'
          class='absolute top-0 right-0 m-0 flex h-full w-[18px] cursor-pointer items-center justify-center rounded-tr-md border-none bg-transparent p-0 text-ga6 hover:bg-ga3 hover:text-inherit'
        >
          <IconMinus size={10} stroke={2.2} aria-hidden='true' />
        </button>
      </div>

      <div class='flex min-h-0 flex-1 flex-col gap-1 px-1.5 py-1'>
        <div class='relative min-h-0 flex-1'>
          <textarea
            value={fasongText.value}
            readOnly={polishing}
            aria-busy={polishing}
            onInput={e => {
              fasongText.value = e.currentTarget.value
            }}
            onKeyDown={handleNormalSendKeyDown}
            placeholder={normalSendYolo.value && llmReady ? 'YOLO：Enter 润色发送' : '发送弹幕…'}
            class={cn(
              'h-full w-full resize-none border-none bg-transparent px-0 py-0.5 text-[12px] leading-snug text-inherit outline-none',
              'placeholder:text-ga5 read-only:cursor-not-allowed read-only:opacity-60'
            )}
          />
          {charCount > 0 && (
            <span class='pointer-events-none absolute right-0 bottom-0.5 text-[10px] leading-none text-ga5'>
              {msgCount > 1 ? `${msgCount}条·${charCount}` : charCount}
            </span>
          )}
        </div>
        <div class='flex shrink-0 items-center gap-1'>
          <FansMedalSelector />
          <EmoteSelector contentClassName='w-[min(372px,calc(100vw-24px))]' />
        </div>
      </div>

      <div
        aria-hidden='true'
        onMouseDown={preventFocus}
        onPointerDown={startDrag('nwse-resize', resizeFloatingRect)}
        title='拖动调整大小'
        class='absolute right-0 bottom-0 flex size-3 cursor-nwse-resize items-center justify-center text-ga4 select-none hover:text-ga6'
        style={{ touchAction: 'none' }}
      >
        <IconDotsDiagonal size={10} stroke={2} aria-hidden='true' />
      </div>
    </div>
  )
}

/** Icon-only status bar toggle that shows or hides the box; dimmed while hidden. */
export function FloatingInputToggleButton() {
  const hidden = floatingInputMinimized.value
  return (
    <button
      type='button'
      onClick={() => {
        floatingInputMinimized.value = !hidden
      }}
      title={hidden ? '显示悬浮输入框' : '隐藏悬浮输入框'}
      aria-label='悬浮输入框'
      aria-pressed={!hidden}
      class={cn(STATUS_BAR_BUTTON_CLASS, 'w-7 justify-center px-0', 'bg-ga6', hidden && 'opacity-50')}
    >
      <IconMessage size={16} stroke={2} aria-hidden='true' />
    </button>
  )
}
