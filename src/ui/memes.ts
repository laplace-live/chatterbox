import type { LaplaceInternal } from '@laplace.live/internal'

import { GM_getValue } from '$'
import { ensureRoomId, getCsrfToken, sendDanmaku } from '../api.js'
import { BASE_URL } from '../const.js'
import { applyReplacements } from '../replacement.js'
import { appendToLimitedLog } from '../utils.js'

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

type MemeSortBy = NonNullable<LaplaceInternal.HTTPS.Workers.MemeListQuery['sortBy']>

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

function renderMemeItem(meme: LaplaceInternal.HTTPS.Workers.MemeWithUser): HTMLDivElement {
  const item = document.createElement('div')
  item.style.cssText =
    'padding: .4em 0; border-bottom: 1px solid var(--Ga2, #eee); display: flex; gap: .4em; align-items: flex-start;'

  const contentWrap = document.createElement('div')
  contentWrap.style.cssText = 'flex: 1; min-width: 0;'

  if (meme.tags.length > 0) {
    const tagsRow = document.createElement('div')
    tagsRow.style.cssText = 'display: flex; flex-wrap: wrap; gap: .2em; margin-bottom: .2em;'
    for (const tag of meme.tags) {
      const badge = document.createElement('span')
      const bgColor = (tag.color && TAG_COLORS[tag.color]) ?? '#888'
      badge.style.cssText = `display: inline-flex; align-items: center; gap: .15em; padding: 0 .35em; border-radius: 2px; font-size: 10px !important; line-height: 1.6; color: #fff; background: ${bgColor};`
      badge.textContent = `${tag.emoji ?? ''}${tag.name}`
      tagsRow.appendChild(badge)
    }
    contentWrap.appendChild(tagsRow)
  }

  const contentEl = document.createElement('div')
  contentEl.style.cssText =
    'cursor: pointer; word-break: break-all; line-height: 1.4; white-space: pre-wrap; border-radius: 2px; transition: background .15s;'
  contentEl.textContent = meme.content
  contentEl.title = '点击发送'
  contentEl.addEventListener('mouseenter', () => {
    contentEl.style.background = 'var(--bg2, #f0f0f0)'
  })
  contentEl.addEventListener('mouseleave', () => {
    contentEl.style.background = ''
  })
  contentWrap.appendChild(contentEl)

  const actionsWrap = document.createElement('div')
  actionsWrap.style.cssText = 'flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: .15em;'

  const copyBtn = document.createElement('button')
  copyBtn.textContent = '复制'
  copyBtn.title = '复制到剪贴板'
  copyBtn.style.cssText = 'font-size: 11px !important; cursor: pointer; padding: .1em .4em;'

  actionsWrap.appendChild(copyBtn)

  const countEl = document.createElement('span')
  countEl.className = 'meme-copy-count'
  countEl.style.cssText = 'font-size: 10px !important; color: #999; line-height: 1;'
  countEl.textContent = meme.copyCount > 0 ? `${meme.copyCount}次` : ''
  actionsWrap.appendChild(countEl)

  item.appendChild(contentWrap)
  item.appendChild(actionsWrap)

  return item
}

export function setupMemes(): void {
  const refreshBtn = document.getElementById('memesRefreshBtn') as HTMLButtonElement
  const sortSelect = document.getElementById('memesSortSelect') as HTMLSelectElement
  const statusEl = document.getElementById('memesStatus') as HTMLSpanElement
  const listEl = document.getElementById('memesList') as HTMLDivElement
  const msgLogs = document.getElementById('msgLogs') as HTMLTextAreaElement
  const maxLogLines = GM_getValue<number>('maxLogLines', 1000)

  if (!refreshBtn || !listEl) return

  function renderMemeList(memes: LaplaceInternal.HTTPS.Workers.MemeWithUser[]): void {
    listEl.innerHTML = ''
    for (const meme of memes) {
      const item = renderMemeItem(meme)

      const contentEl = item.querySelector('div > div:last-child') as HTMLDivElement
      const copyBtn = item.querySelector('button') as HTMLButtonElement
      const countEl = item.querySelector('.meme-copy-count') as HTMLSpanElement | null

      contentEl?.addEventListener('click', () => void sendMeme(meme.id, meme.content, countEl))
      copyBtn?.addEventListener('click', () => void copyMeme(meme.id, meme.content, copyBtn, countEl))

      listEl.appendChild(item)
    }
  }

  async function loadMemes(): Promise<void> {
    refreshBtn.disabled = true
    refreshBtn.textContent = '加载中…'
    statusEl.style.color = '#666'

    const sortBy = (sortSelect?.value as MemeSortBy) || 'lastCopiedAt'

    try {
      const roomId = await ensureRoomId()
      const memes = await fetchMemes(roomId, sortBy)

      if (memes.length === 0) {
        listEl.innerHTML = ''
        statusEl.textContent = '当前房间暂无烂梗'
        return
      }

      statusEl.textContent = ''
      statusEl.append(`${memes.length} 条 `)
      const contributeLink = document.createElement('a')
      contributeLink.href = 'https://laplace.live/memes'
      contributeLink.target = '_blank'
      contributeLink.textContent = '贡献烂梗'
      contributeLink.style.cssText = 'color: #3b82f6; text-decoration: none;'
      statusEl.appendChild(contributeLink)

      renderMemeList(memes)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      statusEl.textContent = `加载失败: ${msg}`
      statusEl.style.color = '#f44'
    } finally {
      refreshBtn.disabled = false
      refreshBtn.textContent = '刷新'
    }
  }

  function updateCopyCount(countEl: HTMLSpanElement | null, newCount: number): void {
    if (countEl && newCount > 0) countEl.textContent = `${newCount}次`
  }

  async function sendMeme(memeId: number, content: string, countEl: HTMLSpanElement | null): Promise<void> {
    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendToLimitedLog(msgLogs, '❌ 未找到登录信息，请先登录 Bilibili', maxLogLines)
        return
      }

      const processed = applyReplacements(content)
      const result = await sendDanmaku(processed, roomId, csrfToken)

      if (result.success) {
        const display = content !== processed ? `${content} → ${processed}` : processed
        appendToLimitedLog(msgLogs, `✅ 烂梗: ${display}`, maxLogLines)
      } else {
        let errorMsg = result.error ?? '未知错误'
        if (result.error === 'f' || result.error?.includes('f')) errorMsg = 'f - 包含全局屏蔽词'
        else if (result.error === 'k' || result.error?.includes('k')) errorMsg = 'k - 包含房间屏蔽词'
        const display = content !== processed ? `${content} → ${processed}` : processed
        appendToLimitedLog(msgLogs, `❌ 烂梗: ${display}，原因：${errorMsg}`, maxLogLines)
      }

      const newCount = await reportMemeCopy(memeId)
      if (newCount !== null) updateCopyCount(countEl, newCount)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendToLimitedLog(msgLogs, `🔴 发送出错：${msg}`, maxLogLines)
    }
  }

  async function copyMeme(
    memeId: number,
    content: string,
    btn: HTMLButtonElement,
    countEl: HTMLSpanElement | null
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = content
      ta.style.cssText = 'position:fixed;left:-9999px;'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }

    const original = btn.textContent
    btn.textContent = '已复制'
    setTimeout(() => {
      btn.textContent = original
    }, 1500)

    const newCount = await reportMemeCopy(memeId)
    if (newCount !== null) updateCopyCount(countEl, newCount)
  }

  refreshBtn.addEventListener('click', () => void loadMemes())
  sortSelect?.addEventListener('change', () => void loadMemes())

  void loadMemes()
}
