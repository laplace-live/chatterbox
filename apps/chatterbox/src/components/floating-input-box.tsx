import { IconArrowsMove, IconMessage, IconMinus } from '@tabler/icons-preact'
import { cn } from 'cn'
import type { TargetedMouseEvent, TargetedPointerEvent } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import {
  clampFloatingRect,
  DEFAULT_FLOATING_RECT,
  type FloatingRect,
  moveFloatingRect,
  type ResizeEdge,
  resizeFloatingRect,
  type ViewportSize,
} from '../lib/floating-input-rect'
import { describeLlmGap } from '../lib/llm-tasks'
import { normalSendPolishing, normalSendPreview, polishNormalSendInput, submitNormalSend } from '../lib/normal-send'
import { startPointerDrag } from '../lib/pointer-drag'
import { fasongText, floatingInputMinimized, floatingInputRect, normalSendYolo } from '../lib/store'
import { EmoteSelector } from './emote-selector'
import { FansMedalSelector } from './fans-medal-selector'
import { STATUS_BAR_BUTTON_CLASS } from './status-bar'

const RESIZE_HANDLES: Array<{ edge: ResizeEdge; className: string; cursor: string; title: string }> = [
  { edge: 'n', className: 'top-0 left-4 right-2.5 h-1.5', cursor: 'ns-resize', title: '向上/下调整高度' },
  { edge: 's', className: 'bottom-0 left-5 right-2.5 h-1.5', cursor: 'ns-resize', title: '向上/下调整高度' },
  { edge: 'w', className: 'top-4 bottom-5 left-0 w-1.5', cursor: 'ew-resize', title: '向左/右调整宽度' },
  { edge: 'e', className: 'top-2.5 bottom-2.5 right-0 w-1.5', cursor: 'ew-resize', title: '向左/右调整宽度' },
  { edge: 'ne', className: 'top-0 right-0 size-2.5', cursor: 'nesw-resize', title: '拖动调整大小' },
  { edge: 'se', className: 'bottom-0 right-0 size-2.5', cursor: 'nwse-resize', title: '拖动调整大小' },
]

function getViewportSize(): ViewportSize {
  return {
    width: document.documentElement.clientWidth || window.innerWidth,
    height: document.documentElement.clientHeight || window.innerHeight,
  }
}

// Cancel mousedown, not pointerdown: it still bubbles to close popovers but no longer steals focus or selects.
const preventFocus = (e: TargetedMouseEvent<HTMLElement>) => e.preventDefault()

