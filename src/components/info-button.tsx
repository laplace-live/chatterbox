import { useSignal } from '@preact/signals'
import { IconInfoCircle } from '@tabler/icons-preact'
import { useEffect } from 'preact/hooks'

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
} from '../lib/info-status'
import { cachedStreamerUid, infoFertilityEnabled, infoGuildEnabled, infoMcnEnabled } from '../lib/store'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * Read-only metadata popover, mounted in the bottom-right toggle cluster
 * next to the audio-only and 弹幕助手 buttons. Shows up to three data
 * categories — 魔法期 (fertility), 公会 (guild), MCN — each gated by
 * an independent settings toggle so the user can opt into exactly what
 * they want and never trigger the other endpoints.
 *
 * The button itself is hidden entirely when ALL three categories are
 * off. This keeps the toggle cluster from sprouting a meaningless icon
 * for users who don't want this feature at all, and means "enable from
 * the settings tab" is the canonical activation path. Once any category
 * is on, the button surfaces a one-glance indicator on its face — the
 * fertility emoji when that's the highest-priority category with data,
 * or a generic info icon otherwise.
 *
 * Data resolution is uid-driven, with the uid coming from whichever
 * mount surface owns identity:
 *   - live.bilibili.com: `cachedStreamerUid` (set by `ensureRoomId`)
 *   - space.bilibili.com: parsed from the URL by `main.tsx` and written
 *     to `infoCurrentUid` directly
 * Both paths end up populating `infoCurrentUid`, which is what this
 * component reads. We mirror `cachedStreamerUid` into `infoCurrentUid`
 * on live pages here (rather than in `info-status.ts`) so the data
 * module stays surface-agnostic.
 */
export function InfoButton() {
  const open = useSignal(false)

  // Hide the button when the user hasn't opted into any category.
  // Reading `.value` on all three so the surrounding signal context
  // re-renders on toggle changes.
  const anyEnabled = infoFertilityEnabled.value || infoGuildEnabled.value || infoMcnEnabled.value

  // Live-page identity bridge: when `cachedStreamerUid` resolves, fan it
  // into `infoCurrentUid`. On the space page main.tsx populates
  // `infoCurrentUid` directly from the URL before mount, so this effect
  // is a no-op there.
  useEffect(() => {
    const uid = cachedStreamerUid.value
    if (uid !== null && infoCurrentUid.value === null) {
      infoCurrentUid.value = uid
    }
  }, [cachedStreamerUid.value])

  // Kick off data fetches whenever the uid OR any enabled toggle
  // changes. `ensureInfoData` dedupes via its internal cache + in-flight
  // map, so flipping a toggle on after the uid already resolved still
  // fires exactly one request per endpoint.
  useEffect(() => {
    if (!anyEnabled) return
    ensureInfoData(infoCurrentUid.value)
  }, [infoCurrentUid.value, infoFertilityEnabled.value, infoGuildEnabled.value, infoMcnEnabled.value])

  if (!anyEnabled) return null

  // Button face: prefer the fertility emoji when that category is on and
  // data has loaded; otherwise show the neutral info icon. Loading and
  // error states fall back to the icon too — the popover surfaces
  // status text, the button itself stays calm.
  const fertilityEmoji =
    infoFertilityEnabled.value && fertilityData.value ? getFertilityDisplay(fertilityData.value.status).emoji : null

  return (
    <Popover open={open.value} onOpenChange={v => (open.value = v)}>
      <PopoverTrigger>
        <button
          type='button'
          id='laplace-info-toggle'
          title='主播额外信息'
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
        </button>
      </PopoverTrigger>
      <PopoverContent side='top' align='end' className='w-100 p-3'>
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

      {infoFertilityEnabled.value && <FertilitySection />}
      {infoGuildEnabled.value && <GuildSection />}
      {infoMcnEnabled.value && <McnSection />}
    </div>
  )
}

function SectionHeading({ children }: { children: preact.ComponentChildren }) {
  return <div class='font-bold text-ga6 uppercase tracking-wider'>{children}</div>
}

function StatusLine({ children, color }: { children: preact.ComponentChildren; color?: string }) {
  return <div style={color ? { color } : undefined}>{children}</div>
}

function FertilitySection() {
  const data = fertilityData.value
  const loading = fertilityLoading.value
  const error = fertilityError.value

  return (
    <section class='flex flex-col gap-1'>
      <SectionHeading>
        魔法期{' '}
        <a
          href={'https://laplace.live/ovu'}
          target={'_blank'}
          className={'font-mono font-normal text-brand text-sm'}
          rel='noopener'
        >
          /ovu
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
  // `nextPeriod` is ISO YYYY-MM-DD; render in local-friendly form.
  // Defensive parse: if the upstream ever returns a non-date we render
  // the raw string rather than throwing.
  let nextPeriodText = data.nextPeriod
  const parsed = new Date(data.nextPeriod)
  if (!Number.isNaN(parsed.getTime())) {
    nextPeriodText = parsed.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  const cyclesElapsed = data.cyclesElapsedSinceObservation
  // `cyclesElapsedSinceObservation` > 0 means the upstream is projecting
  // from a stale observation — flag it so the viewer knows the status
  // is inferred, not observed.
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
  // The guild section only renders the guild slice of `BilibiliUser`,
  // but the loading / error state is shared with MCN — we just don't
  // duplicate the spinner in both sections if one is on.
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
  // History is upstream-sorted (newest first by convention). Show up to
  // 5 most recent; anything older lives behind the "查看完整资料" link.
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
 * Compact "X 天前 / X 月前 / X 年前" formatter for upstream Unix ms
 * timestamps. We don't need second-precision — the data updates on the
 * order of days, so "5 分钟前" precision would be visually noisy and
 * also misleading (it'd suggest the upstream is real-time).
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
