import { useSignal } from '@preact/signals'
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'

import type { LaplaceMemeWithSource } from '../lib/sbhzm-client'

import { ensureRoomId, getCsrfToken } from '../lib/api'
import { reportCbMemeCopy } from '../lib/cb-backend-client'
import { copyTextToClipboard } from '../lib/clipboard'
import { formatLockedEmoticonReject, isLockedEmoticon } from '../lib/emoticon'
import { reportLaplaceMemeCopy } from '../lib/laplace-client'
import { appendLog, notifyUser } from '../lib/log'
import { ignoreMemeCandidate } from '../lib/meme-contributor'
import { fetchAllMemes, type MemeSortBy, sortMemes } from '../lib/meme-fetch'
import { getMemeSourceForRoom } from '../lib/meme-sources'
import { refreshTrendingMemes } from '../lib/meme-trending'
import { applyReplacements } from '../lib/replacement'
import { maybeProbeSbhzmFreshness } from '../lib/sbhzm-freshness-probe'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import {
  cachedRoomId,
  cachedStreamerUid,
  currentMemesList,
  enableMemeContribution,
  maxLength,
  memeContributorCandidates,
  msgSendInterval,
  optimizeLayout,
} from '../lib/store'
import { cbBackendEnabled, currentMemesListRoomId } from '../lib/store-meme'
import { processMessages } from '../lib/utils'
import { CbSubmitRow } from './cb-submit-row'
import { MemeTagsBar } from './meme-tags-bar'
import { SbhzmSubmitRow } from './sbhzm-submit-row'
import { TrendingBadge } from './trending-badge'

/** 候选梗当前展开的提交目标:同时只能开一个,避免 UI 拥挤。 */
type SubmittingTarget = { text: string; target: 'sbhzm' | 'cb' } | null

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

function SourceBadge({ source }: { source: 'laplace' | 'sbhzm' | 'cb' | undefined }) {
  if (!source || source === 'laplace') return null
  // sbhzm 绿色 H,cb(chatterbox-cloud)蓝色 C,占位很小避免抢内容
  const config =
    source === 'sbhzm'
      ? { letter: 'H', bg: '#10b981', title: '来自社区专属梗库（sbhzm.cn）' }
      : { letter: 'C', bg: '#3b82f6', title: '来自 chatterbox-cloud 自建梗库' }
  return (
    <span
      title={config.title}
      style={{
        display: 'inline-block',
        flexShrink: 0,
        marginRight: '.3em',
        padding: '0 .3em',
        fontSize: '9px',
        lineHeight: 1.6,
        color: '#fff',
        background: config.bg,
        borderRadius: '2px',
        fontWeight: 'bold',
        verticalAlign: 'middle',
      }}
    >
      {config.letter}
    </span>
  )
}

