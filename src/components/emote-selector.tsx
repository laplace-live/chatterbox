import { useSignal } from '@preact/signals'
import { IconMoodSmile } from '@tabler/icons-preact'

import type { BilibiliEmoticon } from '../types'

import { ensureRoomId, getCsrfToken } from '../lib/api'
import { cn } from '../lib/cn'
import { formatLockedEmoticonReject, isLockedEmoticon } from '../lib/emoticon'
import { appendLog } from '../lib/log'
import { enqueueDanmaku, SendPriority } from '../lib/send-queue'
import { cachedEmoticonPackages } from '../lib/store'
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
export function EmoteSelector() {
  const open = useSignal(false)
  // Transient highlight for the most recently copied emote — null when
  // nothing has been copied (or the timeout has cleared the indicator).
  // Same pattern the legacy EmoteIds list used so the "已复制" hint is
  // visible without nagging via a toast/alert.
  const copiedId = useSignal<string | null>(null)
  // Currently selected package tab. `null` until the user picks one (or the
  // cache first loads), at which point we fall back to the first package
  // below. Holding the id rather than the index means a cache refresh that
  // reorders / drops packages (e.g. switching rooms) can't strand the
  // selection on a stale slot — we re-resolve by id every render and
  // self-heal to the first package when the id is gone.
  const activePkgId = useSignal<number | null>(null)
  const packages = cachedEmoticonPackages.value
  const activePkg = packages.find(pkg => pkg.pkg_id === activePkgId.value) ?? packages[0]

  const handleSend = async (unique: string) => {
    // Close the popover immediately so the picker doesn't linger over
    // the textarea while the send is in flight, mirroring how MemesList
    // returns to the list view between sends.
    open.value = false

    if (isLockedEmoticon(unique)) {
      appendLog(formatLockedEmoticonReject(unique, '手动表情'))
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
        {!activePkg ? (
          <div class='p-2 text-ga6'>表情数据加载中…</div>
        ) : (
          <>
            {/* Tab strip — one image tab per package, pinned above the
                scrolling grid so switching packages is always reachable.
                Horizontal-scrolls when the packages outrun the popover
                width. `border-solid` is explicit because preflight is
                disabled — a width-only `border-b` would render nothing. */}
            <div role='tablist' class='flex shrink-0 gap-1 overflow-x-auto border-ga2 border-b border-solid p-1'>
              {packages.map(pkg => {
                const isActive = pkg.pkg_id === activePkg.pkg_id
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
            {/* Keyed by package id so switching tabs remounts the scroll
                container and resets it to the top, rather than carrying the
                previous package's scroll offset into the next one. */}
            <div key={activePkg.pkg_id} class='max-h-[min(320px,40vh)] overflow-y-auto p-2'>
              <div class='mb-1 font-bold text-[11px] text-ga6'>
                {activePkg.pkg_name}
                <span class='ml-2 font-normal'>({activePkg.emoticons.length})</span>
              </div>
              <div class='flex flex-wrap gap-1'>
                {activePkg.emoticons.map(emo => (
                  <EmoteCell
                    key={emo.emoticon_id}
                    emo={emo}
                    copied={copiedId.value === emo.emoticon_unique}
                    onSend={unique => void handleSend(unique)}
                    onCopy={unique => void handleCopy(unique)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

interface EmoteCellProps {
  emo: BilibiliEmoticon
  /** Whether this emote is the one currently flashing the “已复制” hint. */
  copied: boolean
  /** Send the emote (image click). Closing the popover is the caller's job. */
  onSend: (unique: string) => void
  /** Copy the emote's `emoticon_unique` to the clipboard (name click). */
  onCopy: (unique: string) => void
}

/**
 * A single emote in the grid: image button (sends) stacked over a name
 * button (copies the id). Extracted from `EmoteSelector` so the picker body
 * stays focused on tab/popover orchestration; behaviour is unchanged from
 * the previous inline cell.
 */
function EmoteCell({ emo, copied, onSend, onCopy }: EmoteCellProps) {
  // `perm === 0` means the server has marked this emote as locked for the
  // current user (level / 粉丝团 / 舰长 / etc.). Same gate the manual / auto
  // send paths use to refuse dispatching a locked emote to the API.
  const isLocked = emo.perm === 0
  const lockText = emo.unlock_show_text?.trim() || ''
  const sendTitleParts: string[] = [emo.emoji, `点击发送: ${emo.emoticon_unique}`]
  if (isLocked) {
    sendTitleParts.push(lockText ? `🔒 该表情需要 ${lockText} 才能发送` : '🔒 该表情已被平台锁定')
  }

  return (
    // Wrapper groups the image + name cell so the two click targets share a
    // column. Fixed `w-15` keeps the grid even regardless of name length —
    // names longer than the cell width truncate via the inner button's
    // `truncate`.
    <div class='flex w-15 flex-col items-center gap-0.5'>
      <Button
        type='button'
        variant='outline'
        title={sendTitleParts.join('\n')}
        // Locked emotes stay clickable so the send path can produce a
        // uniform "🔒 ..." log line (rather than silently doing nothing);
        // the gate inside `handleSend` catches them before they reach the
        // network. The copy path below still works on locked emotes, since
        // copying the id is harmless.
        onClick={() => onSend(emo.emoticon_unique)}
        className={cn('relative p-0.5', isLocked && 'opacity-60')}
      >
        <img src={emo.url} alt={emo.emoji} class='size-15 object-contain' loading='lazy' />
        {isLocked && (
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
