import { useSignal } from '@preact/signals'
import { IconInfoCircle, IconNotes } from '@tabler/icons-preact'
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
import { appendLog } from '../lib/log'
import { cachedStreamerUid, infoFertilityEnabled, infoGuildEnabled, infoMcnEnabled } from '../lib/store'
import { deleteUserNote, getUserNote, hasUserNote, setUserNote, userNotes } from '../lib/user-notes'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Textarea } from './ui/textarea'

/**
 * Read-only metadata popover, mounted in the bottom-right toggle cluster
 * next to the audio-only and 直播助手 buttons. Shows up to three remote
 * data categories — 魔法期 (fertility), 公会 (guild), MCN — each gated
 * by an independent settings toggle so the user can opt into exactly
 * what they want and never trigger the other endpoints. Plus a local
 * "用户备注" (user note) editor that's purely client-side and always
 * available (no enable toggle — it's local-only with zero network
 * cost, so there's nothing to opt into).
 *
 * The button is ALWAYS visible. Even with every remote info toggle off,
 * the user note editor needs a permanent entry point — otherwise there'd
 * be no way to add a first note to a uid with no existing note. The
 * per-category toggles only gate which SECTIONS render inside the
 * popover, not the popover's existence.
 *
 * The button face composes two layers:
 *   1. Primary icon: the fertility emoji when that category is on and
 *      data has loaded; otherwise a generic info icon.
 *   2. Note badge: rendered alongside (right of) the primary icon when
 *      the current uid has a stored note — so a viewer instantly sees
 *      "I've already written something about this person" without
 *      opening the popover. Tinted amber so it doesn't blend into the
 *      primary icon.
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

  // Re-read on every render so toggle / note edits trigger re-paints.
  const anyRemoteEnabled = infoFertilityEnabled.value || infoGuildEnabled.value || infoMcnEnabled.value

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

  // Kick off remote data fetches whenever the uid OR any remote toggle
  // changes. `ensureInfoData` dedupes via its internal cache + in-flight
  // map, so flipping a toggle on after the uid already resolved still
  // fires exactly one request per endpoint. User notes are intentionally
  // NOT a dep here — they live in GM storage, no fetch needed.
  useEffect(() => {
    if (!anyRemoteEnabled) return
    ensureInfoData(infoCurrentUid.value)
  }, [infoCurrentUid.value, infoFertilityEnabled.value, infoGuildEnabled.value, infoMcnEnabled.value])

  // Touch `userNotes.value` so the note badge re-paints when the user
  // saves / deletes a note. `hasUserNote` reads the same signal but
  // referencing `.value` here is what registers the dep with the
  // surrounding signal context.
  void userNotes.value
  const noteExists = hasUserNote(infoCurrentUid.value)

  // Button face composition: the main icon (fertility emoji when on +
  // has data, otherwise the generic info icon) PLUS a note badge
  // appended on the right when this uid has a stored note. The badge
  // lives alongside the main icon (rather than replacing it) so a
  // glance still tells the viewer what info categories are configured
  // — the note is additional context, not the whole story.
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
          {noteExists && (
            // Note badge sits to the right of the primary icon. Tinted
            // amber (#ffd84d) so it's visually distinct from the white
            // info / colored fertility icon and reads as "annotation"
            // rather than another status category.
            <IconNotes size={14} stroke={2.2} color='#ffd84d' aria-label='已有备注' />
          )}
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

      {infoFertilityEnabled.value && <FertilitySection />}
      {infoGuildEnabled.value && <GuildSection />}
      {infoMcnEnabled.value && <McnSection />}
      {/* 用户备注 always renders — it's local-only with no network cost
          and ungated by any toggle. */}
      <UserNoteSection uid={uid} />
    </div>
  )
}

/**
 * Local-only, multi-line note editor keyed by the popover's current
 * uid. Draft state is local to this component — we hydrate from
 * `getUserNote(uid)` whenever the uid changes, and only commit to GM
 * storage on the explicit 保存 button. This avoids per-keystroke writes
 * and lets the user 取消 in flight by closing the popover (the draft is
 * thrown away on unmount).
 *
 * Delete is a hard action (no soft "clear field then save" workflow) so
 * the indicator on the button face flips off instantly without an
 * intermediate "empty saved note" state. We rely on `setUserNote`'s
 * trim-to-delete semantic for the "user cleared the field and clicked
 * 保存" path, so empty saves also delete cleanly.
 */
function UserNoteSection({ uid }: { uid: number }) {
  // Re-read on every render so external mutations (settings import,
  // notes import, another popover instance) reflect here too.
  const stored = getUserNote(uid)
  const draft = useSignal(stored?.note ?? '')
  const lastLoadedUid = useSignal<number | null>(null)
  const lastLoadedUpdatedAt = useSignal<number | null>(null)

  // Re-hydrate the draft whenever the uid changes (e.g. SPA navigation
  // on the space page) OR the stored note's `updatedAt` shifts (e.g.
  // an import happened while the popover was open). Without the
  // updatedAt check, importing notes wouldn't refresh an open editor.
  useEffect(() => {
    const incomingUpdatedAt = stored?.updatedAt ?? null
    if (lastLoadedUid.value === uid && lastLoadedUpdatedAt.value === incomingUpdatedAt) return
    draft.value = stored?.note ?? ''
    lastLoadedUid.value = uid
    lastLoadedUpdatedAt.value = incomingUpdatedAt
  }, [uid, stored?.updatedAt])

  const handleSave = () => {
    const next = draft.value
    if (next.trim().length === 0 && !stored) {
      // Nothing to save and nothing to delete — silent no-op rather
      // than a confusing "saved" toast.
      return
    }
    setUserNote(uid, next)
    if (next.trim().length === 0) {
      appendLog(`📝 已删除 UID ${uid} 的备注`)
    } else {
      appendLog(`📝 已保存 UID ${uid} 的备注`)
    }
  }

  const handleDelete = () => {
    if (!stored) return
    if (!confirm(`确定删除 UID ${uid} 的备注？此操作无法撤销。`)) return
    deleteUserNote(uid)
    draft.value = ''
    appendLog(`📝 已删除 UID ${uid} 的备注`)
  }

  const dirty = draft.value !== (stored?.note ?? '')

  return (
    <section class='flex flex-col gap-1'>
      <SectionHeading>用户备注</SectionHeading>
      <Textarea
        value={draft.value}
        onInput={e => {
          draft.value = e.currentTarget.value
        }}
        placeholder='给这位用户添加备注，支持多行文本，仅本地保存…'
        className='min-h-24 text-[13px]'
        rows={4}
      />
      <div class='flex items-center justify-between gap-2'>
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
        <div class='flex items-center gap-1'>
          {stored && (
            <Button variant='ghost' size='sm' className='text-[red]' onClick={handleDelete}>
              删除
            </Button>
          )}
          <Button variant='default' size='sm' disabled={!dirty} onClick={handleSave}>
            保存
          </Button>
        </div>
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