/** Floating danmaku input box; mount only while enabled. Its rect persists across reloads. */
export function FloatingInputBox() {
  const minimized = floatingInputMinimized.value
  const polishing = normalSendPolishing.value
  const [viewport, setViewport] = useState<ViewportSize>(getViewportSize)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const refocusAfterPolishRef = useRef(false)
  const activeDragCancelRef = useRef<(() => void) | null>(null)

  const cancelActiveDrag = () => {
    activeDragCancelRef.current?.()
    activeDragCancelRef.current = null
  }

  useEffect(
    () => () => {
      cancelActiveDrag()
      floatingInputMinimized.value = false
    },
    []
  )

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

  useEffect(() => {
    if (polishing || !refocusAfterPolishRef.current) return
    refocusAfterPolishRef.current = false
    textareaRef.current?.focus()
  }, [polishing])

  if (minimized) return null

  const renderRect = clampFloatingRect(floatingInputRect.value ?? DEFAULT_FLOATING_RECT, viewport)
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
      activeDragCancelRef.current = startPointerDrag(e.currentTarget, e.pointerId, {
        cursor,
        onMove: ev => {
          floatingInputRect.value = next(startRect, ev.clientX - startX, ev.clientY - startY, vp)
        },
      })
    }

  return (
    <div
      id='laplace-chatterbox-floating-input'
      // z-2147483645 sits beneath Configurator (2147483646) and StatusBar (2147483647), keeping popovers bounded inside this stacking context.
      class='group/floating-input fixed z-2147483645 box-border flex rounded-xl bg-bg1 text-[12px] shadow-md ring ring-ga4/50'
      style={{
        right: `${renderRect.right}px`,
        bottom: `${renderRect.bottom}px`,
        width: `${renderRect.width}px`,
        height: `${renderRect.height}px`,
      }}
    >
      {RESIZE_HANDLES.map(handle => (
        <div
          key={handle.edge}
          aria-hidden='true'
          onMouseDown={preventFocus}
          onPointerDown={startDrag(handle.cursor, (r, dx, dy, vp) => resizeFloatingRect(r, handle.edge, dx, dy, vp))}
          title={handle.title}
          class={cn('absolute z-10 transition-colors select-none hover:bg-brand/25', handle.className)}
          style={{ cursor: handle.cursor, touchAction: 'none' }}
        />
      ))}

      <button
        type='button'
        onClick={() => {
          cancelActiveDrag()
          floatingInputMinimized.value = true
        }}
        title='最小化输入框'
        aria-label='最小化输入框'
        class={cn(
          'absolute top-0.5 left-0.5 z-20 m-0 flex size-3.5 items-center justify-center rounded-full border-none p-0',
          'cursor-pointer bg-ga2/80 text-ga6 opacity-45 transition hover:bg-ga3 hover:text-inherit hover:opacity-100'
        )}
      >
        <IconMinus size={10} stroke={2.2} aria-hidden='true' />
      </button>

      <button
        type='button'
        onMouseDown={preventFocus}
        onPointerDown={startDrag('grabbing', moveFloatingRect)}
        title='按住拖动输入框位置'
        aria-label='拖动输入框位置'
        class={cn(
          'absolute bottom-0.5 left-0.5 z-20 m-0 flex size-4 items-center justify-center rounded-full border-none p-0',
          'cursor-grab bg-bg2/65 text-ga6 opacity-0 backdrop-blur-[2px] transition-opacity duration-200',
          'group-hover/floating-input:opacity-45 hover:!opacity-85 active:cursor-grabbing'
        )}
        style={{ touchAction: 'none' }}
      >
        <IconArrowsMove size={11} stroke={1.8} aria-hidden='true' />
      </button>

      <div class='flex h-full min-w-0 flex-1 flex-col gap-1 py-1 pr-1.5 pl-4'>
        <div class='relative min-h-0 flex-1'>
          <textarea
            ref={textareaRef}
            value={fasongText.value}
            disabled={polishing}
            onInput={e => {
              fasongText.value = e.currentTarget.value
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
                e.preventDefault()
                if (normalSendYolo.value) refocusAfterPolishRef.current = true
                void submitNormalSend()
                if (!normalSendPolishing.peek()) refocusAfterPolishRef.current = false
              } else if (e.key === 'Enter' && e.altKey && !e.isComposing && llmReady) {
                e.preventDefault()
                refocusAfterPolishRef.current = true
                void polishNormalSendInput()
                if (!normalSendPolishing.peek()) refocusAfterPolishRef.current = false
              }
            }}
            placeholder={normalSendYolo.value && llmReady ? 'YOLO：Enter 润色发送' : '发送弹幕…'}
            class={cn(
              'h-full w-full resize-none border-none bg-transparent px-0 py-0.5 text-[12px] leading-snug text-inherit outline-none',
              'placeholder:text-ga5 disabled:cursor-not-allowed disabled:opacity-60'
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
    </div>
  )
}

/** Icon-only status bar button that restores the minimized box. */
export function FloatingInputRestoreButton() {
  return (
    <button
      type='button'
      onClick={() => {
        floatingInputMinimized.value = false
      }}
      title='恢复悬浮输入框'
      aria-label='恢复悬浮输入框'
      class={cn(STATUS_BAR_BUTTON_CLASS, 'w-7 justify-center px-0', 'bg-ga6')}
    >
      <IconMessage size={16} stroke={2} aria-hidden='true' />
    </button>
  )
}
