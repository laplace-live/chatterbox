import { useSignal } from '@preact/signals'
import { IconMoodSmile } from '@tabler/icons-preact'

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
 * room's emote packages grouped by name.
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
  const packages = cachedEmoticonPackages.value

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
        <Button variant={open.value ? 'default' : 'outline'} size='sm' title='表情'>
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
        className='lc-w-[calc(var(--laplace-chatterbox-dialog-width)-20px)]'
      >
        <div class='lc-p-2 lc-max-h-[min(320px,40vh)] lc-overflow-y-auto'>
          {packages.length === 0 ? (
            <div class='lc-text-ga6'>表情数据加载中…</div>
          ) : (
            packages.map(pkg => (
              <div key={pkg.pkg_id} class='lc-mb-3 last:lc-mb-0'>
                <div class='lc-font-bold lc-mb-1 lc-text-ga6 lc-text-[11px]'>
                  {pkg.pkg_name}
                  <span class='lc-font-normal lc-ml-2'>({pkg.emoticons.length})</span>
                </div>
                <div class='lc-flex lc-flex-wrap lc-gap-1'>
                  {pkg.emoticons.map(emo => {
                    // `perm === 0` means the server has marked this emote as
                    // locked for the current user (level / 粉丝团 / 舰长 / etc.).
                    // Same gate the manual / auto send paths use to refuse
                    // dispatching a locked emote to the API.
                    const isLocked = emo.perm === 0
                    const isCopied = copiedId.value === emo.emoticon_unique
                    const lockText = emo.unlock_show_text?.trim() || ''
                    const sendTitleParts: string[] = [emo.emoji, `点击发送: ${emo.emoticon_unique}`]
                    if (isLocked) {
                      sendTitleParts.push(lockText ? `🔒 该表情需要 ${lockText} 才能发送` : '🔒 该表情已被平台锁定')
                    }
                    return (
                      // Wrapper groups the image + name cell so the two
                      // click targets share a column. Fixed `w-[80px]`
                      // keeps the grid even regardless of name length —
                      // names longer than the cell width truncate via
                      // the inner button's `lc-truncate`.
                      <div key={emo.emoticon_id} class='lc-w-[60px] lc-flex lc-flex-col lc-items-center lc-gap-0.5'>
                        <Button
                          type='button'
                          variant='outline'
                          title={sendTitleParts.join('\n')}
                          // Locked emotes stay clickable so the send path
                          // can produce a uniform "🔒 ..." log line (rather
                          // than silently doing nothing); the gate inside
                          // `handleSend` catches them before they reach the
                          // network. The copy path below still works on
                          // locked emotes, since copying the id is harmless.
                          onClick={() => void handleSend(emo.emoticon_unique)}
                          className={cn('lc-relative lc-p-0.5', isLocked && 'lc-opacity-60')}
                        >
                          <img src={emo.url} alt={emo.emoji} class='lc-size-15 lc-object-contain' loading='lazy' />
                          {isLocked && (
                            <span
                              class={cn(
                                'lc-absolute lc-top-px lc-right-px lc-p-0.5',
                                'lc-text-white lc-text-[9px] lc-leading-none lc-rounded-sm',
                                'lc-pointer-events-none lc-whitespace-nowrap'
                              )}
                              // Per-instance background — the API supplies
                              // this colour per emote (event / special
                              // unlock badges) so it can't be encoded as a
                              // static class.
                              style={{ background: emo.unlock_show_color || 'rgba(0, 0, 0, 0.6)' }}
                            >
                              {lockText || '🔒'}
                            </span>
                          )}
                        </Button>
                        {/* Raw <button> rather than <Button> because the
                            shared Button's `min-h-6` and px-2.5 padding
                            would dwarf the 10px name label and burn an
                            extra row of vertical space per emote. We
                            recreate just the click affordances we need
                            (cursor, focus outline, hover colour) inline. */}
                        <button
                          type='button'
                          title={`点击复制: ${emo.emoticon_unique}`}
                          onClick={() => void handleCopy(emo.emoticon_unique)}
                          class={cn(
                            'lc-bg-transparent lc-border-none lc-p-0 lc-m-0',
                            'lc-w-full lc-truncate',
                            'lc-text-[10px] lc-leading-tight lc-text-inherit',
                            'lc-cursor-pointer lc-transition',
                            'hover:lc-text-brand',
                            isCopied && 'lc-text-brand lc-font-bold'
                          )}
                        >
                          {isCopied ? '已复制' : emo.emoji}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
