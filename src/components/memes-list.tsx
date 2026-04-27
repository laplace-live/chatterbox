import type { LaplaceInternal } from '@laplace.live/internal'
import { useSignal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken } from '../lib/api'
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
      style={{
        padding: '.4em 0',
        borderBottom: '1px solid var(--Ga2, #eee)',
        display: 'flex',
        gap: '.4em',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {meme.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.2em', marginBottom: '.2em' }}>
            {meme.tags.map(tag => {
              const bgColor = (tag.color && TAG_COLORS[tag.color]) ?? '#888'
              return (
                <button
                  type='button'
                  key={tag.id}
                  onClick={() => onTagClick(tag.name)}
                  title={`按「${tag.name}」筛选`}
                  style={{
                    appearance: 'none',
                    border: 'none',
                    outline: 'none',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '.15em',
                    padding: '0 .35em',
                    borderRadius: '2px',
                    fontSize: '10px',
                    lineHeight: 1.6,
                    color: '#fff',
                    background: bgColor,
                    fontFamily: 'inherit',
                    transition: 'filter .15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.filter = 'brightness(1.1)'
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.filter = ''
                  }}
                >
                  {tag.emoji ?? ''}
                  {tag.name}
                </button>
              )
            })}
          </div>
        )}
        <button
          type='button'
          onClick={() => void handleSend()}
          title='点击发送'
          style={{
            appearance: 'none',
            outline: 'none',
            border: 'none',
            background: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            wordBreak: 'break-all',
            lineHeight: 1.4,
            whiteSpace: 'pre-wrap',
            borderRadius: '2px',
            transition: 'background .15s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--bg2, #f0f0f0)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = ''
          }}
        >
          {meme.content}
        </button>
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '.15em',
        }}
      >
        <button
          type='button'
          title='复制到剪贴板'
          onClick={() => void handleCopy()}
          style={{ fontSize: '11px !important', cursor: 'pointer', padding: '.1em .4em' }}
        >
          {copyLabel.value}
        </button>
        {meme.copyCount > 0 && (
          <span style={{ fontSize: '10px !important', color: '#999', lineHeight: 1 }}>{meme.copyCount}次</span>
        )}
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
  const statusColor = useSignal('#666')
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
    statusColor.value = '#666'

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
      statusColor.value = '#f44'
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '.5em', marginTop: '.5em', marginBottom: '.5em' }}>
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
            <span style={{ color: statusColor.value }}>{status.value}</span>
            <a
              href={`https://laplace.live/memes${cachedStreamerUid.value ? `?contribute=${cachedStreamerUid.value}` : ''}`}
              target='_blank'
              rel='noopener'
              style={{ color: '#288bb8', textDecoration: 'none', fontSize: '12px' }}
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
              style={{ width: '100%', marginBottom: '.5em' }}
            />
          )}
          <div
            ref={containerRef}
            style={{
              overflowY: 'auto',
              marginLeft: '-10px',
              marginRight: '-10px',
              paddingInline: '10px',
              ...(optimizeLayout.value ? { flex: 1, minHeight: 0 } : { maxHeight: '240px' }),
            }}
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
