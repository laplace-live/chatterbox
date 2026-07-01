import { useSignal } from '@preact/signals'
import { IconMoodSmile, IconStar, IconStarFilled } from '@tabler/icons-preact'

import type { BilibiliEmoticon, FavoriteEmote } from '../types'

import { ensureRoomId, getCsrfToken } from '../lib/api'
import { cn } from '../lib/cn'
import { isFavorite, resolveFavorite, toggleFavorite } from '../lib/emote-favorites'
import {
  formatLockedEmoticonReject,
  formatUnavailableEmoticonReject,
  isLockedEmoticon,
  isUnavailableEmoticon,
} from '../lib/emoticon'
import { appendLog } from '../lib/log'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { cachedEmoticonPackages, favoriteEmotes } from '../lib/store'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * Emote picker for the 常规发送 tab: a popover of per-package tabs (收藏 pinned
 * first). Image click sends (B站 requires the message be exactly the
 * `emoticon_unique`, so no textarea compose); name click copies the id and
 * keeps the popover open. Send closes it.
 */

// String sentinel can't collide with the numeric `pkg_id`s real packages use.
const FAVORITES_TAB = 'favorites' as const

export function EmoteSelector() {
  const open = useSignal(false)
  const copiedId = useSignal<string | null>(null)
  // Hold the id, not the index, so a cache refresh that reorders/drops packages
  // (room switch) can't strand the selection — we re-resolve by id every render.
  const activePkgId = useSignal<number | typeof FAVORITES_TAB | null>(null)
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
  const isLoading = !hasFavorites && packages.length === 0

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
      const result = await enqueueDanmaku(unique, roomId, csrfToken, SendPriority.MANUAL)
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
        {/* Variant flip lights the button up while the picker is open. */}
        <Button variant={open.value ? 'default' : 'outline'} size='sm' title='表情' className='flex items-center'>
          <IconMoodSmile size={14} aria-hidden='true' />
          表情
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // Open UP so the picker doesn't push the AI Evasion checkbox past the
        // dialog's clipped bottom edge.
        side='top'
        align='start'
        // Fits the default dialog width; a narrower resized dialog clips it via
        // overflow-hidden (same caveat as Combobox).
        className='w-[calc(var(--laplace-chatterbox-dialog-width)-20px)]'
      >
        {isLoading ? (
          <div class='p-2 text-ga6'>表情数据加载中…</div>
        ) : (
          <>
            {/* `border-solid` explicit: preflight is off, so a width-only
                `border-b` renders nothing. */}
            <div role='tablist' class='flex shrink-0 gap-1 overflow-x-auto border-ga2 border-b border-solid px-2'>
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
                  'cursor-pointer border-0 border-transparent border-b-2 border-solid transition',
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
                      'cursor-pointer border-0 border-transparent border-b-2 border-solid transition',
                      '[&:not(:disabled):hover]:brightness-95',
                      isActive ? 'border-brand bg-ga1s opacity-100' : 'opacity-55'
                    )}
                  >
                    {cover?.url ? (
                      <img src={cover.url} alt='' class='size-12 object-contain' loading='lazy' />
                    ) : (
                      <span class='px-1 text-[11px] text-ga6 leading-none'>{pkg.pkg_name}</span>
                    )}
                  </button>
                )
              })}
            </div>
            {/* Keyed by tab so switching remounts and resets scroll to the top. */}
            <div
              key={showingFavorites ? FAVORITES_TAB : activePkg?.pkg_id}
              class='max-h-[min(320px,40vh)] overflow-y-auto p-2'
            >
              {showingFavorites ? (
                favorites.length === 0 ? (
                  <div class='p-3 text-center text-[11px] text-ga6 leading-relaxed'>
                    还没有收藏的表情
                    <br />
                    把鼠标移到表情上，点左上角的 ☆ 即可收藏
                  </div>
                ) : (
                  <>
                    <div class='mb-1 font-bold text-[11px] text-ga6'>
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
                  <div class='mb-1 font-bold text-[11px] text-ga6'>
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
              'text-center text-[9px] text-white leading-tight',
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
                'rounded-sm text-[9px] text-white leading-none',
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
          'text-[10px] text-inherit leading-tight',
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
