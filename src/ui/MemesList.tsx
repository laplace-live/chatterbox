import type { LaplaceInternal } from '@laplace.live/internal'
import { useSignal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'

import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { BASE_URL } from '../const.js'
import { applyReplacements } from '../replacement.js'
import { appendLog, cachedStreamerUid } from '../store.js'

type MemeSortBy = NonNullable<LaplaceInternal.HTTPS.Workers.MemeListQuery['sortBy']>

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
}: {
  meme: LaplaceInternal.HTTPS.Workers.MemeWithUser
  onUpdateCount: (id: number, count: number) => void
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
      const result = await sendDanmaku(processed, roomId, csrfToken)
      if (result.success) {
        const display = meme.content !== processed ? `${meme.content} → ${processed}` : processed
        appendLog(`✅ 烂梗: ${display}`)
      } else {
        let errorMsg = result.error ?? '未知错误'
        if (result.error === 'f' || result.error?.includes('f')) errorMsg = 'f - 包含全局屏蔽词'
        else if (result.error === 'k' || result.error?.includes('k')) errorMsg = 'k - 包含房间屏蔽词'
        const display = meme.content !== processed ? `${meme.content} → ${processed}` : processed
        appendLog(`❌ 烂梗: ${display}，原因：${errorMsg}`)
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
      const ta = document.createElement('textarea')
      ta.value = meme.content
      ta.style.cssText = 'position:fixed;left:-9999px;'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
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
                <span
                  key={tag.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '.15em',
                    padding: '0 .35em',
                    borderRadius: '2px',
                    fontSize: '10px',
                    lineHeight: 1.6,
                    color: '#fff',
                    background: bgColor,
                  }}
                >
                  {tag.emoji ?? ''}
                  {tag.name}
                </span>
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
            ;(e.currentTarget as HTMLElement).style.background = 'var(--bg2, #f0f0f0)'
          }}
          onMouseLeave={e => {
            ;(e.currentTarget as HTMLElement).style.background = ''
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
      const child = el.children[i] as HTMLElement
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
        status.value = '当前房间暂无烂梗'
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
      const node = el.children[i] as HTMLElement
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

  const updateCount = (id: number, count: number) => {
    memes.value = memes.value.map(m => (m.id === id ? { ...m, copyCount: count } : m))
  }

  useEffect(() => {
    void loadMemes()
    const timer = setInterval(() => void loadMemes({ silent: true }), MEME_RELOAD_INTERVAL)
    return () => clearInterval(timer)
  }, [sortBy.value])

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5em', marginBottom: '.5em' }}>
        <span style={{ fontWeight: 'bold' }}>烂梗</span>
        <select
          style={{ fontSize: '12px' }}
          value={sortBy.value}
          onChange={e => {
            sortBy.value = (e.target as HTMLSelectElement).value as MemeSortBy
          }}
        >
          <option value='lastCopiedAt'>最近复制</option>
          <option value='copyCount'>最多复制</option>
          <option value='createdAt'>最新添加</option>
        </select>
        <button type='button' style={{ fontSize: '12px' }} disabled={loading.value} onClick={() => void loadMemes()}>
          {loading.value ? '加载中…' : '刷新'}
        </button>
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
      <div ref={containerRef} style={{ maxHeight: '200px', overflowY: 'auto' }}>
        {memes.value.map(meme => (
          <MemeItem key={meme.id} meme={meme} onUpdateCount={updateCount} />
        ))}
      </div>
    </>
  )
}
