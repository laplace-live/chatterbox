import { useSignal } from '@preact/signals'
import { IconMoodSmile, IconStar, IconStarFilled } from '@tabler/icons-preact'
import { cn } from 'cn'
import type { TargetedPointerEvent, TargetedWheelEvent } from 'preact'
import { useLayoutEffect, useRef, useState } from 'preact/hooks'

import type { BilibiliEmoticon, FavoriteEmote } from '../types'

import { ensureRoomId, getCsrfToken } from '../lib/api'
import { isFavorite, resolveFavorite, toggleFavorite } from '../lib/emote-favorites'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from '../lib/emoticon'
import { appendLog } from '../lib/log'
import { startPointerDrag } from '../lib/pointer-drag'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { cachedEmoticonPackages, favoriteEmotes } from '../lib/store'
import { Button } from './ui/button'
import { Popover, type PopoverAlign, PopoverContent, type PopoverSide, PopoverTrigger } from './ui/popover'

/**
 * Emote picker shared by 常规发送 and the floating input box: a popover of
 * per-package tabs (收藏 pinned first) with a horizontal tab slider and a
 * fixed-height grid with a vertical slider. Image click sends; name click
 * copies the id; star click toggles favorite.
 */

// String sentinel can't collide with the numeric `pkg_id`s real packages use.
const FAVORITES_TAB = 'favorites' as const

interface SliderState {
  visible: boolean
  size: number
  offset: number
}

const HIDDEN_SLIDER: SliderState = { visible: false, size: 0, offset: 0 }

function computeSliderThumb(
  scrollPos: number,
  clientSize: number,
  scrollSize: number,
  trackSize: number,
  minThumb = 28
): SliderState {
  const maxScroll = scrollSize - clientSize
  if (maxScroll <= 1 || scrollSize <= 0 || trackSize <= 0) {
    return HIDDEN_SLIDER
  }
  const size = Math.min(trackSize, Math.max(minThumb, Math.round(trackSize * (clientSize / scrollSize))))
  const maxOffset = Math.max(0, trackSize - size)
  const clampedScroll = Math.max(0, Math.min(scrollPos, maxScroll))
  const offset =
    maxScroll - clampedScroll <= 1
      ? maxOffset
      : Math.min(maxOffset, Math.round((clampedScroll / maxScroll) * maxOffset))
  return { visible: true, size, offset }
}

function sameSlider(a: SliderState, b: SliderState): boolean {
  return a.visible === b.visible && a.size === b.size && a.offset === b.offset
}

export interface EmoteSelectorProps {
  /** Icon-only trigger button for tight layouts like the floating input box. */
  compact?: boolean
  side?: PopoverSide
  align?: PopoverAlign
  contentClassName?: string
  triggerClassName?: string
}

