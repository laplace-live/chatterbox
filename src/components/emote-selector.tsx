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
 * Emote picker for the 常规发送 tab. The trigger sits in the action row
 * just under the textarea; clicking it opens a popover with the current
 * room's emote packages presented as tabs — one tab per package, each
 * showing the package's first emote as its thumbnail (package name on
 * hover). Only the selected package's emotes are rendered below the tab
 * strip, instead of stacking every package in one long scrolling list.
 *
 * A pinned 收藏 (favorites) tab is rendered FIRST, before the package tabs:
 * it lists the user's favorited emotes (persisted via `favoriteEmotes`).
 * Because favorites are stored as self-contained snapshots, a room-exclusive
 * emote favorited in one room still renders here — grayed out and unsendable,
 * with an 其他房间 banner — when viewed from a room whose packages don't
 * include it. Every cell carries a star toggle in its top-left corner to
 * add/remove it from 收藏.
 *
 * Each emote cell is split into two click targets so the same row can
 * serve both flows the legacy EmoteIds list used to cover separately:
 *
 *   - Clicking the IMAGE sends the emote straight away (Bilibili's API
 *     requires the message to be exactly the `emoticon_unique` id, so
 *     there's nothing meaningful to compose with the textarea draft —
 *     mixing text + emote silently degrades to a plain-text send of
 *     the raw id).
 *   - Clicking the NAME beneath the image copies the `emoticon_unique`
 *     to the clipboard. Lets users paste the id into 独轮车 templates,
 *     auto-blend triggers, the textarea, etc., without leaving the
 *     picker.
 *
 * Send closes the popover (one-shot action); copy keeps it open so a
 * user can grab several ids in a row.
 *
 * Self-contained on purpose, mirroring `MemesList`: the parent renders
 * `<EmoteSelector />` and forgets about it. Internally owns the popover's
 * open state, routes locked emotes through the same `isLockedEmoticon` /
 * `formatLockedEmoticonReject` helpers the manual / auto send paths use,
 * and reports through the shared `appendLog` queue with the `手动表情`
 * label so the log line reads identically to a paste-the-id-and-press-
 * Enter send.
 */

// Sentinel id for the synthetic 收藏 tab. Real packages use positive numeric
// `pkg_id`s, so a string sentinel can never collide with one.
const FAVORITES_TAB = 'favorites' as const

