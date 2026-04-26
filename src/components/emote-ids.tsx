import { useSignal } from '@preact/signals'

import { cachedEmoticonPackages } from '../lib/store'

export function EmoteIds() {
  const packages = cachedEmoticonPackages.value
  const copiedId = useSignal<string | null>(null)

  if (packages.length === 0) {
    return <div style={{ color: '#999' }}>表情数据加载中…</div>
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
        <div key={pkg.pkg_id} style={{ marginBottom: '.75em' }}>
          <div
            style={{
              fontWeight: 'bold',
              marginBottom: '.25em',
              color: '#666',
              fontSize: '11px',
            }}
          >
            {pkg.pkg_name}
            <span style={{ fontWeight: 'normal', marginLeft: '.5em' }}>({pkg.emoticons.length})</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
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
                <button
                  type='button'
                  key={emo.emoticon_id}
                  title={titleParts.join('\n')}
                  onClick={() => void handleCopy(emo.emoticon_unique)}
                  style={{
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '2px',
                    border: '1px solid var(--Ga2, #ddd)',
                    borderRadius: '3px',
                    background: isCopied ? '#36a185' : 'var(--bg2, #f5f5f5)',
                    color: isCopied ? '#fff' : '#555',
                    cursor: 'pointer',
                    fontSize: '10px',
                    lineHeight: 1.6,
                    transition: 'background .15s, color .15s',
                  }}
                >
                  <img
                    src={emo.url}
                    alt={emo.emoji}
                    style={{
                      width: '48px',
                      height: '48px',
                      objectFit: 'contain', // Locked emotes stay clickable (so the user can still copy
                      // the unique text) but are dimmed to signal that direct
                      // sending will be blocked downstream.
                      opacity: isLocked && !isCopied ? 0.5 : 1,
                    }}
                    loading='lazy'
                  />
                  {isCopied ? '已复制' : emo.emoji}
                  {isLocked && !isCopied && (
                    <span
                      style={{
                        position: 'absolute',
                        top: '1px',
                        right: '1px',
                        padding: '2px',
                        background: emo.unlock_show_color || 'rgba(0, 0, 0, 0.6)',
                        color: '#fff',
                        fontSize: '9px',
                        lineHeight: '1',
                        borderRadius: '2px',
                        pointerEvents: 'none',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {lockText || '🔒'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
