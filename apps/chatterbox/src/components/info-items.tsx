import { useSignal } from '@preact/signals'
import { IconBriefcase, IconBuildingCommunity, IconDroplet, IconNotes } from '@tabler/icons-preact'
import { cn } from 'cn'
import type { ComponentChildren } from 'preact'
import { useLayoutEffect } from 'preact/hooks'

import {
  type BilibiliUserData,
  bilibiliUserData,
  bilibiliUserError,
  bilibiliUserLoading,
  ensureBilibiliUserData,
  ensureFertilityData,
  type FertilityData,
  fertilityData,
  fertilityError,
  fertilityLoading,
  getFertilityDisplay,
  infoCurrentUid,
  infoOpusMeta,
  isFertilityProjected,
} from '../lib/info-status'
import {
  cachedStreamerUid,
  infoFertilityEnabled,
  infoGuildEnabled,
  infoMcnEnabled,
  statusBarInfoCollapsed,
} from '../lib/store'
import { getUserNote } from '../lib/user-notes'
import { buildOvuContributeUrl, formatRelativeDate, getGraphemes, trimText } from '../lib/utils'
import { STATUS_BAR_BUTTON_CLASS, StatusBarCollapsible, StatusBarFold } from './status-bar'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { UserNoteEditor } from './user-note-editor'

/** Status bar items for `infoCurrentUid`: 魔法期 / 公会 / MCN (each toggle-gated) plus the always-on local 备注. */
export function InfoItems() {
  // Live-page identity bridge; no-op on space/opus pages (main.tsx sets infoCurrentUid before mount).
  useLayoutEffect(() => {
    const uid = cachedStreamerUid.value
    if (uid !== null && infoCurrentUid.value === null) infoCurrentUid.value = uid
  }, [cachedStreamerUid.value])

  return (
    <>
      {infoFertilityEnabled.value && <FertilityItem />}
      {infoGuildEnabled.value && (
        <AffiliationItem
          id='laplace-info-guild'
          topic='公会'
          icon={<IconBuildingCommunity size={16} stroke={2} />}
          noneLabel='无公会'
          noneDetail='暂无公会记录'
          selectHistory={data => data.guildInfo?.history ?? []}
        />
      )}
      {infoMcnEnabled.value && (
        <AffiliationItem
          id='laplace-info-mcn'
          topic='MCN'
          icon={<IconBriefcase size={16} stroke={2} />}
          noneLabel='无 MCN'
          noneDetail='暂无 MCN 记录'
          selectHistory={data => (data.mcnInfo?.history ?? []).map(e => ({ name: e.mcnName, updatedAt: e.updatedAt }))}
        />
      )}
      <NoteItem />
    </>
  )
}

/** `InfoItems` with the live-room fold toggle; the fold state carries over across rooms. */
export function FoldableInfoItems() {
  const collapsed = statusBarInfoCollapsed.value
  return (
    <StatusBarFold
      collapsed={collapsed}
      onToggle={() => (statusBarInfoCollapsed.value = !statusBarInfoCollapsed.value)}
    >
      <InfoItems />
    </StatusBarFold>
  )
}

type NoData = { state: 'loading' | 'empty' } | { state: 'failed'; error: string }
type LoadState<T> = { state: 'ready'; data: T } | NoData

/** Precedence: unresolved uid or first load > error > 404 > data. */
function loadState<T>(uid: number | null, loading: boolean, error: string | null, data: T | null): LoadState<T> {
  if (uid === null || (loading && data === null)) return { state: 'loading' }
  if (error) return { state: 'failed', error }
  return data === null ? { state: 'empty' } : { state: 'ready', data }
}

/** Start an item's fetch in a layout effect, so a newly shown item paints 加载中 instead of flashing 暂无数据. */
function useInfoFetch(ensure: (uid: number | null) => void, uid: number | null): void {
  useLayoutEffect(() => ensure(uid), [ensure, uid])
}

type Tone = 'dim' | 'error'

interface ChipFace {
  /** Inline text beside the icon; dropped when the status bar is compact. */
  label?: ComponentChildren
  /** Tooltip and accessible-name text after the `topic：` prefix; carries the full text when `label` truncates. */
  detail: string
  tone?: Tone
}

const NO_DATA_FACE: Record<NoData['state'], { text: string; tone: Tone }> = {
  loading: { text: '加载中…', tone: 'dim' },
  failed: { text: '加载失败', tone: 'error' },
  empty: { text: '暂无数据', tone: 'dim' },
}

