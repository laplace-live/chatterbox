import { useSignal } from '@preact/signals'
import { IconAward, IconRefresh, IconX } from '@tabler/icons-preact'
import { cn } from 'cn'
import { useEffect } from 'preact/hooks'

import type { FansMedal } from '../types'

import {
  fansMedalActingId,
  fansMedalError,
  fansMedalHasMore,
  fansMedalList,
  fansMedalLoading,
  fansMedalPage,
  fansMedalTotal,
  fetchFansMedalPanel,
  fetchRoomDisplayedMedal,
  isSameFansMedal,
  roomDisplayedMedal,
  roomDisplayedMedalKnown,
  takeOffFansMedal,
  wearedMedal,
  wearFansMedal,
} from '../lib/fans-medal'
import { cachedRoomId, cachedStreamerUid } from '../lib/store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** Compact Bilibili-style two-part fans medal badge (`[name | level]`). */
function MedalBadge({ medal, compact = false }: { medal: FansMedal; compact?: boolean }) {
  const bg = medal.isLighted ? `linear-gradient(45deg, ${medal.colorStart}, ${medal.colorEnd})` : '#9ea6b2'
  const borderColor = medal.isLighted ? medal.colorBorder : '#9ea6b2'

  return (
    <span
      class={cn(
        'inline-flex items-stretch overflow-hidden rounded-[3px] border border-solid text-[10px] leading-none select-none',
        compact ? 'max-w-full min-w-0' : 'shrink-0',
        !medal.isLighted && 'opacity-75'
      )}
      style={{ borderColor }}
      title={`${medal.medalName} Lv.${medal.level}${medal.targetName ? ` · ${medal.targetName}` : ''}${medal.isLighted ? '' : '（未点亮）'}`}
    >
      <span class='flex min-w-0 items-center px-1 py-0.5 font-medium text-white' style={{ background: bg }}>
        <span class={cn('truncate', compact ? 'max-w-[52px]' : 'max-w-[96px]')}>{medal.medalName}</span>
      </span>
      <span class='flex shrink-0 items-center bg-white px-1 py-0.5 font-semibold' style={{ color: borderColor }}>
        {medal.level}
      </span>
    </span>
  )
}

