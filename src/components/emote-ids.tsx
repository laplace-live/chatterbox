import { useSignal } from '@preact/signals'

import { cn } from '../lib/cn'
import { cachedEmoticonPackages } from '../lib/store'
import { Button } from './ui/button'

export function EmoteIds() {
  const packages = cachedEmoticonPackages.value
  const copiedId = useSignal<string | null>(null)

  if (packages.length === 0) {
    return <div class='lc-text-ga4'>表情数据加载中…</div>
  }

  const handleCopy = async (unique: string) => {
    try {
      await navigator.clipboard.writeText(unique)
    } catch {
      alert(`复制失败，请手动复制：${unique}`)
      return
    }
    copiedId.value = unique
    setTimeout(() => {
      if (copiedId.peek() === unique) copiedId.value = null
    }, 1500)
  }

  return (
    <>
      {packages.map(pkg => (
        <div key={pkg.pkg_id} class='lc-mb-3'>
          <div class='lc-font-bold lc-mb-1 lc-text-[#666] lc-text-[11px]'>
            {pkg.pkg_name}
            <span class='lc-font-normal lc-ml-2'>({pkg.emoticons.length})</span>
          </div>
          <div class='lc-flex lc-flex-wrap lc-gap-1'>
            {pkg.emoticons.map(emo => {
              const isCopied = copiedId.value === emo.emoticon_unique
              // `perm === 0` means the server has marked this emote as locked
              // for the current user (level / 粉丝团 / 舰长 / etc.). The check
              // is `=== 0` rather than `!== 1` so absent `perm` (older API
              // shapes) defaults to "unlocked", matching legacy behavior.
              const isLocked = emo.perm === 0
              const lockText = emo.unlock_show_text?.trim() || ''
              const titleParts: string[] = [emo.emoji, `点击复制: ${emo.emoticon_unique}`]
              if (isLocked) {
                titleParts.push(lockText ? `🔒 该表情需要 ${lockText} 才能发送` : '🔒 该表情已被平台锁定')
              }
              return (
                <Button
                  type='button'
                  variant={isCopied ? 'default' : 'outline'}
                  key={emo.emoticon_id}
                  title={titleParts.join('\n')}
                  onClick={() => void handleCopy(emo.emoticon_unique)}
                  className={cn('lc-relative lc-flex-col lc-p-1 ')}
                >
                  <img
                    src={emo.url}
                    alt={emo.emoji}
                    // Locked emotes stay clickable (so the user can still copy
                    // the unique text) but are dimmed to signal that direct
                    // sending will be blocked downstream.
                    class={cn('lc-size-18 lc-object-contain', isLocked && !isCopied && 'lc-opacity-50')}
                    loading='lazy'
                  />
                  {isCopied ? '已复制' : emo.emoji}
                  {isLocked && !isCopied && (
                    <span
                      class={cn(
                        'lc-absolute lc-top-px lc-right-px lc-p-0.5 lc-text-[10px]',
                        'lc-text-white lc-text-[9px] lc-leading-none lc-rounded-sm',
                        'lc-pointer-events-none lc-whitespace-nowrap'
                      )}
                      // Per-instance background — the API supplies this color
                      // per emote (e.g. event/special unlock badges) so it
                      // can't be encoded as a static class.
                      style={{ background: emo.unlock_show_color || 'rgba(0, 0, 0, 0.6)' }}
                    >
                      {lockText || '🔒'}
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