function MemeItem({
  meme,
  onUpdateCount,
  onTagClick,
}: {
  meme: LaplaceMemeWithSource
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
        if (isLockedEmoticon(segment)) {
          const label = total > 1 ? `烂梗表情 [${i + 1}/${total}]` : '烂梗表情'
          appendLog(formatLockedEmoticonReject(segment, label))
          continue
        }

        const result = await enqueueDanmaku(segment, roomId, csrfToken, SendPriority.MANUAL)
        const label = total > 1 ? `烂梗 [${i + 1}/${total}]` : '烂梗'
        const display = wasReplaced && total === 1 ? `${meme.content} → ${segment}` : segment

        appendLog(result, label, display)

        if (i < total - 1) {
          await new Promise(r => setTimeout(r, msgSendInterval.value * 1000))
        }
      }

      // 按来源分别回报复制次数:
      //   - laplace(默认):POST workers.vrp.moe/laplace/meme-copy/:id
      //   - cb(自建):POST <backend>/memes/:id/copy
      //   - sbhzm:不回报(合成负 id,sbhzm.cn 没有 public 复制计数 API)
      if (meme.id > 0) {
        let newCount: number | null = null
        if (meme._source === 'cb') {
          newCount = await reportCbMemeCopy(meme.id)
        } else if (meme._source === 'laplace' || meme._source == null) {
          newCount = await reportLaplaceMemeCopy(meme.id)
        }
        if (newCount !== null) onUpdateCount(meme.id, newCount)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(meme.content)
    if (!ok) {
      notifyUser('error', '复制烂梗失败，请手动复制', meme.content)
      return
    }
    copyLabel.value = '已复制'
    setTimeout(() => {
      copyLabel.value = '复制'
    }, 1500)
    if (meme.id > 0) {
      let newCount: number | null = null
      if (meme._source === 'cb') {
        newCount = await reportCbMemeCopy(meme.id)
      } else if (meme._source === 'laplace' || meme._source == null) {
        newCount = await reportLaplaceMemeCopy(meme.id)
      }
      if (newCount !== null) onUpdateCount(meme.id, newCount)
    }
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
                  className='cb-tag'
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
                    '--cb-tag-bg': bgColor,
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
          <SourceBadge source={meme._source} />
          <TrendingBadge content={meme.content} />
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

/**
 * FLIP 动画的最大列表大小。当 LAPLACE + sbhzm 合并后梗数巨大（灰泽满房 ~1800 条），
 * 在 useLayoutEffect 里同步交替 read (`getBoundingClientRect`) + write (`style.transform`)
 * 会强制每次都触发整页 layout 回流——~1800 次 = 浏览器主线程冻死。
 * 超过这个阈值就跳过动画（只换顺序，不做位移过渡）。
 */
const FLIP_MAX_ITEMS = 300

export function MemesList() {
  const memes = useSignal<LaplaceMemeWithSource[]>([])
  const sortBy = useSignal<MemeSortBy>('lastCopiedAt')
  const filterText = useSignal('')
  /** 来源过滤：'all'（默认） / 'laplace' / 'sbhzm'。仅在双源直播间显示选项。 */
  const sourceFilter = useSignal<'all' | 'laplace' | 'sbhzm'>('all')
  /** 当前正在打开 sbhzm 上传面板的候选 text。同时只允许一个候选展开，避免上传混乱。 */
  /** 当前展开的候选梗 + 目标(sbhzm 或 cb)。同时只能开一个候选 + 一个目标。 */
  const submittingFor = useSignal<SubmittingTarget>(null)
  const status = useSignal('')
  const statusColor = useSignal('#666')
  const loading = useSignal(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevRectsRef = useRef<Map<number, DOMRect>>(new Map())

  // 当前房间是否有专属梗源（如灰泽满）。命中时启用 sbhzm 拉取、source 过滤、智驾面板。
  const memeSource = getMemeSourceForRoom(cachedRoomId.value)

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
      // 重新查梗源（若 silent 刷新跨过房间切换）
      const liveSource = getMemeSourceForRoom(roomId)
      const data = await fetchAllMemes(roomId, sortBy.peek(), liveSource)

      if (data.length === 0) {
        memes.value = []
        currentMemesList.value = []
        // 空结果也标记成"这是这个房间的结果",防止之后下游误用上一房间的列表。
        currentMemesListRoomId.value = roomId
        status.value = '当前房间暂无烂梗'
        return
      }

      if (memes.peek().length > 0) capturePositions()
      // 多源时显示 "L:N + H:M + C:K"（仅展示存在的源），单源直接 "N 条"
      const counts = { L: 0, H: 0, C: 0 }
      for (const m of data) {
        if (m._source === 'sbhzm') counts.H++
        else if (m._source === 'cb') counts.C++
        else counts.L++
      }
      const parts: string[] = []
      if (counts.L) parts.push(`L:${counts.L}`)
      if (counts.H) parts.push(`H:${counts.H}`)
      if (counts.C) parts.push(`C:${counts.C}`)
      status.value = parts.length > 1 ? parts.join(' + ') : `${data.length} 条`
      memes.value = data
      currentMemesList.value = data
      // Atomically 标记 list 属于哪个房间(读取方:智驾 decideHzmMount 的 memesRoomId 校验)。
      // 必须和 currentMemesList 同一同步 tick 写入,否则 SPA 切房间的窗口期会让下游误用旧列表。
      currentMemesListRoomId.value = roomId

      // Fire-and-forget refresh of the cross-room trending map. TTL-gated
      // inside the helper so calling this from every 30s loadMemes tick
      // collapses to one network request per 10 min. Failures are silent —
      // worst case the 🔥 badges just don't appear.
      // ALSO gated inside refreshTrendingMemes by `radarConsultEnabled`
      // (default OFF, opt-in via 设置 → live-meme-radar). When the toggle
      // is off this is a cheap no-op — zero network.
      void refreshTrendingMemes()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      status.value = `加载失败: ${msg}`
      statusColor.value = 'var(--cb-danger-text)'
    } finally {
      if (!silent) loading.value = false
    }
  }

  useLayoutEffect(() => {
    const el = containerRef.current
    const old = prevRectsRef.current
    if (!el || old.size === 0) return
    prevRectsRef.current = new Map()

    // 大列表（如灰泽满房合并后 1800 条）跳过 FLIP 动画——
    // read+write 交替会触发 N 次 layout 回流冻死页面。
    if (el.children.length > FLIP_MAX_ITEMS) return

    for (let i = 0; i < el.children.length; i++) {
      const node = el.children[i]
      if (!(node instanceof HTMLElement)) continue
      const id = Number(node.dataset.memeId)
      const prev = old.get(id)
      if (!prev) continue

      const curr = node.getBoundingClientRect()
      const dy = prev.top - curr.top
      if (Math.abs(dy) < 1) continue

      // 用 Web Animations API 而不是 CSS transition：自动取消已有动画,
      // 在快速重排时不会出现"上一条还没动完就被新值打断"的视觉残留。
      for (const anim of node.getAnimations()) anim.cancel()

      node.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], {
        duration: 300,
        easing: 'ease',
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
    // 烂梗库已经从 supporting feature 升级为顶级 section,常驻可见。无需再按
    // memesPanelOpen 闸门:进入直播间就拉一次,然后按 MEME_RELOAD_INTERVAL polling。
    void loadMemes()
    const timer = setInterval(() => void loadMemes({ silent: true }), MEME_RELOAD_INTERVAL)
    return () => clearInterval(timer)
  }, [sortBy.value, memeSource])

  // SBHZM 保鲜探测:每次 memes-list mount 时,30 分钟节流地拉一次 SBHZM 首页 +
  // mirror 推到后端。Phase D.1 起这是 SBHZM 数据保鲜的主要机制(后端 cron 只
  // 在用户长期离线时兜底)。详见 src/lib/sbhzm-freshness-probe.ts。
  useEffect(() => {
    void maybeProbeSbhzmFreshness(memeSource)
  }, [memeSource])

  // 烂梗库现在是顶级 section,常驻可见 —— 不再需要 details 折叠 + delayed-unmount
  // 的 close-animation hack。直接渲染。
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5em', marginTop: '.5em', marginBottom: '.5em' }}>
        <select
          style={{ fontSize: '12px' }}
          value={sortBy.value}
          onChange={e => {
            const v = e.currentTarget.value
            if (isMemeSortBy(v)) sortBy.value = v
          }}
        >
          <option value='lastCopiedAt'>最近使用</option>
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
          title='打开 LAPLACE 烂梗贡献页（LAPLACE 库供所有直播间共享）'
          style={{ color: '#288bb8', textDecoration: 'none', fontSize: '12px' }}
        >
          贡献到 LAPLACE
        </a>
        {memeSource && (
          <a
            href={memeSource.submitPage ?? memeSource.listEndpoint}
            target='_blank'
            rel='noopener'
            title={`打开 ${memeSource.name} 提交页（仅本房间烂梗库；推荐用候选行的「↑ 上传」按钮直接 API 提交）`}
            style={{ color: '#10b981', textDecoration: 'none', fontSize: '12px' }}
          >
            贡献到 {memeSource.name.replace('烂梗库', '')}
          </a>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '.25em', marginBottom: '.5em' }}>
        <input
          id='enableMemeContribution'
          type='checkbox'
          checked={enableMemeContribution.value}
          onInput={e => {
            enableMemeContribution.value = e.currentTarget.checked
          }}
        />
        <label htmlFor='enableMemeContribution' style={{ fontSize: '12px' }}>
          自动挖掘待贡献梗
        </label>
      </div>

      {enableMemeContribution.value && memeContributorCandidates.value.length > 0 && (
        <div style={{ marginBottom: '.5em' }}>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '.25em' }}>
            候选梗（{memeContributorCandidates.value.length} 条）：
          </div>
          {memeContributorCandidates.value.map(text => {
            const expanded = submittingFor.value
            const isSbhzmOpen = expanded?.text === text && expanded.target === 'sbhzm'
            const isCbOpen = expanded?.text === text && expanded.target === 'cb'
            const otherFormOpenForThisText = expanded !== null && expanded.text === text && !isSbhzmOpen && !isCbOpen
            const otherFormOpenForAnotherText = expanded !== null && expanded.text !== text
            return (
              <div
                key={text}
                style={{
                  padding: '.2em 0',
                  borderBottom: '1px solid var(--Ga2, #eee)',
                }}
              >
                <div style={{ display: 'flex', gap: '.4em', alignItems: 'center' }}>
                  <span style={{ flex: 1, fontSize: '12px', wordBreak: 'break-all' }}>{text}</span>
                  <button
                    type='button'
                    style={{ fontSize: '11px', cursor: 'pointer', padding: '.1em .4em', flexShrink: 0 }}
                    title='复制到剪贴板，并打开 LAPLACE 贡献页面'
                    onClick={() => {
                      const id = cachedRoomId.peek()
                      if (id === null) return
                      void copyTextToClipboard(text)
                      const uid = cachedStreamerUid.value
                      window.open(`https://laplace.live/memes${uid ? `?contribute=${uid}` : ''}`, '_blank', 'noopener')
                      ignoreMemeCandidate(text, id)
                    }}
                  >
                    复制+贡献 LAPLACE
                  </button>
                  {memeSource && (
                    <button
                      type='button'
                      style={{
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '.1em .4em',
                        flexShrink: 0,
                        background: isSbhzmOpen ? '#10b981' : 'transparent',
                        color: isSbhzmOpen ? '#fff' : 'inherit',
                        border: '1px solid var(--Ga2, #ccc)',
                        borderRadius: '3px',
                        opacity: !isSbhzmOpen && (otherFormOpenForThisText || isCbOpen) ? 0.55 : 1,
                      }}
                      title={
                        isCbOpen
                          ? `当前正在贡献到 chatterbox-cloud。点击改为上传到 ${memeSource.name}（一次只能开一个表单）`
                          : otherFormOpenForAnotherText
                            ? '另一条候选的表单正打开；点这里会切换到本条'
                            : `选标签后上传到 ${memeSource.name}（API：POST /api/admin/memes）`
                      }
                      onClick={() => {
                        submittingFor.value = isSbhzmOpen ? null : { text, target: 'sbhzm' }
                      }}
                    >
                      {isSbhzmOpen ? '收起' : `↑ 上传到 ${memeSource.name.replace('烂梗库', '')}`}
                    </button>
                  )}
                  {cbBackendEnabled.value && (
                    <button
                      type='button'
                      style={{
                        fontSize: '11px',
                        cursor: 'pointer',
                        padding: '.1em .4em',
                        flexShrink: 0,
                        background: isCbOpen ? '#3b82f6' : 'transparent',
                        color: isCbOpen ? '#fff' : '#3b82f6',
                        border: '1px solid #3b82f6',
                        borderRadius: '3px',
                        opacity: !isCbOpen && (otherFormOpenForThisText || isSbhzmOpen) ? 0.55 : 1,
                      }}
                      title={
                        isSbhzmOpen
                          ? '当前正在上传到 SBHZM。点击改为贡献到 chatterbox-cloud（一次只能开一个表单）'
                          : otherFormOpenForAnotherText
                            ? '另一条候选的表单正打开；点这里会切换到本条'
                            : '选标签后提交到 chatterbox-cloud(进 pending 队列等管理员审核)'
                      }
                      onClick={() => {
                        submittingFor.value = isCbOpen ? null : { text, target: 'cb' }
                      }}
                    >
                      {isCbOpen ? '收起' : '↑ 贡献到 cb'}
                    </button>
                  )}
                  <button
                    type='button'
                    style={{ fontSize: '11px', cursor: 'pointer', padding: '.1em .4em', flexShrink: 0 }}
                    onClick={() => {
                      const id = cachedRoomId.peek()
                      if (id !== null) ignoreMemeCandidate(text, id)
                      if (submittingFor.value?.text === text) submittingFor.value = null
                    }}
                  >
                    忽略
                  </button>
                </div>
                {isSbhzmOpen && memeSource && (
                  <SbhzmSubmitRow
                    content={text}
                    source={memeSource}
                    onDone={() => {
                      const id = cachedRoomId.peek()
                      if (id !== null) ignoreMemeCandidate(text, id)
                      submittingFor.value = null
                    }}
                    onCancel={() => {
                      submittingFor.value = null
                    }}
                  />
                )}
                {isCbOpen && (
                  <CbSubmitRow
                    content={text}
                    source={memeSource}
                    onDone={() => {
                      const id = cachedRoomId.peek()
                      if (id !== null) ignoreMemeCandidate(text, id)
                      submittingFor.value = null
                    }}
                    onCancel={() => {
                      submittingFor.value = null
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      )}

      {memes.value.length > 0 && (
        <input
          type='text'
          placeholder='筛选烂梗…'
          value={filterText.value}
          onInput={e => {
            filterText.value = e.currentTarget.value
          }}
          style={{ boxSizing: 'border-box', width: '100%', marginBottom: '.5em' }}
        />
      )}

      {/* 双源直播间：来源过滤药丸 */}
      {memeSource && memes.value.length > 0 && (
        <div style={{ display: 'flex', gap: '.3em', marginBottom: '.4em', fontSize: '11px' }}>
          {(['all', 'laplace', 'sbhzm'] as const).map(s => (
            <button
              key={s}
              type='button'
              onClick={() => {
                sourceFilter.value = s
              }}
              style={{
                padding: '.1em .5em',
                borderRadius: '999px',
                border: '1px solid var(--Ga2, #ccc)',
                background: sourceFilter.value === s ? 'var(--Ga2, #eee)' : 'transparent',
                fontWeight: sourceFilter.value === s ? 'bold' : 'normal',
                cursor: 'pointer',
              }}
            >
              {s === 'all' ? '全部' : s === 'laplace' ? 'LAPLACE' : memeSource.name}
            </button>
          ))}
        </div>
      )}

      {/* 顶部 tag 标签栏：根据当前梗列表聚合可点击 */}
      {memes.value.length > 0 && <MemeTagsBar memes={memes.value} filterText={filterText} />}

      <div
        ref={containerRef}
        style={{
          overflowY: 'auto',
          marginLeft: '-10px',
          marginRight: '-10px',
          paddingInline: '10px',
          maxHeight: optimizeLayout.value ? '180px' : '240px',
        }}
      >
        {memes.value
          .filter(m => {
            if (sourceFilter.value === 'laplace' && m._source === 'sbhzm') return false
            if (sourceFilter.value === 'sbhzm' && m._source !== 'sbhzm') return false
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
  )
}
