import { signal } from '@preact/signals'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

interface ConfirmOptions {
  title?: string
  body?: ComponentChildren
  confirmText?: string
  cancelText?: string
  resolve: (confirmed: boolean) => void
}

const pending = signal<ConfirmOptions | null>(null)

export function showConfirm(opts?: {
  title?: string
  body?: ComponentChildren
  confirmText?: string
  cancelText?: string
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
      onCancel={e => {
        e.preventDefault()
        close(false)
      }}
      style={{
        border: '1px solid var(--Ga2, #ccc)',
        borderRadius: '8px',
        padding: '1em',
        maxWidth: '320px',
        fontSize: '12px',
      }}
    >
      {p.title && <p style={{ margin: '0 0 .75em', wordBreak: 'break-all' }}>{p.title}</p>}
      {p.body && <div style={{ margin: '0 0 .75em', wordBreak: 'break-all' }}>{p.body}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '.5em' }}>
        <button type='button' onClick={() => close(false)}>
          {p.cancelText ?? '取消'}
        </button>
        <button type='button' onClick={() => close(true)}>
          {p.confirmText ?? '确认'}
        </button>
      </div>
    </dialog>
  )
}
