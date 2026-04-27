import type { LaplaceInternal } from '@laplace.live/internal'
import { useSignal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken } from '../lib/api'
import { cn } from '../lib/cn'
import { BASE_URL } from '../lib/const'
import { appendLog } from '../lib/log'
import { applyReplacements } from '../lib/replacement'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { cachedStreamerUid, maxLength, memesPanelOpen, msgSendInterval, optimizeLayout } from '../lib/store'
import { processMessages } from '../lib/utils'
import { AccordionItem, AccordionTrigger } from './ui/accordion'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { NativeSelect } from './ui/native-select'

type MemeSortBy = NonNullable<LaplaceInternal.HTTPS.Workers.MemeListQuery['sortBy']>

const MEME_SORT_OPTIONS: Set<string> = new Set<MemeSortBy>(['lastCopiedAt', 'copyCount', 'createdAt'])
const isMemeSortBy = (v: string): v is MemeSortBy => MEME_SORT_OPTIONS.has(v)

const TAG_COLORS: Record<string, string> = {
  red: '#ef4444',
  yellow: '#eab308',
  fuchsia: '#d946ef',
  emerald: '#10b981',
  blue: '#3b82f6',
  orange: '#f97316',
  purple: '#a855f7',
  pink: '#ec4899',
  cyan: '#06b6d4',
  green: '#22c55e',
}

function sortMemes(memes: LaplaceInternal.HTTPS.Workers.MemeWithUser[], sortBy: MemeSortBy): void {
  memes.sort((a, b) => {
    if (sortBy === 'lastCopiedAt') {
      if (a.lastCopiedAt === null && b.lastCopiedAt === null) return 0
      if (a.lastCopiedAt === null) return 1
      if (b.lastCopiedAt === null) return -1
      return b.lastCopiedAt.localeCompare(a.lastCopiedAt)
    }
    if (sortBy === 'copyCount') return b.copyCount - a.copyCount
    return b.createdAt.localeCompare(a.createdAt)
  })
}

async function fetchMemes(roomId: number, sortBy: MemeSortBy): Promise<LaplaceInternal.HTTPS.Workers.MemeWithUser[]> {
  const resp = await fetch(`${BASE_URL.LAPLACE_MEMES}?roomId=${roomId}&sortBy=${sortBy}&sort=desc`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
  const json: LaplaceInternal.HTTPS.Workers.MemeListResponse = await resp.json()
  const data = json.data ?? []
  sortMemes(data, sortBy)
  return data
}

async function reportMemeCopy(memeId: number): Promise<number | null> {
  try {
    const resp = await fetch(`${BASE_URL.LAPLACE_MEME_COPY}/${memeId}`, { method: 'POST' })
    if (!resp.ok) return null
    const json: LaplaceInternal.HTTPS.Workers.MemeCopyResponse = await resp.json()
    return json.copyCount
  } catch {
    return null
  }
}

function MemeItem({
  meme,
  onUpdateCount,
  onTagClick,
}: {
  meme: LaplaceInternal.HTTPS.Workers.MemeWithUser
  onUpdateCount: (id: number, count: number) => void
  onTagClick: (tagName: string) => void
}) {
  const copyLabel = useSignal('复制')

  const handleSend = async () => {
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }
      const processed = applyReplacements(meme.content)
      const wasReplaced = meme.content !== processed
      const segments = processMessages(processed, maxLength.value)
      const total = segments.length

      for (let i = 0; i < total; i++) {
        const segment = segments[i]
        const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL)
        const label = total > 1 ? `烂梗 [${i + 1}/${total}]` : '烂梗'
        const display = wasReplaced && total === 1 ? `${meme.content} → ${segment}` : segment

        appendLog(result, label, display)

        if (i < total - 1) {
          await new Promise(r => setTimeout(r, msgSendInterval.value * 1000))
        }
      }

      const newCount = await reportMemeCopy(meme.id)
      if (newCount !== null) onUpdateCount(meme.id, newCount)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(meme.content)
    } catch {
      alert(`复制失败，请手动复制：${meme.content}`)
      return
    }
    copyLabel.value = '已复制'
    setTimeout(() => {
      copyLabel.value = '复制'
    }, 1500)
    const newCount = await reportMemeCopy(meme.id)
    if (newCount !== null) onUpdateCount(meme.id, newCount)
  }

  return (
    <div
      data-meme-id={meme.id}
      class='lc-py-[.4em] lc-flex lc-gap-[.4em] lc-items-start lc-border-b lc-border-b-solid lc-border-b-ga2'
    >
      <div class='lc-flex-1 lc-min-w-0'>
        {meme.tags.length > 0 && (
          <div class='lc-flex lc-flex-wrap lc-gap-[.2em] lc-mb-[.2em]'>
            {meme.tags.map(tag => {
              const bgColor = (tag.color && TAG_COLORS[tag.color]) ?? '#888'
              return (
                <Button
                  type='button'
                  key={tag.id}
                  onClick={() => onTagClick(tag.name)}
                  title={`按「${tag.name}」筛选`}
                  variant='ghost'
                  className='lc-text-sm lc-px-1 lc-py-0 lc-text-white'
                  // Tag color is data-driven (per-meme) so it can't be a
                  // static class; UnoCSS would have to safelist every
                  // possible value otherwise.
                  style={{ background: bgColor }}
                >
                  {tag.emoji ?? ''}
                  {tag.name}
                </Button>
              )
            })}
          </div>
        )}
        <Button
          type='button'
          onClick={() => void handleSend()}
          title='点击发送'
          variant='ghost'
          className='lc-whitespace-pre-wrap lc-text-left lc-p-0 hover:lc-text-brand'
        >
          {meme.content}
        </Button>
      </div>
      <div class='lc-shrink-0 lc-flex lc-flex-col lc-items-center lc-gap-[.15em]'>
        <Button size='sm' variant='outline' title='复制到剪贴板' onClick={() => void handleCopy()}>
          {copyLabel.value}
        </Button>
        {meme.copyCount > 0 && <span class={'lc-text-[10px] lc-text-ga4'}>{meme.copyCount}次</span>}
      </div>
    </div>
  )
}

