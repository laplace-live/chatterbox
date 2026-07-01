import { useSignal } from '@preact/signals'
import { IconInfoCircle, IconNotes } from '@tabler/icons-preact'
import { useEffect, useRef } from 'preact/hooks'

import { cn } from '../lib/cn'
import {
  bilibiliUserData,
  bilibiliUserError,
  bilibiliUserLoading,
  ensureInfoData,
  fertilityData,
  fertilityError,
  fertilityLoading,
  getFertilityDisplay,
  infoCurrentUid,
  infoOpusMeta,
} from '../lib/info-status'
import { appendLog } from '../lib/log'
import { cachedStreamerUid, infoFertilityEnabled, infoGuildEnabled, infoMcnEnabled } from '../lib/store'
import { deleteUserNote, getUserNote, hasUserNote, setUserNote, userNotes } from '../lib/user-notes'
import { buildOvuContributeUrl } from '../lib/utils'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Textarea } from './ui/textarea'

/**
 * Read-only metadata popover (魔法期/公会/MCN, each toggle-gated) plus an
 * always-available local 用户备注 editor. Button stays visible even with
 * every remote toggle off so notes always have an entry point; toggles
 * only gate which sections render. uid comes from `infoCurrentUid`.
 */
export function InfoButton() {
  const open = useSignal(false)

  const anyRemoteEnabled = infoFertilityEnabled.value || infoGuildEnabled.value || infoMcnEnabled.value

  // Live-page identity bridge; no-op on space page (main.tsx sets infoCurrentUid before mount).
  useEffect(() => {
    const uid = cachedStreamerUid.value
    if (uid !== null && infoCurrentUid.value === null) {
      infoCurrentUid.value = uid
    }
  }, [cachedStreamerUid.value])

  // `ensureInfoData` dedupes via cache + in-flight map, so one request per endpoint.
  useEffect(() => {
    if (!anyRemoteEnabled) return
    ensureInfoData(infoCurrentUid.value)
  }, [infoCurrentUid.value, infoFertilityEnabled.value, infoGuildEnabled.value, infoMcnEnabled.value])

  // Touch `.value` to register the signal dep so the badge re-paints on note save/delete.
  void userNotes.value
  const noteExists = hasUserNote(infoCurrentUid.value)

  const fertilityEmoji =
    infoFertilityEnabled.value && fertilityData.value ? getFertilityDisplay(fertilityData.value.status).emoji : null

  return (
    <Popover open={open.value} onOpenChange={v => (open.value = v)}>
      <PopoverTrigger>
        <button
          type='button'
          id='laplace-info-toggle'
          title={noteExists ? '主播额外信息（已有备注）' : '主播额外信息'}
          class={cn(
            'appearance-none border-none outline-none',
            'cursor-pointer select-none',
            'h-8 rounded px-2 text-white',
            'inline-flex items-center justify-center gap-1',
            'bg-ga6'
          )}
        >
          {fertilityEmoji ? (
            <span class='text-base leading-none'>{fertilityEmoji}</span>
          ) : (
            <IconInfoCircle size={16} stroke={2} />
          )}
          {noteExists && <IconNotes size={14} stroke={2.2} color='#ffd84d' aria-label='已有备注' />}
        </button>
      </PopoverTrigger>
      <PopoverContent side='top' align='end' className='w-100 p-3 text-[13px]'>
        <InfoPopoverBody />
      </PopoverContent>
    </Popover>
  )
}

function InfoPopoverBody() {
  const uid = infoCurrentUid.value
  if (uid === null) {
    return <div class='text-ga6'>正在解析当前页面 UID…</div>
  }

  return (
    <div class='flex flex-col gap-3'>
      <div class='flex items-center justify-between gap-2'>
        <div class='font-bold'>主播额外信息</div>
        <a href={`https://laplace.live/user/${uid}`} target='_blank' rel='noopener' class='text-link no-underline'>
          UID {uid} ↗
        </a>
      </div>

      {infoFertilityEnabled.value && <FertilitySection uid={uid} />}
      {infoGuildEnabled.value && <GuildSection />}
      {infoMcnEnabled.value && <McnSection />}
      <UserNoteSection uid={uid} />
    </div>
  )
}