export function EmoteSelector() {
  const open = useSignal(false)
  // Transient highlight for the most recently copied emote — null when
  // nothing has been copied (or the timeout has cleared the indicator).
  // Same pattern the legacy EmoteIds list used so the "已复制" hint is
  // visible without nagging via a toast/alert.
  const copiedId = useSignal<string | null>(null)
  // Currently selected tab. `null` until the user picks one (or the cache
  // first loads), at which point we fall back below. Holding the id rather
  // than the index means a cache refresh that reorders / drops packages (e.g.
  // switching rooms) can't strand the selection on a stale slot — we re-resolve
  // by id every render and self-heal to the first package when the id is gone.
  const activePkgId = useSignal<number | typeof FAVORITES_TAB | null>(null)
  const packages = cachedEmoticonPackages.value
  const favorites = favoriteEmotes.value
  const hasFavorites = favorites.length > 0

  // Resolve the active tab. An explicit pick wins; with no pick yet we default
  // to the 收藏 tab when the user has any favorites (their fast path), else the
  // first package.
  const activeId = activePkgId.value ?? (hasFavorites ? FAVORITES_TAB : (packages[0]?.pkg_id ?? null))
  const activePkg =
    activeId === FAVORITES_TAB ? undefined : (packages.find(pkg => pkg.pkg_id === activeId) ?? packages[0])
  // Show the favorites view when the 收藏 tab is selected, or as a fallback when
  // the selected package can't be resolved yet (e.g. mid room-switch) but the
  // user has favorites to show.
  const showingFavorites = activeId === FAVORITES_TAB || !activePkg
  // Nothing to render yet: no favorites AND packages still loading.
  const isLoading = !hasFavorites && packages.length === 0

  const handleSend = async (unique: string) => {
    // Close the popover immediately so the picker doesn't linger over
    // the textarea while the send is in flight, mirroring how MemesList
    // returns to the list view between sends.
    open.value = false

    if (isLockedEmoticon(unique)) {
      appendLog(formatLockedEmoticonReject(unique, '手动表情'))
      return
    }

    // A favorited room-exclusive emote viewed from another room is shown grayed
    // but stays clickable; this gate (the same one the manual / auto send paths
    // use) turns that click into a uniform 🚫 log instead of letting B站 echo
    // the raw id back into chat as plain text.
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
      // navigator.clipboard can reject (insecure context, permission
      // denied, etc.). Falling back to a blocking alert with the id
      // preserves the "user always gets the id" guarantee — matches
      // what the legacy EmoteIds list did.
      alert(`复制失败，请手动复制：${unique}`)
      return
    }
    copiedId.value = unique
    setTimeout(() => {
      // peek() so this stale timeout doesn't clobber a newer copy that
      // landed on a different emote in the meantime.
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
        {/* Variant flip on open mirrors the YOLO toggle pattern — the
            button visibly "lights up" while the picker is showing, so
            the affordance reads as a single-state toggle and not two
            disconnected clicks. */}
        <Button variant={open.value ? 'default' : 'outline'} size='sm' title='表情' className='flex items-center'>
          <IconMoodSmile size={14} aria-hidden='true' />
          表情
        </Button>
      </PopoverTrigger>
      <PopoverContent
        // `top` so the picker opens UP toward the textarea instead of
        // pushing the AI Evasion checkbox out of view (and out of the
        // dialog's clipped bottom edge). `start` aligns the picker's
        // left edge with the trigger's left edge, which keeps the
        // fixed-width popover anchored to the panel's left padding.
        side='top'
        align='start'
        // 280px fits the default 300px dialog (10px panel padding each
        // side). If the user has resized the dialog narrower, the
        // popover may extend past the dialog edge and be clipped by the
        // dialog's overflow-hidden — same caveat as Combobox.
        className='w-[calc(var(--laplace-chatterbox-dialog-width)-20px)]'
      >
        {isLoading ? (
          <div class='p-2 text-ga6'>表情数据加载中…</div>
        ) : (
          <>
            {/* Tab strip — the 收藏 tab is pinned first, then one image tab per
                package, above the scrolling grid so switching is always
                reachable. Horizontal-scrolls when the tabs outrun the popover
                width. `border-solid` is explicit because preflight is disabled —
                a width-only `border-b` would render nothing. */}
            <div role='tablist' class='flex shrink-0 gap-1 overflow-x-auto border-ga2 border-b border-solid px-2'>
              {/* Favorites tab — always first. A star glyph stands in for the
                  emote thumbnail the package tabs use; brand-tinted once the
                  user has favorited anything. */}
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
                // First emote doubles as the tab thumbnail; fall back to the
                // package name when a package somehow carries no emotes
                // (never observed, but keeps the tab labelled, not blank).
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
                      // Bottom-only brand underline marks the active tab.
                      // `border-0` clears the UA button border (preflight
                      // off), then `border-b-2` reinstates just the edge we
                      // colour — kept transparent on inactive tabs so the
                      // row height doesn't shift as selection moves.
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
            {/* Keyed by tab so switching remounts the scroll container and
                resets it to the top, rather than carrying the previous tab's
                scroll offset into the next one. */}
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
                        // Resolve against the live cache so an available favorite
                        // shows fresh perm/lock state; a missing one (other room,
                        // or still loading) renders from its stored snapshot.
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
 * Render an other-room / not-yet-loaded favorite from its stored snapshot when
 * the live emote isn't in the current room's packages. `emoticon_id` is unused
 * by the cell; `perm` is left undefined so the cell never mistakes it for a
 * locked emote — its grayed state comes from the `unavailable` flag, a separate
 * axis from permission locks.
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
  /**
   * Other-room favorite: present in the user's 收藏 but not in the current
   * room's packages, so it can't be sent here. Dimmed with an 其他房间 banner;
   * the send is also rejected upstream in `handleSend`. Defaults to false.
   */
  unavailable?: boolean
  /** Send the emote (image click). Closing the popover is the caller's job. */
  onSend: (unique: string) => void
  /** Copy the emote's `emoticon_unique` to the clipboard (name click). */
  onCopy: (unique: string) => void
  /** Toggle this emote's membership in 收藏 (star click). */
  onToggleFav: () => void
}

/**
 * A single emote in the grid: a favorite-toggle star over an image button
 * (sends) stacked over a name button (copies the id). Extracted from
 * `EmoteSelector` so the picker body stays focused on tab/popover
 * orchestration.
 */
function EmoteCell({ emo, copied, isFav, unavailable = false, onSend, onCopy, onToggleFav }: EmoteCellProps) {
  // `perm === 0` means the server has marked this emote as locked for the
  // current user (level / 粉丝团 / 舰长 / etc.). Same gate the manual / auto
  // send paths use to refuse dispatching a locked emote to the API.
  const isLocked = emo.perm === 0
  const lockText = emo.unlock_show_text?.trim() || ''
  // Both locked and other-room emotes render dimmed, but for different reasons
  // and with different indicators (a top-right lock badge vs a bottom 其他房间
  // banner — placed apart so neither can collide with the top-left star).
  const dimmed = isLocked || unavailable
  const sendTitleParts: string[] = [emo.emoji, `点击发送: ${emo.emoticon_unique}`]
  if (unavailable) {
    sendTitleParts.push('⊘ 该表情不在当前房间，无法发送')
  } else if (isLocked) {
    sendTitleParts.push(lockText ? `🔒 该表情需要 ${lockText} 才能发送` : '🔒 该表情已被平台锁定')
  }

  return (
    // Wrapper groups the star + image + name into one column. `group` drives the
    // hover-reveal of the favorite star; `relative` anchors the star, which is a
    // SIBLING of the image button (not nested — a <button> inside the shared
    // <Button> would be invalid markup) absolutely placed over the image's
    // top-left corner. Fixed `w-15` keeps the grid even regardless of name
    // length — longer names truncate via the inner button's `truncate`.
    <div class='group relative flex w-15 flex-col items-center gap-0.5'>
      {/* Favorite toggle — top-left, clear of the top-right lock badge.
          Faint until the cell is hovered; solid gold once favorited. */}
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
        // Locked / other-room emotes stay clickable so the send path can produce
        // a uniform 🔒 / 🚫 log line (rather than silently doing nothing); the
        // gates inside `handleSend` catch them before they reach the network.
        // The copy path below still works on them, since copying the id is
        // harmless and lets the user paste it elsewhere.
        onClick={() => onSend(emo.emoticon_unique)}
        className={cn('relative p-0.5', dimmed && 'opacity-60')}
      >
        <img src={emo.url} alt={emo.emoji} class='size-15 object-contain' loading='lazy' />
        {unavailable ? (
          <span
            // Bottom banner, not a top corner badge: the 4-char 其他房间 label
            // would collide with the always-on favorite star (top-left) on the
            // narrow 60px cell. A full-width strip along the image's bottom edge
            // clears both top corners (star and the lock-badge slot).
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
              // Per-instance background — the API supplies this colour per
              // emote (event / special unlock badges) so it can't be encoded
              // as a static class.
              style={{ background: emo.unlock_show_color || 'rgba(0, 0, 0, 0.6)' }}
            >
              {lockText || '🔒'}
            </span>
          )
        )}
      </Button>
      {/* Raw <button> rather than <Button> because the shared Button's
          `min-h-6` and px-2.5 padding would dwarf the 10px name label and
          burn an extra row of vertical space per emote. We recreate just
          the click affordances we need (cursor, focus outline, hover
          colour) inline. */}
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
