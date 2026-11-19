import { useSignal } from '@preact/signals'
import { IconAward, IconBroadcast, IconExternalLink, IconRefresh, IconUser, IconX } from '@tabler/icons-preact'
import { cn } from 'cn'

import type { FansMedal } from '../types'

import {
  fansMedalError,
  fansMedalHasMore,
  fansMedalList,
  fansMedalLoading,
  fansMedalPage,
  fansMedalTotal,
  fetchAllFansMedals,
  fetchFansMedalPanel,
  refreshFansMedalSwitcher,
  takeOffFansMedal,
  wearFansMedal,
} from '../lib/fans-medal'
import { isSameFansMedal } from '../lib/fans-medal-parse'
import { fansMedalActingId, roomDisplayedMedal, wearedMedal } from '../lib/fans-medal-room'
import { cachedStreamerUid } from '../lib/store'
import { FansMedalBadge } from './fans-medal-badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { ScrollArea } from './ui/scroll-area'

const MEDAL_CENTER_URL = 'https://link.bilibili.com/p/center/index#/user-center/wearing-center/my-medal'
const HEADER_ICON_CLASS =
  'm-0 flex size-6 cursor-pointer items-center justify-center rounded border border-solid border-ga3 bg-transparent p-0 text-ga6 transition hover:bg-ga2 disabled:cursor-not-allowed disabled:opacity-50'
const ROW_LINK_CLASS =
  'flex size-5 shrink-0 items-center justify-center rounded text-ga5 no-underline transition hover:bg-ga2 hover:text-brand'

/**
 * Fans medal button with a classic Bilibili-style switcher popover. The badge comes from B站's own
 * `getInfoByUser` (via fetch-hijack); opening the switcher refetches it along with the medal list.
 */
export function FansMedalSelector() {
  const open = useSignal(false)
  const query = useSignal('')
  const loadingAll = useSignal(false)

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
      refreshFansMedalSwitcher()
    } else {
      query.value = ''
    }
  }

  const handleListScroll = (e: { currentTarget: HTMLElement }) => {
    const el = e.currentTarget
    const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (nearEnd && fansMedalHasMore.peek() && !fansMedalLoading.peek()) {
      void fetchFansMedalPanel(fansMedalPage.peek() + 1)
    }
  }

  const loadAll = async () => {
    loadingAll.value = true
    try {
      await fetchAllFansMedals()
    } finally {
      loadingAll.value = false
    }
  }

  const handleSelect = async (medal: FansMedal) => {
    const isWorn = isSameFansMedal(wearedMedal.peek(), medal)
    const ok = isWorn ? await takeOffFansMedal() : await wearFansMedal(medal)
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
            <FansMedalBadge medal={displayed} className='shrink' />
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
        className='flex w-[min(320px,calc(100vw-24px))] flex-col p-2 text-[12px]'
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
              onClick={refreshFansMedalSwitcher}
              title='刷新粉丝牌列表'
              aria-label='刷新粉丝牌列表'
              class={HEADER_ICON_CLASS}
            >
              <IconRefresh size={13} class={cn(loading && 'animate-spin')} />
            </button>
            <a
              href={MEDAL_CENTER_URL}
              target='_blank'
              rel='noopener'
              title='在 B站「我的勋章」中管理'
              aria-label='在 B站「我的勋章」中管理'
              class={cn(HEADER_ICON_CLASS, 'no-underline')}
            >
              <IconExternalLink size={13} aria-hidden='true' />
            </a>
          </div>
        </div>

        {medals.length > 8 && (
          <div class='mb-1.5 flex shrink-0 items-center gap-1'>
            <Input
              value={query.value}
              onInput={e => {
                query.value = e.currentTarget.value
              }}
              placeholder={hasMore ? `搜索已加载的 ${medals.length} 个粉丝牌…` : '搜索粉丝牌或主播名…'}
              className='h-6 min-w-0 flex-1 text-[11px]'
            />
            {hasMore && (
              <Button
                variant='outline'
                size='sm'
                disabled={loading || loadingAll.value}
                onClick={() => void loadAll()}
                title='搜索只覆盖已加载的粉丝牌，加载全部后再搜'
              >
                {loadingAll.value ? '加载中…' : '加载全部'}
              </Button>
            )}
          </div>
        )}

        {error && <div class='mb-1.5 shrink-0 rounded bg-danger/10 px-2 py-1 text-[11px] text-danger'>{error}</div>}

        <ScrollArea className='max-h-[min(260px,40vh)] min-h-0 shrink' onScroll={handleListScroll}>
          {loading && medals.length === 0 ? (
            <div class='py-4 text-center text-ga6'>粉丝牌加载中…</div>
          ) : filtered.length === 0 ? (
            <div class='py-4 text-center text-ga6'>{medals.length === 0 ? '暂无粉丝勋章' : '未找到匹配的粉丝牌'}</div>
          ) : (
            <div class='flex flex-col gap-1'>
              {filtered.map(medal => {
                const isRoomMedal = streamerUid !== null && medal.targetId === streamerUid
                const isWorn = isSameFansMedal(weared, medal)
                const isDisplayedHere = isSameFansMedal(displayed, medal)
                const isBusy = actingId === medal.medalId
                const streamer = medal.targetName || `UID ${medal.targetId}`
                return (
                  <div
                    key={medal.medalId}
                    class={cn(
                      'flex items-center gap-0.5 rounded border border-solid pr-1 transition',
                      isWorn ? 'border-brand bg-brand/10' : 'border-transparent hover:border-ga3 hover:bg-ga1'
                    )}
                  >
                    <button
                      type='button'
                      disabled={actingId !== null}
                      onClick={() => void handleSelect(medal)}
                      class='m-0 flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-2 border-none bg-transparent py-1.5 pr-1 pl-2 text-left text-inherit disabled:cursor-not-allowed disabled:opacity-60'
                    >
                      <div class='flex min-w-0 items-center gap-1.5'>
                        <FansMedalBadge medal={medal} />
                        <span class='truncate text-[11px] text-inherit'>{streamer}</span>
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
                        ) : isWorn ? (
                          <span class='font-semibold text-brand'>佩戴中</span>
                        ) : isDisplayedHere ? (
                          <span class='font-semibold text-brand'>本房展示</span>
                        ) : null}
                      </div>
                    </button>
                    {medal.targetId > 0 && (
                      <a
                        href={`https://space.bilibili.com/${medal.targetId}`}
                        target='_blank'
                        rel='noopener'
                        title={`${streamer} 的空间`}
                        aria-label={`${streamer} 的空间`}
                        class={ROW_LINK_CLASS}
                      >
                        <IconUser size={13} aria-hidden='true' />
                      </a>
                    )}
                    {medal.roomId > 0 && (
                      <a
                        href={`https://live.bilibili.com/${medal.roomId}`}
                        target='_blank'
                        rel='noopener'
                        title={`${streamer} 的直播间`}
                        aria-label={`${streamer} 的直播间`}
                        class={ROW_LINK_CLASS}
                      >
                        <IconBroadcast size={13} aria-hidden='true' />
                      </a>
                    )}
                  </div>
                )
              })}
              {hasMore && loading && <div class='py-1 text-center text-[11px] text-ga6'>加载中…</div>}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