/**
 * Local-only note editor keyed by the popover's uid. Auto-saves on a 1.5s
 * debounce, flushed on blur and on popover close (the `[uid]` cleanup,
 * which captures its uid so drafts land under the right uid across nav).
 * Flush no-ops when unchanged. `setUserNote` trim-deletes on empty. No
 * per-save log line (delete still logs).
 */
function UserNoteSection({ uid }: { uid: number }) {
  const stored = getUserNote(uid)
  const draft = useSignal(stored?.note ?? '')
  const lastLoadedUid = useSignal<number | null>(null)
  const lastLoadedUpdatedAt = useSignal<number | null>(null)
  const saveStatus = useSignal<'idle' | 'saving' | 'saved'>('idle')

  // Refs, not signals: imperative timer handles, not rendered state.
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
    <section class='flex flex-col gap-1'>
      <SectionHeading>用户备注</SectionHeading>
      <Textarea
        value={draft.value}
        onInput={e => handleInput(e.currentTarget.value)}
        onBlur={commit}
        placeholder='给这位用户添加备注，支持多行文本，自动保存且仅本地…'
        className='min-h-24 text-[13px]'
        rows={4}
      />
      <div class='flex items-center justify-between gap-2'>
        <div class='flex items-center gap-2'>
          <span class='text-[11px] text-ga6'>
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
          {saveStatus.value === 'saving' && <span class='text-[11px] text-ga6'>正在保存…</span>}
          {saveStatus.value === 'saved' && <span class='text-[11px] text-brand'>已保存</span>}
        </div>
        {stored && (
          <Button variant='ghost' size='sm' className='text-[red]' onClick={handleDelete}>
            删除
          </Button>
        )}
      </div>
    </section>
  )
}

function SectionHeading({ children }: { children: preact.ComponentChildren }) {
  return <div class='font-bold text-ga6 uppercase tracking-wider'>{children}</div>
}

function StatusLine({ children, color }: { children: preact.ComponentChildren; color?: string }) {
  return <div style={color ? { color } : undefined}>{children}</div>
}

function FertilitySection({ uid }: { uid: number }) {
  const data = fertilityData.value
  const loading = fertilityLoading.value
  const error = fertilityError.value
  // `source`/`date` only populated on /opus/* pages; off-opus the link carries just `?uid=…`.
  const opus = infoOpusMeta.value
  const contributeUrl = buildOvuContributeUrl(uid, { source: opus?.source, date: opus?.date })

  return (
    <section class='flex flex-col gap-1'>
      <SectionHeading>
        魔法期 {/* Shown regardless of data state so viewers can contribute when there's no data yet. */}
        <a href={contributeUrl} target='_blank' rel='noopener' className='text-brand no-underline'>
          贡献数据 ↗
        </a>
      </SectionHeading>
      {loading && !data ? (
        <StatusLine color='var(--Ga6,#666)'>正在加载…</StatusLine>
      ) : error ? (
        <StatusLine color='#f44'>加载失败：{error}</StatusLine>
      ) : !data ? (
        <StatusLine color='var(--Ga6,#666)'>暂无数据</StatusLine>
      ) : (
        <FertilityCard data={data} />
      )}
    </section>
  )
}

