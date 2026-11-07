import { useSignal } from '@preact/signals'
import { useEffect, useRef } from 'preact/hooks'

import { appendLog } from '../lib/log'
import { deleteUserNote, getUserNote, setUserNote } from '../lib/user-notes'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

/** Local note editor for `uid`; autosaves after 1.5s idle and flushes on blur or unmount under the uid it was typed for. */
export function UserNoteEditor({ uid }: { uid: number }) {
  const stored = getUserNote(uid)
  const draft = useSignal(stored?.note ?? '')
  const lastLoadedUid = useSignal<number | null>(null)
  const lastLoadedUpdatedAt = useSignal<number | null>(null)
  const saveStatus = useSignal<'idle' | 'saving' | 'saved'>('idle')

  const debounceTimer = useRef<number | null>(null)
  const savedTimer = useRef<number | null>(null)

  // Re-hydrate on uid change or `updatedAt` shift; the latter refreshes an open editor after an import.
  useEffect(() => {
    const incomingUpdatedAt = stored?.updatedAt ?? null
    if (lastLoadedUid.value === uid && lastLoadedUpdatedAt.value === incomingUpdatedAt) return
    draft.value = stored?.note ?? ''
    lastLoadedUid.value = uid
    lastLoadedUpdatedAt.value = incomingUpdatedAt
  }, [uid, stored?.updatedAt])

  // Flush on uid-change/unmount, keyed to the captured uid; re-read storage for a live dirty check.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current)
        debounceTimer.current = null
      }
      if (savedTimer.current !== null) {
        clearTimeout(savedTimer.current)
        savedTimer.current = null
      }
      const storedNow = getUserNote(uid)?.note ?? ''
      if (draft.value !== storedNow) setUserNote(uid, draft.value)
    }
  }, [uid])

  // No-op when unchanged so a focus-out without edits never bumps `updatedAt`.
  const commit = () => {
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    if (draft.value === (stored?.note ?? '')) {
      saveStatus.value = 'idle'
      return
    }
    setUserNote(uid, draft.value)
    saveStatus.value = 'saved'
    if (savedTimer.current !== null) clearTimeout(savedTimer.current)
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = null
      saveStatus.value = 'idle'
    }, 2000)
  }

  const handleInput = (value: string) => {
    draft.value = value
    if (savedTimer.current !== null) {
      clearTimeout(savedTimer.current)
      savedTimer.current = null
    }
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current)
    saveStatus.value = value === (stored?.note ?? '') ? 'idle' : 'saving'
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null
      commit()
    }, 1500)
  }

  const handleDelete = () => {
    if (!stored) return
    if (!confirm(`确定删除 UID ${uid} 的备注？此操作无法撤销。`)) return
    if (debounceTimer.current !== null) {
      clearTimeout(debounceTimer.current)
      debounceTimer.current = null
    }
    deleteUserNote(uid)
    draft.value = ''
    saveStatus.value = 'idle'
    appendLog(`📝 已删除 UID ${uid} 的备注`)
  }

  return (
    <div class='flex flex-col gap-1'>
      <Textarea
        value={draft.value}
        onInput={e => handleInput(e.currentTarget.value)}
        onBlur={commit}
        placeholder='给这位用户添加备注，支持多行文本，自动保存且仅本地…'
        className='min-h-24'
        rows={4}
      />
      <div class='flex items-center justify-between gap-2'>
        <div class='flex items-center gap-2'>
          <span class='text-ga6'>
            {stored
              ? `上次编辑：${new Date(stored.updatedAt).toLocaleString('zh-CN', {
                  year: 'numeric',
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : '尚未添加备注'}
          </span>
          {saveStatus.value === 'saving' && <span class='text-ga6'>正在保存…</span>}
          {saveStatus.value === 'saved' && <span class='text-brand'>已保存</span>}
        </div>
        {stored && (
          <Button variant='ghost' size='sm' className='text-[red]' onClick={handleDelete}>
            删除
          </Button>
        )}
      </div>
    </div>
  )
}