/** Left-side fans medal button & classic Bilibili-style medal switcher popover. */
export function FansMedalSelector() {
  const open = useSignal(false)
  const query = useSignal('')

  useEffect(() => {
    const roomId = cachedRoomId.value
    if (roomId !== null && !roomDisplayedMedalKnown.peek()) {
      void fetchRoomDisplayedMedal(roomId)
    }
  }, [cachedRoomId.value])

  const displayed = roomDisplayedMedal.value
  const weared = wearedMedal.value
  const medals = fansMedalList.value
  const streamerUid = cachedStreamerUid.value
  const loading = fansMedalLoading.value
  const actingId = fansMedalActingId.value
  const error = fansMedalError.value
  const hasMore = fansMedalHasMore.value

  const q = query.value.trim().toLowerCase()
  const filtered = q
    ? medals.filter(m => m.medalName.toLowerCase().includes(q) || m.targetName.toLowerCase().includes(q))
    : medals

  const handleOpenChange = (next: boolean) => {
    open.value = next
    if (next) {
      void fetchFansMedalPanel(1)
    } else {
      query.value = ''
    }
  }

  const handleSelect = async (medal: FansMedal) => {
    if (actingId !== null) return
    const ok = medal.wearingStatus ? await takeOffFansMedal() : await wearFansMedal(medal)
    if (ok) handleOpenChange(false)
  }

  const triggerTitle = displayed
    ? weared && !isSameFansMedal(displayed, weared)
      ? `当前直播间展示：${displayed.medalName} Lv.${displayed.level}（全局佩戴：${weared.medalName} Lv.${weared.level}，点击切换粉丝牌）`
      : `当前直播间展示：${displayed.medalName} Lv.${displayed.level}（点击切换粉丝牌）`
    : weared
      ? `当前直播间未展示粉丝牌（全局佩戴：${weared.medalName} Lv.${weared.level}，点击切换粉丝牌）`
      : '选择粉丝牌'
  const triggerAriaLabel = displayed ? `粉丝牌：${displayed.medalName} ${displayed.level}级` : '选择粉丝牌'

  return (
    <Popover open={open.value} onOpenChange={handleOpenChange} className='min-w-0'>
      <PopoverTrigger>
        <button
          type='button'
          title={triggerTitle}
          aria-label={triggerAriaLabel}
          aria-expanded={open.value}
          class={cn(
            'm-0 flex max-w-full min-w-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0.5 transition',
            'hover:bg-ga2/70',
            open.value && 'bg-ga2/80'
          )}
        >
          {displayed ? (
            <MedalBadge medal={displayed} compact />
          ) : (
            <span class='inline-flex shrink-0 items-center gap-0.5 rounded border border-solid border-ga3 bg-ga1 px-1 py-0.5 text-[11px] leading-none whitespace-nowrap text-ga5'>
              <IconAward size={13} stroke={1.8} aria-hidden='true' />
              <span>牌</span>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='top'
        align='start'
        className='flex w-[min(300px,calc(100vw-24px))] flex-col p-2 text-[12px]'
      >
        <div class='mb-1.5 flex shrink-0 items-center justify-between gap-2 border-b border-solid border-ga2 pb-1.5'>
          <div class='flex items-center gap-1.5 font-bold'>
            <span>粉丝勋章</span>
            {fansMedalTotal.value > 0 && <span class='font-normal text-ga6'>({fansMedalTotal.value})</span>}
          </div>
          <div class='flex items-center gap-1'>
            {weared && (
              <Button
                variant='outline'
                size='sm'
                disabled={actingId !== null}
                onClick={() => void takeOffFansMedal()}
                title='卸下当前佩戴的粉丝牌'
              >
                <IconX size={12} aria-hidden='true' />
                卸下
              </Button>
            )}
            <button
              type='button'
              disabled={loading}
              onClick={() => {
                void fetchFansMedalPanel(1)
                void fetchRoomDisplayedMedal()
              }}
              title='刷新粉丝牌列表'
              aria-label='刷新粉丝牌列表'
              class='m-0 flex size-6 cursor-pointer items-center justify-center rounded border border-solid border-ga3 bg-transparent p-0 text-ga6 transition hover:bg-ga2 disabled:cursor-not-allowed disabled:opacity-50'
            >
              <IconRefresh size={13} class={cn(loading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {medals.length > 8 && (
          <div class='mb-1.5 shrink-0'>
            <Input
              value={query.value}
              onInput={e => {
                query.value = e.currentTarget.value
              }}
              placeholder='搜索粉丝牌或主播名…'
              className='h-6 text-[11px]'
            />
          </div>
        )}

        {error && <div class='mb-1.5 shrink-0 rounded bg-danger/10 px-2 py-1 text-[11px] text-danger'>{error}</div>}

        <div class='max-h-[min(260px,40vh)] min-h-0 shrink overflow-y-auto'>
          {loading && medals.length === 0 ? (
            <div class='py-4 text-center text-ga6'>粉丝牌加载中…</div>
          ) : filtered.length === 0 ? (
            <div class='py-4 text-center text-ga6'>{medals.length === 0 ? '暂无粉丝勋章' : '未找到匹配的粉丝牌'}</div>
          ) : (
            <div class='flex flex-col gap-1'>
              {filtered.map(medal => {
                const isRoomMedal = streamerUid !== null && medal.targetId === streamerUid
                const isDisplayedHere = isSameFansMedal(displayed, medal)
                const isBusy = actingId === medal.medalId
                return (
                  <button
                    key={medal.medalId}
                    type='button'
                    disabled={actingId !== null}
                    onClick={() => void handleSelect(medal)}
                    class={cn(
                      'm-0 flex w-full cursor-pointer items-center justify-between gap-2 rounded border border-solid px-2 py-1.5 text-left transition',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      medal.wearingStatus
                        ? 'border-brand bg-brand/10'
                        : 'border-transparent bg-transparent hover:border-ga3 hover:bg-ga1'
                    )}
                  >
                    <div class='flex min-w-0 items-center gap-1.5'>
                      <MedalBadge medal={medal} />
                      <span class='truncate text-[11px] text-inherit'>
                        {medal.targetName || `UID ${medal.targetId}`}
                      </span>
                      {isRoomMedal && (
                        <span class='shrink-0 rounded bg-brand/15 px-1 py-px text-[10px] text-brand'>当前</span>
                      )}
                    </div>
                    <div class='flex shrink-0 items-center gap-1.5 text-[10px] text-ga6'>
                      {medal.dayLimit > 0 && (
                        <span title='今日亲密度 / 上限'>
                          {medal.todayFeed}/{medal.dayLimit}
                        </span>
                      )}
                      {isBusy ? (
                        <span class='text-brand'>处理中…</span>
                      ) : medal.wearingStatus ? (
                        <span class='font-semibold text-brand'>佩戴中</span>
                      ) : isDisplayedHere ? (
                        <span class='font-semibold text-brand'>本房展示</span>
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {hasMore && (
          <div class='mt-1.5 flex shrink-0 justify-center border-t border-solid border-ga2 pt-1.5'>
            <Button
              variant='outline'
              size='sm'
              disabled={loading}
              onClick={() => void fetchFansMedalPanel(fansMedalPage.value + 1)}
            >
              {loading ? '加载中…' : '加载更多'}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