export function EmoteSelector({
  compact = false,
  side = 'top',
  align = 'start',
  contentClassName,
  triggerClassName,
}: EmoteSelectorProps = {}) {
  const open = useSignal(false)
  const copiedId = useSignal<string | null>(null)
  // Hold the id, not the index, so a cache refresh that reorders/drops packages
  // (room switch) can't strand the selection — we re-resolve by id every render.
  const activePkgId = useSignal<number | typeof FAVORITES_TAB | null>(null)
  const tabListRef = useRef<HTMLDivElement>(null)
  const hTrackRef = useRef<HTMLDivElement>(null)
  const gridListRef = useRef<HTMLDivElement>(null)
  const gridContentRef = useRef<HTMLDivElement>(null)
  const vTrackRef = useRef<HTMLDivElement>(null)
  const hDragCancelRef = useRef<(() => void) | null>(null)
  const vDragCancelRef = useRef<(() => void) | null>(null)
  const [hSlider, setHSlider] = useState<SliderState>(HIDDEN_SLIDER)
  const [vSlider, setVSlider] = useState<SliderState>(HIDDEN_SLIDER)
  const packages = cachedEmoticonPackages.value
  const favorites = favoriteEmotes.value
  const hasFavorites = favorites.length > 0

  // Explicit pick wins; else default to 收藏 when there are favorites, else pkg 0.
  const activeId = activePkgId.value ?? (hasFavorites ? FAVORITES_TAB : (packages[0]?.pkg_id ?? null))
  const activePkg =
    activeId === FAVORITES_TAB ? undefined : (packages.find(pkg => pkg.pkg_id === activeId) ?? packages[0])
  // Also falls back to favorites when the selected package can't resolve yet
  // (mid room-switch) but favorites exist.
  const showingFavorites = activeId === FAVORITES_TAB || !activePkg
  const resolvedTabKey = showingFavorites ? FAVORITES_TAB : (activePkg?.pkg_id ?? null)
  const isLoading = !hasFavorites && packages.length === 0

  const syncHSlider = () => {
    const list = tabListRef.current
    const track = hTrackRef.current
    if (!list || !track) return
    const next = computeSliderThumb(
      list.scrollLeft,
      list.clientWidth,
      list.scrollWidth,
      track.clientWidth || list.clientWidth
    )
    setHSlider(prev => (sameSlider(prev, next) ? prev : next))
  }

  const syncVSlider = () => {
    const list = gridListRef.current
    const track = vTrackRef.current
    if (!list || !track) return
    const next = computeSliderThumb(
      list.scrollTop,
      list.clientHeight,
      list.scrollHeight,
      track.clientHeight || list.clientHeight
    )
    setVSlider(prev => (sameSlider(prev, next) ? prev : next))
  }

  useLayoutEffect(() => {
    if (!open.value) return
    if (gridListRef.current) gridListRef.current.scrollTop = 0
    syncVSlider()
  }, [open.value, resolvedTabKey])

  useLayoutEffect(() => {
    if (!open.value) {
      hDragCancelRef.current?.()
      hDragCancelRef.current = null
      vDragCancelRef.current?.()
      vDragCancelRef.current = null
      return
    }
    syncHSlider()
    syncVSlider()
    const observer = new ResizeObserver(() => {
      syncHSlider()
      syncVSlider()
    })
    if (tabListRef.current) observer.observe(tabListRef.current)
    if (hTrackRef.current) observer.observe(hTrackRef.current)
    if (gridListRef.current) observer.observe(gridListRef.current)
    if (gridContentRef.current) observer.observe(gridContentRef.current)
    if (vTrackRef.current) observer.observe(vTrackRef.current)
    return () => {
      observer.disconnect()
      hDragCancelRef.current?.()
      hDragCancelRef.current = null
      vDragCancelRef.current?.()
      vDragCancelRef.current = null
    }
  }, [open.value, packages, favorites.length])

  const handleTabWheel = (e: TargetedWheelEvent<HTMLDivElement>) => {
    const list = tabListRef.current
    if (!list || list.scrollWidth <= list.clientWidth) return
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      list.scrollLeft += delta
    }
  }

  const handleGridWheel = (e: TargetedWheelEvent<HTMLDivElement>) => {
    const list = gridListRef.current
    if (!list || list.scrollHeight <= list.clientHeight) return
    e.preventDefault()
    e.stopPropagation()
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
    list.scrollTop += delta
  }

  const startSliderDrag = (
    axis: 'x' | 'y',
    list: HTMLDivElement | null,
    track: HTMLDivElement | null,
    e: TargetedPointerEvent<HTMLDivElement>,
    thumbAttr: 'emoteSliderThumb' | 'emoteVsliderThumb',
    cancelRef: { current: (() => void) | null }
  ) => {
    if (e.button !== 0 || !list || !track) return
    const clientSize = axis === 'x' ? list.clientWidth : list.clientHeight
    const scrollSize = axis === 'x' ? list.scrollWidth : list.scrollHeight
    const maxScroll = scrollSize - clientSize
    if (maxScroll <= 1) return
    e.preventDefault()
    e.stopPropagation()

    const trackRect = track.getBoundingClientRect()
    const trackSize = axis === 'x' ? trackRect.width : trackRect.height
    if (trackSize <= 0) return
    const thumbSize = Math.min(trackSize, Math.max(28, Math.round(trackSize * (clientSize / scrollSize))))
    const maxThumbOffset = Math.max(1, trackSize - thumbSize)
    const isThumb = (e.target as HTMLElement | null)?.dataset[thumbAttr] === 'true'

    if (!isThumb) {
      const pointerPos = axis === 'x' ? e.clientX - trackRect.left : e.clientY - trackRect.top
      const clickOffset = Math.max(0, Math.min(pointerPos - thumbSize / 2, maxThumbOffset))
      const nextScroll = (clickOffset / maxThumbOffset) * maxScroll
      if (axis === 'x') list.scrollLeft = nextScroll
      else list.scrollTop = nextScroll
    }

    const startPointer = axis === 'x' ? e.clientX : e.clientY
    const startScroll = axis === 'x' ? list.scrollLeft : list.scrollTop
    cancelRef.current?.()
    cancelRef.current = startPointerDrag(track, e, {
      cursor: 'grabbing',
      onMove: ev => {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPointer
        const nextScroll = startScroll + (delta / maxThumbOffset) * maxScroll
        if (axis === 'x') list.scrollLeft = nextScroll
        else list.scrollTop = nextScroll
      },
    })
  }

  const handleSend = async (unique: string) => {
    open.value = false

    if (isLockedEmoticon(unique)) {
      appendLog(formatLockedEmoticonReject(unique, '手动表情'))
      return
    }

    // Other-room favorites stay clickable; gate the send so B站 doesn't echo the
    // raw id back into chat as plain text.
    if (isUnavailableEmoticon(unique)) {
      appendLog(formatUnavailableEmoticonReject(unique, '手动表情'))
      return
    }

    try {
      const roomId = await ensureRoomId()
      const csrfToken = getCsrfToken()
      if (!csrfToken) {
        appendLog('❌ 未找到登录信息，请先登录 Bilibili')
        return
      }
      const result = await enqueueDanmaku(unique, roomId, csrfToken, SendPriority.MANUAL, 'emote')
      appendLog(result, '手动表情', unique)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      appendLog(`🔴 发送出错：${msg}`)
    }
  }

  const handleCopy = async (unique: string) => {
    try {
      await navigator.clipboard.writeText(unique)
    } catch {
      // clipboard rejects in insecure contexts / on denied permission; alert so
      // the user still gets the id.
      alert(`复制失败，请手动复制：${unique}`)
      return
    }
    copiedId.value = unique
    setTimeout(() => {
      // peek() so a stale timeout doesn't clobber a newer copy on another emote.
      if (copiedId.peek() === unique) copiedId.value = null
    }, 1500)
  }

  const handleToggleFav = (emo: BilibiliEmoticon | FavoriteEmote) => {
    // Reassign (never mutate) so the gmSignal effect fires and persists.
    favoriteEmotes.value = toggleFavorite(favoriteEmotes.value, emo)
  }

  return (
    <Popover
      open={open.value}
      onOpenChange={v => {
        open.value = v
      }}
    >
      <PopoverTrigger>
        {compact ? (
          <button
            type='button'
            title='表情'
            aria-label='表情'
            aria-expanded={open.value}
            class={cn(
              'm-0 flex size-[36px] shrink-0 items-center justify-center rounded-full border-none p-0 transition',
              'cursor-pointer select-none',
              open.value ? 'bg-brand text-white' : 'bg-transparent text-ga5 hover:bg-ga2 hover:text-inherit',
              triggerClassName
            )}
          >
            <IconMoodSmile size={26} stroke={1.75} aria-hidden='true' />
          </button>
        ) : (
          /* Variant flip lights the button up while the picker is open. */
          <Button
            variant={open.value ? 'default' : 'outline'}
            size='sm'
            title='表情'
            className={cn('flex items-center', triggerClassName)}
          >
            <IconMoodSmile size={14} aria-hidden='true' />
            表情
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className={cn(
          'flex flex-col',
          contentClassName ?? 'w-[calc(var(--laplace-chatterbox-dialog-width,320px)-20px)]'
        )}
      >
        {isLoading ? (
          <div class='p-2 text-ga6'>表情数据加载中…</div>
        ) : (
          <>
            {/* `border-solid` explicit: preflight is off, so a width-only
                `border-b` renders nothing. */}
            <div class='shrink-0 border-b border-solid border-ga2'>
              <div
                ref={tabListRef}
                role='tablist'
                onScroll={syncHSlider}
                onWheel={handleTabWheel}
                class='flex shrink-0 [scrollbar-width:none] gap-1 overflow-x-auto px-2 [&::-webkit-scrollbar]:hidden'
              >
                <button
                  key={FAVORITES_TAB}
                  type='button'
                  role='tab'
                  aria-selected={showingFavorites}
                  aria-label='收藏'
                  title={`收藏 (${favorites.length})`}
                  onClick={() => {
                    activePkgId.value = FAVORITES_TAB
                  }}
                  class={cn(
                    'relative flex shrink-0 items-center justify-center',
                    'm-0 bg-transparent p-0.5',
                    'cursor-pointer border-0 border-b-2 border-solid border-transparent transition',
                    '[&:not(:disabled):hover]:brightness-95',
                    showingFavorites ? 'border-brand bg-ga1s opacity-100' : 'opacity-55'
                  )}
                >
                  <span class='flex size-12 items-center justify-center'>
                    {hasFavorites ? (
                      <IconStarFilled size={26} class='text-brand' />
                    ) : (
                      <IconStar size={26} class='text-ga6' />
                    )}
                  </span>
                </button>
                {packages.map(pkg => {
                  const isActive = pkg.pkg_id === activePkg?.pkg_id
                  const cover = pkg.emoticons[0]
                  return (
                    <button
                      key={pkg.pkg_id}
                      type='button'
                      role='tab'
                      aria-selected={isActive}
                      aria-label={pkg.pkg_name}
                      title={`${pkg.pkg_name} (${pkg.emoticons.length})`}
                      onClick={() => {
                        activePkgId.value = pkg.pkg_id
                      }}
                      class={cn(
                        'relative flex shrink-0 items-center justify-center',
                        'm-0 bg-transparent p-0.5',
                        // `border-b-2` transparent on inactive tabs so the row
                        // height doesn't shift as selection moves.
                        'cursor-pointer border-0 border-b-2 border-solid border-transparent transition',
                        '[&:not(:disabled):hover]:brightness-95',
                        isActive ? 'border-brand bg-ga1s opacity-100' : 'opacity-55'
                      )}
                    >
                      {cover?.url ? (
                        <img src={cover.url} alt='' class='size-12 object-contain' loading='lazy' />
                      ) : (
                        <span class='px-1 text-[11px] leading-none text-ga6'>{pkg.pkg_name}</span>
                      )}
                    </button>
                  )
                })}
              </div>
              <div
                ref={hTrackRef}
                onPointerDown={e =>
                  startSliderDrag('x', tabListRef.current, hTrackRef.current, e, 'emoteSliderThumb', hDragCancelRef)
                }
                onWheel={handleTabWheel}
                title='左右拖动切换表情包分类'
                class={cn(
                  'relative mx-2 my-1 h-2.5 cursor-pointer rounded-full bg-ga2/80 select-none',
                  !hSlider.visible && 'hidden'
                )}
                style={{ touchAction: 'none' }}
              >
                <div
                  data-emote-slider-thumb='true'
                  class='absolute top-0 bottom-0 cursor-grab rounded-full bg-ga4 transition-colors hover:bg-ga5 active:cursor-grabbing active:bg-ga6'
                  style={{ width: `${hSlider.size}px`, left: `${hSlider.offset}px` }}
                />
              </div>
            </div>
            {/* Fixed height keeps the popover top stationary across tabs with different emote counts. */}
            <div class='flex h-[min(240px,38vh)] min-h-0'>
              <div
                ref={gridListRef}
                onScroll={syncVSlider}
                class='min-w-0 flex-1 [scrollbar-width:none] overflow-y-auto p-2 [&::-webkit-scrollbar]:hidden'
              >
                <div ref={gridContentRef}>
                  {showingFavorites ? (
                    favorites.length === 0 ? (
                      <div class='p-3 text-center text-[11px] leading-relaxed text-ga6'>
                        还没有收藏的表情
                        <br />
                        把鼠标移到表情上，点左上角的 ☆ 即可收藏
                      </div>
                    ) : (
                      <>
                        <div class='mb-1 text-[11px] font-bold text-ga6'>
                          收藏
                          <span class='ml-2 font-normal'>({favorites.length})</span>
                        </div>
                        <div class='flex flex-wrap gap-1'>
                          {favorites.map(fav => {
                            // Live cache gives fresh perm/lock state; a missing one
                            // (other room / loading) falls back to its snapshot.
                            const { live, status } = resolveFavorite(fav.emoticon_unique, packages)
                            return (
                              <EmoteCell
                                key={fav.emoticon_unique}
                                emo={live ?? favoriteToEmoticon(fav)}
                                copied={copiedId.value === fav.emoticon_unique}
                                isFav
                                unavailable={status === 'unavailable'}
                                onSend={unique => void handleSend(unique)}
                                onCopy={unique => void handleCopy(unique)}
                                onToggleFav={() => handleToggleFav(live ?? fav)}
                              />
                            )
                          })}
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <div class='mb-1 text-[11px] font-bold text-ga6'>
                        {activePkg?.pkg_name}
                        <span class='ml-2 font-normal'>({activePkg?.emoticons.length})</span>
                      </div>
                      <div class='flex flex-wrap gap-1'>
                        {activePkg?.emoticons.map(emo => (
                          <EmoteCell
                            key={emo.emoticon_id}
                            emo={emo}
                            copied={copiedId.value === emo.emoticon_unique}
                            isFav={isFavorite(favorites, emo.emoticon_unique)}
                            onSend={unique => void handleSend(unique)}
                            onCopy={unique => void handleCopy(unique)}
                            onToggleFav={() => handleToggleFav(emo)}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
              <div
                ref={vTrackRef}
                onPointerDown={e =>
                  startSliderDrag('y', gridListRef.current, vTrackRef.current, e, 'emoteVsliderThumb', vDragCancelRef)
                }
                onWheel={handleGridWheel}
                title='上下拖动浏览表情'
                class={cn(
                  'relative my-2 mr-1.5 w-2.5 shrink-0 cursor-pointer rounded-full bg-ga2/80 select-none',
                  !vSlider.visible && 'hidden'
                )}
                style={{ touchAction: 'none' }}
              >
                <div
                  data-emote-vslider-thumb='true'
                  class='absolute right-0 left-0 cursor-grab rounded-full bg-ga4 transition-colors hover:bg-ga5 active:cursor-grabbing active:bg-ga6'
                  style={{ height: `${vSlider.size}px`, top: `${vSlider.offset}px` }}
                />
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Build a cell-ready emote from a favorite snapshot. `perm` left undefined so
 * the cell reads it as unlocked — grayed state comes from `unavailable` instead.
 */
function favoriteToEmoticon(fav: FavoriteEmote): BilibiliEmoticon {
  return {
    emoji: fav.emoji,
    descript: fav.descript ?? fav.emoji,
    url: fav.url,
    emoticon_unique: fav.emoticon_unique,
    emoticon_id: 0,
  }
}

interface EmoteCellProps {
  emo: BilibiliEmoticon
  /** Whether this emote is the one currently flashing the “已复制” hint. */
  copied: boolean
  /** Whether this emote is currently favorited (controls the star glyph). */
  isFav: boolean
  /** Other-room favorite: not in the current room, so dimmed with an 其他房间 banner and rejected in `handleSend`. Defaults to false. */
  unavailable?: boolean
  /** Send the emote (image click). Closing the popover is the caller's job. */
  onSend: (unique: string) => void
  /** Copy the emote's `emoticon_unique` to the clipboard (name click). */
  onCopy: (unique: string) => void
  /** Toggle this emote's membership in 收藏 (star click). */
  onToggleFav: () => void
}

/** A single grid emote: favorite-toggle star over an image button (sends) over a name button (copies the id). */
function EmoteCell({ emo, copied, isFav, unavailable = false, onSend, onCopy, onToggleFav }: EmoteCellProps) {
  // `perm === 0`: server-locked for this user (level / 粉丝团 / 舰长 / etc.).
  const isLocked = emo.perm === 0
  const lockText = emo.unlock_show_text?.trim() || ''
  const dimmed = isLocked || unavailable
  const sendTitleParts: string[] = [emo.emoji, `点击发送: ${emo.emoticon_unique}`]
  if (unavailable) {
    sendTitleParts.push('⊘ 该表情不在当前房间，无法发送')
  } else if (isLocked) {
    sendTitleParts.push(lockText ? `🔒 该表情需要 ${lockText} 才能发送` : '🔒 该表情已被平台锁定')
  }

  return (
    // Star is a sibling of the image button, not nested — a <button> inside the
    // shared <Button> would be invalid markup.
    <div class='group relative flex w-15 flex-col items-center gap-0.5'>
      {/* Top-left, clear of the top-right lock badge. */}
      <button
        type='button'
        aria-label={isFav ? '取消收藏' : '收藏'}
        aria-pressed={isFav}
        title={isFav ? '取消收藏' : '收藏'}
        onClick={onToggleFav}
        class={cn(
          'absolute top-0 left-0 z-10 m-0 flex items-center justify-center',
          'cursor-pointer rounded-br border-none p-px leading-none',
          'bg-black/20 transition hover:bg-black/45',
          isFav ? 'opacity-100' : 'opacity-30 group-hover:opacity-100'
        )}
      >
        {isFav ? <IconStarFilled size={13} class='text-[#FFC400]' /> : <IconStar size={13} class='text-white' />}
      </button>
      <Button
        type='button'
        variant='outline'
        title={sendTitleParts.join('\n')}
        // Locked / other-room emotes stay clickable so `handleSend` can emit a
        // uniform 🔒 / 🚫 log instead of silently doing nothing.
        onClick={() => onSend(emo.emoticon_unique)}
        className={cn('relative p-0.5', dimmed && 'opacity-60')}
      >
        <img src={emo.url} alt={emo.emoji} class='size-15 object-contain' loading='lazy' />
        {unavailable ? (
          <span
            // Bottom strip, not a corner badge: 其他房间 would collide with the
            // always-on top-left star on the narrow cell.
            class={cn(
              'absolute inset-x-0 bottom-0',
              'text-center text-[9px] leading-tight text-white',
              'pointer-events-none'
            )}
            style={{ background: 'rgba(0, 0, 0, 0.6)' }}
          >
            其他房间
          </span>
        ) : (
          isLocked && (
            <span
              class={cn(
                'absolute top-px right-px p-0.5',
                'rounded-sm text-[9px] leading-none text-white',
                'pointer-events-none whitespace-nowrap'
              )}
              // API supplies this colour per emote, so it can't be a static class.
              style={{ background: emo.unlock_show_color || 'rgba(0, 0, 0, 0.6)' }}
            >
              {lockText || '🔒'}
            </span>
          )
        )}
      </Button>
      {/* Raw <button>, not <Button>: the shared Button's `min-h-6` and padding
          would dwarf the name label and burn a row per emote. */}
      <button
        type='button'
        title={`点击复制: ${emo.emoticon_unique}`}
        onClick={() => onCopy(emo.emoticon_unique)}
        class={cn(
          'm-0 border-none bg-transparent p-0',
          'w-full truncate',
          'text-[10px] leading-tight text-inherit',
          'cursor-pointer transition',
          'hover:text-brand',
          copied && 'font-bold text-brand'
        )}
      >
        {copied ? '已复制' : emo.emoji}
      </button>
    </div>
  )
}