function noDataFace(status: NoData): ChipFace {
  const { text, tone } = NO_DATA_FACE[status.state]
  return { label: text, detail: status.state === 'failed' ? `${text}（${status.error}）` : text, tone }
}

interface InfoChipProps {
  id: string
  /** Popover title and tooltip prefix. */
  topic: string
  icon: ComponentChildren
  face: ChipFace
  /** Popover width class. */
  panelClass: string
  /** Header content beside the title. */
  headerExtra?: (uid: number) => ComponentChildren
  /** Runs when the popover opens; data items re-run their fetch so a failed load retries. */
  onOpen?: () => void
  children: (uid: number) => ComponentChildren
}

/** Bar chip summarizing one topic in a line, with the full section in its popover. */
function InfoChip({ id, topic, icon, face, panelClass, headerExtra, onOpen, children }: InfoChipProps) {
  const open = useSignal(false)
  const uid = infoCurrentUid.value
  const name = `${topic}：${face.detail}`

  return (
    <Popover
      open={open.value}
      onOpenChange={v => {
        open.value = v
        if (v) onOpen?.()
      }}
    >
      <PopoverTrigger>
        <button
          type='button'
          id={id}
          title={name}
          aria-label={name}
          aria-haspopup='dialog'
          aria-expanded={open.value}
          class={cn(
            STATUS_BAR_BUTTON_CLASS,
            'bg-ga6',
            face.tone === 'dim' && 'text-white/70',
            face.tone === 'error' && 'text-red-200'
          )}
        >
          {icon}
          {face.label !== undefined && (
            <StatusBarCollapsible>
              <span class='ml-1 max-w-32 truncate'>{face.label}</span>
            </StatusBarCollapsible>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side='top' align='end' className={cn('p-3 text-[13px]', panelClass)}>
        {uid === null ? (
          <div class='text-ga6'>正在解析当前页面 UID…</div>
        ) : (
          <div class='flex flex-col gap-2'>
            <div class='flex items-center justify-between gap-2'>
              <div class='flex items-center gap-2'>
                <span class='font-bold'>{topic}</span>
                {headerExtra?.(uid)}
              </div>
              <a
                href={`https://laplace.live/user/${uid}`}
                target='_blank'
                rel='noopener'
                class='text-link no-underline'
              >
                UID {uid} ↗
              </a>
            </div>
            {children(uid)}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function PanelStatus({ status }: { status: NoData }) {
  if (status.state === 'failed') return <div class='text-[#f44]'>加载失败：{status.error}</div>
  return <div class='text-ga6'>{status.state === 'loading' ? '正在加载…' : '暂无数据'}</div>
}

function FertilityItem() {
  const uid = infoCurrentUid.value
  useInfoFetch(ensureFertilityData, uid)
  const result = loadState(uid, fertilityLoading.value, fertilityError.value, fertilityData.value)

  let icon: ComponentChildren = <IconDroplet size={16} stroke={2} />
  let face: ChipFace
  if (result.state === 'ready') {
    const display = getFertilityDisplay(result.data.status)
    const projected = isFertilityProjected(result.data)
    icon = <span class='text-base leading-none'>{display.emoji}</span>
    face = {
      label: (
        <>
          {display.label}
          {projected && <span class='ml-1 opacity-70'>推测</span>}
        </>
      ),
      detail: `${display.label}${projected ? '（推测）' : ''}，周期第 ${result.data.dayInCycle} 天`,
    }
  } else {
    face = noDataFace(result)
  }

  return (
    <InfoChip
      id='laplace-info-fertility'
      topic='魔法期'
      icon={icon}
      face={face}
      panelClass='w-96'
      // Shown regardless of data state so viewers can contribute when there's no data yet.
      headerExtra={uid => <ContributeLink uid={uid} />}
      onOpen={() => ensureFertilityData(uid)}
    >
      {() => (result.state === 'ready' ? <FertilityCard data={result.data} /> : <PanelStatus status={result} />)}
    </InfoChip>
  )
}

function ContributeLink({ uid }: { uid: number }) {
  // `source`/`date` only populated on /opus/* pages; off-opus the link carries just `?uid=…`.
  const opus = infoOpusMeta.value
  return (
    <a
      href={buildOvuContributeUrl(uid, { source: opus?.source, date: opus?.date })}
      target='_blank'
      rel='noopener'
      class='text-brand no-underline'
    >
      贡献数据 ↗
    </a>
  )
}

function FertilityCard({ data }: { data: FertilityData }) {
  const display = getFertilityDisplay(data.status)
  // `nextPeriod` is ISO YYYY-MM-DD; fall back to the raw string if it won't parse.
  let nextPeriodText = data.nextPeriod
  const parsed = new Date(data.nextPeriod)
  if (!Number.isNaN(parsed.getTime())) {
    nextPeriodText = parsed.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  const projected = isFertilityProjected(data)

  return (
    <div class='flex flex-col gap-1'>
      <div class='flex items-center gap-1'>
        <span
          class='inline-flex items-center gap-1 rounded px-1.5 py-0.5'
          style={{ color: display.color, background: display.bg }}
        >
          <span>{display.emoji}</span>
          <span>{display.label}</span>
          {projected && <span class='text-ga6'>(推测)</span>}
        </span>
      </div>
      <div class='text-ga6'>
        周期第 {data.dayInCycle} 天 / 共 {data.effectiveCycleLength} 天 · 下次预计 {nextPeriodText}
      </div>
      <div class='text-ga6'>
        数据来源 {data.dataPoints} 条{projected && ` · 已推测 ${data.cyclesElapsedSinceObservation} 个周期`}
      </div>
    </div>
  )
}

interface HistoryEntry {
  name: string
  /** Unix ms. */
  updatedAt: number
}

interface AffiliationItemProps {
  id: string
  topic: string
  icon: ComponentChildren
  /** Bar text when the user has no record for this topic. */
  noneLabel: string
  noneDetail: string
  selectHistory: (data: BilibiliUserData) => HistoryEntry[]
}

/** 公会 / MCN chip: the current one on the bar, full history in the popover; both share the BilibiliUser fetch. */
function AffiliationItem({ id, topic, icon, noneLabel, noneDetail, selectHistory }: AffiliationItemProps) {
  const uid = infoCurrentUid.value
  useInfoFetch(ensureBilibiliUserData, uid)
  const result = loadState(uid, bilibiliUserLoading.value, bilibiliUserError.value, bilibiliUserData.value)
  // Upstream order isn't guaranteed; sort newest-first so entry 0 is the current one.
  const history =
    result.state === 'ready' ? [...selectHistory(result.data)].sort((a, b) => b.updatedAt - a.updatedAt) : []
  const current = history[0]

  let face: ChipFace
  if (result.state !== 'ready') face = noDataFace(result)
  else if (current) face = { label: current.name, detail: current.name }
  else face = { label: noneLabel, detail: noneDetail, tone: 'dim' }

  return (
    <InfoChip
      id={id}
      topic={topic}
      icon={icon}
      face={face}
      panelClass='w-80'
      onOpen={() => ensureBilibiliUserData(uid)}
    >
      {() =>
        result.state === 'ready' ? (
          <HistoryList entries={history} noneDetail={noneDetail} />
        ) : (
          <PanelStatus status={result} />
        )
      }
    </InfoChip>
  )
}

function HistoryList({ entries, noneDetail }: { entries: HistoryEntry[]; noneDetail: string }) {
  if (entries.length === 0) return <div class='text-ga6'>{noneDetail}</div>
  return (
    <ul class='m-0 flex list-none flex-col gap-1 p-0'>
      {entries.map((entry, i) => (
        <li key={`${entry.name}-${entry.updatedAt}`} class='flex items-baseline justify-between gap-2'>
          <span class={i === 0 ? 'font-medium' : 'text-ga6'}>{entry.name}</span>
          <span class='shrink-0 text-ga6'>{formatRelativeDate(entry.updatedAt)}</span>
        </li>
      ))}
    </ul>
  )
}

/** Tooltip cap so a long note doesn't become a wall of text. */
const NOTE_DETAIL_MAX_GRAPHEMES = 200

function NoteItem() {
  const text = getUserNote(infoCurrentUid.value)?.note.trim() ?? ''
  const face: ChipFace = text
    ? {
        label: text.split(/\r?\n/, 1)[0],
        detail:
          getGraphemes(text).length > NOTE_DETAIL_MAX_GRAPHEMES
            ? `${trimText(text, NOTE_DETAIL_MAX_GRAPHEMES)[0]}…`
            : text,
      }
    : { detail: '点击添加', tone: 'dim' }

  return (
    <InfoChip
      id='laplace-info-note'
      topic='用户备注'
      icon={<IconNotes size={16} stroke={2} color={text ? '#ffd84d' : undefined} />}
      face={face}
      panelClass='w-100'
    >
      {uid => <UserNoteEditor uid={uid} />}
    </InfoChip>
  )
}