const MEME_RELOAD_INTERVAL = 30_000 // 30 seconds

export function MemesList() {
  const memes = useSignal<LaplaceInternal.HTTPS.Workers.MemeWithUser[]>([])
  const sortBy = useSignal<MemeSortBy>('lastCopiedAt')
  const filterText = useSignal('')
  const status = useSignal('')
  const isError = useSignal(false)
  const loading = useSignal(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevRectsRef = useRef<Map<number, DOMRect>>(new Map())

  const capturePositions = () => {
    const el = containerRef.current
    if (!el) return
    const map = new Map<number, DOMRect>()
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i]
      if (!(child instanceof HTMLElement)) continue
      const id = Number(child.dataset.memeId)
      if (!Number.isNaN(id)) map.set(id, child.getBoundingClientRect())
    }
    prevRectsRef.current = map
  }

  const loadMemes = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) loading.value = true
    isError.value = false

    try {
      const roomId = await ensureRoomId()
      const data = await fetchMemes(roomId, sortBy.peek())

      if (data.length === 0) {
        memes.value = []
        status.value = '暂无烂梗'
        return
      }

      if (memes.peek().length > 0) capturePositions()
      status.value = `${data.length} 条`
      memes.value = data
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status.value = `加载失败: ${msg}`
      isError.value = true
    } finally {
      if (!silent) loading.value = false
    }
  }

  useLayoutEffect(() => {
    const el = containerRef.current
    const old = prevRectsRef.current
    if (!el || old.size === 0) return
    prevRectsRef.current = new Map()

    for (let i = 0; i < el.children.length; i++) {
      const node = el.children[i]
      if (!(node instanceof HTMLElement)) continue
      const id = Number(node.dataset.memeId)
      const prev = old.get(id)
      if (!prev) continue

      const curr = node.getBoundingClientRect()
      const dy = prev.top - curr.top
      if (Math.abs(dy) < 1) continue

      node.style.transform = `translateY(${dy}px)`
      node.style.transition = ''

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          node.style.transition = 'transform .3s ease'
          node.style.transform = ''
        })
      })
    }
  }, [memes.value])

  // Optimistically re-sort after copy/send so the user sees the updated order
  // immediately instead of waiting for the next 30s polling interval.
  const updateCount = (id: number, count: number) => {
    capturePositions()
    const now = new Date().toISOString()
    const updated = memes.value.map(m => (m.id === id ? { ...m, copyCount: count, lastCopiedAt: now } : m))
    sortMemes(updated, sortBy.peek())
    memes.value = updated
  }

  const handleTagClick = (tagName: string) => {
    filterText.value = filterText.peek() === tagName ? '' : tagName
  }

  useEffect(() => {
    void loadMemes()
    const timer = setInterval(() => void loadMemes({ silent: true }), MEME_RELOAD_INTERVAL)
    return () => clearInterval(timer)
  }, [sortBy.value])

  return (
    <>
      <AccordionItem
        open={memesPanelOpen.value}
        onOpenChange={v => {
          memesPanelOpen.value = v
        }}
      >
        <AccordionTrigger>烂梗库</AccordionTrigger>
      </AccordionItem>
      {memesPanelOpen.value && (
        <>
          <div class='lc-flex lc-items-center lc-gap-2 lc-my-2'>
            <NativeSelect
              value={sortBy.value}
              onChange={e => {
                const v = e.currentTarget.value
                if (isMemeSortBy(v)) sortBy.value = v
              }}
            >
              <option value='lastCopiedAt'>最近使用</option>
              <option value='copyCount'>最多复制</option>
              <option value='createdAt'>最新添加</option>
            </NativeSelect>
            <Button variant='outline' size='sm' disabled={loading.value} onClick={() => void loadMemes()}>
              {loading.value ? '加载中…' : '刷新'}
            </Button>
            <span class={isError.value ? 'lc-text-[#f44]' : 'lc-text-[#666]'}>{status.value}</span>
            <a
              href={`https://laplace.live/memes${cachedStreamerUid.value ? `?contribute=${cachedStreamerUid.value}` : ''}`}
              target='_blank'
              rel='noopener'
              class='lc-text-link lc-no-underline'
            >
              贡献烂梗
            </a>
          </div>
          {memes.value.length > 0 && (
            <Input
              type='text'
              placeholder='筛选烂梗…'
              value={filterText.value}
              onInput={e => {
                filterText.value = e.currentTarget.value
              }}
              className='lc-w-full lc-mb-2'
            />
          )}
          <div
            ref={containerRef}
            class={cn(
              // Negative horizontal margin extends the scroll container to
              // the dialog's outer edge while the inner padding keeps content
              // visually aligned with the rest of the panel.
              'lc-overflow-y-auto -lc-mx-[10px] lc-px-[10px]',
              optimizeLayout.value ? 'lc-flex-1 lc-min-h-0' : 'lc-max-h-[240px]'
            )}
          >
            {memes.value
              .filter(m => {
                const q = filterText.value.trim().toLowerCase()
                if (!q) return true
                if (m.content.toLowerCase().includes(q)) return true
                return m.tags.some(t => t.name.toLowerCase().includes(q))
              })
              .map(meme => (
                <MemeItem key={meme.id} meme={meme} onUpdateCount={updateCount} onTagClick={handleTagClick} />
              ))}
          </div>
        </>
      )}
    </>
  )
}
