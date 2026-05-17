import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

import { cn } from '../../lib/cn'
import { Button } from './button'

interface ConfirmOptions {
  title?: string
  body?: ComponentChildren
  confirmText?: string
  cancelText?: string
  anchor?: { x: number; y: number }
  resolve: (confirmed: boolean) => void
}

const pending = signal<ConfirmOptions | null>(null)

export function showConfirm(opts?: {
  title?: string
  body?: ComponentChildren
  confirmText?: string
  cancelText?: string
  anchor?: { x: number; y: number }
}): Promise<boolean> {
  return new Promise(resolve => {
    pending.value = { ...opts, resolve }
  })
}

export function AlertDialog() {
  const ref = useRef<HTMLDialogElement>(null)
  const p = pending.value

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (p) {
      dialog.showModal()

      if (p.anchor) {
        const rect = dialog.getBoundingClientRect()
        const x = Math.max(0, Math.min(p.anchor.x - rect.width / 2, window.innerWidth - rect.width))
        const y = Math.max(0, Math.min(p.anchor.y - rect.height - 8, window.innerHeight - rect.height))
        dialog.style.margin = '0'
        dialog.style.position = 'fixed'
        dialog.style.left = `${x}px`
        dialog.style.top = `${y}px`
      } else {
        dialog.style.margin = ''
        dialog.style.position = ''
        dialog.style.left = ''
        dialog.style.top = ''
      }
    } else {
      dialog.close()
    }
  }, [p])

  if (!p) return null

  const close = (confirmed: boolean) => {
    p.resolve(confirmed)
    pending.value = null
  }

  return (
    <dialog
      ref={ref}
      class={cn('border border-ga4 border-solid', 'max-w-[320px] rounded-lg p-3')}
      onCancel={e => {
        e.preventDefault()
        close(false)
      }}
      onClick={e => {
        if (p.anchor && e.target === ref.current) close(false)
      }}
      onKeyDown={e => {
        if (p.anchor && e.key === 'Escape') close(false)
      }}
    >
      {p.title && <p class={'mx-0 mt-0 mb-2 break-all'}>{p.title}</p>}
      {p.body && <div class={'mx-0 mt-0 mb-2 break-all'}>{p.body}</div>}
      <div class={'flex justify-end gap-2'}>
        <Button variant='outline' size='sm' onClick={() => close(false)}>
          {p.cancelText ?? '取消'}
        </Button>
        <Button size='sm' onClick={() => close(true)}>
          {p.confirmText ?? '确认'}
        </Button>
      </div>
    </dialog>
  )
}
