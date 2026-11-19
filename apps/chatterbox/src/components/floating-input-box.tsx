import { IconArrowsMove, IconMinus } from '@tabler/icons-preact'
import { cn } from 'cn'
import type { TargetedMouseEvent, TargetedPointerEvent } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import {
  clampFloatingRect,
  defaultFloatingRect,
  type FloatingRect,
  moveFloatingRect,
  type ResizeEdge,
  resizeFloatingRect,
  type ViewportSize,
} from '../lib/floating-input-rect'
import { describeLlmGap } from '../lib/llm-tasks'
import {
  normalSendPolishing,
  polishNormalSendInput,
  previewNormalSendCount,
  submitNormalSend,
} from '../lib/normal-send'
import { startPointerDrag } from '../lib/pointer-drag'
import { fasongText, floatingInputEnabled, floatingInputMinimized, normalSendYolo } from '../lib/store'
import { getGraphemes } from '../lib/utils'
import { EmoteSelector } from './emote-selector'
import { FansMedalSelector } from './fans-medal-selector'

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

/**
 * Floating danmaku input box sitting at the lowest plugin layer (below Configurator and StatusBar).
 * Initializes once per room load to B站's native input box size/position and stays stable across room layout changes.
 */
export function FloatingInputBox() {
  const enabled = floatingInputEnabled.value
  const minimized = floatingInputMinimized.value
  const polishing = normalSendPolishing.value
  const [rect, setRect] = useState<FloatingRect | null>(null)
  const [viewport, setViewport] = useState<ViewportSize>(getViewportSize)
  const boxRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const refocusAfterPolishRef = useRef(false)
  const activeDragCancelRef = useRef<(() => void) | null>(null)

  const cancelActiveDrag = () => {
    activeDragCancelRef.current?.()
    activeDragCancelRef.current = null
  }

  useEffect(() => {
    const onResize = () => setViewport(getViewportSize())
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      cancelActiveDrag()
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      cancelActiveDrag()
      setRect(null)
      floatingInputMinimized.value = false
      return
    }
    setRect(prev => prev ?? defaultFloatingRect(getViewportSize()))
  }, [enabled])

  useEffect(() => {
    if (!enabled || minimized) cancelActiveDrag()
    if (minimized && boxRef.current?.querySelector('[role="dialog"]')) {
      document.dispatchEvent(new MouseEvent('mousedown'))
    }
  }, [enabled, minimized])

  useEffect(() => {
    if (polishing || !refocusAfterPolishRef.current) return
    refocusAfterPolishRef.current = false
    if (enabled && !minimized) {
      textareaRef.current?.focus()
    }
  }, [polishing, enabled, minimized])

  if (!enabled || !rect) return null

  const renderRect = clampFloatingRect(rect, viewport)
  const llmReady = describeLlmGap('normalSend') === null
  const msgCount = previewNormalSendCount(fasongText.value)
  const charCount = getGraphemes(fasongText.value).length

  // Prevent default on mousedown (not pointerdown) so mousedown still bubbles to document to close Popovers while blocking focus/selection.
  const preventFocusMouseDown = (e: TargetedMouseEvent<HTMLElement>) => {
    e.preventDefault()
  }

  const startResize = (edge: ResizeEdge, cursor: string) => (e: TargetedPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    const startRect = renderRect
    cancelActiveDrag()
    activeDragCancelRef.current = startPointerDrag(e.currentTarget, e, {
      cursor,
      onMove: ev => {
        setRect(resizeFloatingRect(startRect, edge, ev.clientX - startX, ev.clientY - startY, getViewportSize()))
      },
    })
  }

  const startMove = (e: TargetedPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    const startRect = renderRect
    cancelActiveDrag()
    activeDragCancelRef.current = startPointerDrag(e.currentTarget, e, {
      cursor: 'grabbing',
      onMove: ev => {
        setRect(moveFloatingRect(startRect, ev.clientX - startX, ev.clientY - startY, getViewportSize()))
      },
    })
  }

  return (
    <div
      ref={boxRef}
      id='laplace-chatterbox-floating-input'
      inert={minimized}
      // z-2147483645 sits beneath Configurator (2147483646) and StatusBar (2147483647), keeping popovers bounded inside this stacking context.
      class={cn(
        'group/floating-input fixed z-2147483645 box-border flex items-center rounded-xl bg-bg1 text-[12px] shadow-md ring ring-ga4/50',
        minimized && 'hidden'
      )}
      style={{
        left: `${renderRect.left}px`,
        top: `${renderRect.top}px`,
        width: `${renderRect.width}px`,
        height: `${renderRect.height}px`,
      }}
    >
      {RESIZE_HANDLES.map(handle => (
        <div
          key={handle.edge}
          aria-hidden='true'
          onMouseDown={preventFocusMouseDown}
          onPointerDown={startResize(handle.edge, handle.cursor)}
          title={handle.title}
          class={cn('absolute z-10 transition-colors select-none hover:bg-brand/25', handle.className)}
          style={{ cursor: handle.cursor, touchAction: 'none' }}
        />
      ))}

      <button
        type='button'
        onClick={() => {
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
        onMouseDown={preventFocusMouseDown}
        onPointerDown={startMove}
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

      <div class='flex h-full min-w-0 flex-1 items-center gap-1.5 py-1 pr-1.5 pl-4'>
        <FansMedalSelector />
        <div class='h-4 w-px shrink-0 bg-ga3' />
        <div class='relative flex h-full min-w-8 flex-1 items-center'>
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
        <EmoteSelector compact side='top' align='end' contentClassName='w-[min(372px,calc(100vw-24px))]' />
      </div>
    </div>
  )
}