function FertilityCard({ data }: { data: NonNullable<typeof fertilityData.value> }) {
  const display = getFertilityDisplay(data.status)
  // `nextPeriod` is ISO YYYY-MM-DD; fall back to the raw string if it won't parse.
  let nextPeriodText = data.nextPeriod
  const parsed = new Date(data.nextPeriod)
  if (!Number.isNaN(parsed.getTime())) {
    nextPeriodText = parsed.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  const cyclesElapsed = data.cyclesElapsedSinceObservation
  // > 0 means the status is projected from a stale observation, not observed.
  const stale = cyclesElapsed > 0

  return (
    <div class='flex flex-col gap-1'>
      <div class='flex items-center gap-1'>
        <span
          class='inline-flex items-center gap-1 rounded px-1.5 py-0.5'
          style={{ color: display.color, background: display.bg }}
        >
          <span>{display.emoji}</span>
          <span>{display.label}</span>
          {stale && <span class='text-ga6'>(推测)</span>}
        </span>
      </div>
      <div class='text-ga6'>
        周期第 {data.dayInCycle} 天 / 共 {data.effectiveCycleLength} 天 · 下次预计 {nextPeriodText}
      </div>
      <div class='text-ga6'>
        数据来源 {data.dataPoints} 条{stale && ` · 已推测 ${cyclesElapsed} 个周期`}
      </div>
    </div>
  )
}

function GuildSection() {
  const data = bilibiliUserData.value
  const loading = bilibiliUserLoading.value
  const error = bilibiliUserError.value
  // Loading/error state is shared with MCN (same `BilibiliUser` fetch).
  return (
    <section class='flex flex-col gap-1'>
      <SectionHeading>公会</SectionHeading>
      {loading && !data ? (
        <StatusLine color='var(--Ga6,#666)'>正在加载…</StatusLine>
      ) : error ? (
        <StatusLine color='#f44'>加载失败：{error}</StatusLine>
      ) : !data ? (
        <StatusLine color='var(--Ga6,#666)'>暂无数据</StatusLine>
      ) : (
        <GuildList history={data.guildInfo?.history ?? []} />
      )}
    </section>
  )
}

function GuildList({ history }: { history: { name: string; updatedAt: number }[] }) {
  if (history.length === 0) {
    return <StatusLine color='var(--Ga6,#666)'>暂无公会记录</StatusLine>
  }
  // Upstream-sorted newest-first; show the 5 most recent.
  const recent = history.slice(0, 5)
  return (
    <ul class='m-0 flex list-none flex-col gap-1 p-0'>
      {recent.map((entry, i) => (
        <li key={`${entry.name}-${entry.updatedAt}`} class='flex items-baseline justify-between gap-2'>
          <span class={i === 0 ? 'font-medium' : 'text-ga6'}>{entry.name}</span>
          <span class='text-[11px] text-ga6'>{formatRelativeDate(entry.updatedAt)}</span>
        </li>
      ))}
      {history.length > recent.length && (
        <li class='text-[11px] text-ga6'>… 还有 {history.length - recent.length} 条历史记录</li>
      )}
    </ul>
  )
}

function McnSection() {
  const data = bilibiliUserData.value
  const loading = bilibiliUserLoading.value
  const error = bilibiliUserError.value
  return (
    <section class='flex flex-col gap-1'>
      <SectionHeading>MCN</SectionHeading>
      {loading && !data ? (
        <StatusLine color='var(--Ga6,#666)'>正在加载…</StatusLine>
      ) : error ? (
        <StatusLine color='#f44'>加载失败：{error}</StatusLine>
      ) : !data?.mcnInfo ? (
        <StatusLine color='var(--Ga6,#666)'>暂无 MCN 记录</StatusLine>
      ) : (
        <McnList history={data.mcnInfo.history} />
      )}
    </section>
  )
}

function McnList({ history }: { history: { mcnName: string; updatedAt: number }[] }) {
  if (history.length === 0) {
    return <StatusLine color='var(--Ga6,#666)'>暂无 MCN 记录</StatusLine>
  }
  const recent = history.slice(0, 5)
  return (
    <ul class='m-0 flex list-none flex-col gap-1 p-0'>
      {recent.map((entry, i) => (
        <li key={`${entry.mcnName}-${entry.updatedAt}`} class='flex items-baseline justify-between gap-2'>
          <span class={i === 0 ? 'font-medium' : 'text-ga6'}>{entry.mcnName}</span>
          <span class='text-[11px] text-ga6'>{formatRelativeDate(entry.updatedAt)}</span>
        </li>
      ))}
      {history.length > recent.length && (
        <li class='text-[11px] text-ga6'>… 还有 {history.length - recent.length} 条历史记录</li>
      )}
    </ul>
  )
}

/**
 * Compact "X 天前/月前/年前" for Unix-ms timestamps; day granularity since
 * the data isn't real-time (finer precision would mislead).
 */
function formatRelativeDate(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '未知'
  const diff = Date.now() - ts
  if (diff < 0) return '未来'
  const day = 86400_000
  const days = Math.floor(diff / day)
  if (days < 1) return '今天'
  if (days < 30) return `${days} 天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} 个月前`
  const years = Math.floor(days / 365)
  return `${years} 年前`
}
