/**
 * Pure helpers around the cached Bilibili emoticon list.
 *
 * The signal that backs them (`cachedEmoticonPackages`) lives in `./store`
 * because it's runtime state; everything in this module is a derivation
 * (lookup / classification / log formatting) and has no own state.
 */

import type { BilibiliEmoticon } from '../types'

import { cachedEmoticonPackages } from './store'

/**
 * `true` when `msg` exactly matches the `emoticon_unique` of any cached
 * emoticon. Used by send paths to flip danmaku into emoticon mode and to
 * skip text replacement / trimming.
 */
export function isEmoticonUnique(msg: string): boolean {
  return cachedEmoticonPackages.value.some(pkg => pkg.emoticons.some(e => e.emoticon_unique === msg))
}

/**
 * Returns the cached emoticon entry whose `emoticon_unique` matches `msg`,
 * or `null` if `msg` is not a known emoticon. Useful when callers need the
 * unlock metadata (`perm`, `unlock_show_text`) and not just membership.
 */
export function findEmoticon(msg: string): BilibiliEmoticon | null {
  for (const pkg of cachedEmoticonPackages.value) {
    for (const e of pkg.emoticons) {
      if (e.emoticon_unique === msg) return e
    }
  }
  return null
}

/**
 * `true` when `msg` is a known emoticon that the current user is NOT allowed
 * to send (server-reported `perm === 0`). Unknown strings and unlocked emotes
 * both return `false` so plain text messages keep their existing send path.
 */
export function isLockedEmoticon(msg: string): boolean {
  const emo = findEmoticon(msg)
  return emo !== null && emo.perm === 0
}

/**
 * Builds the user-facing log line for a locked-emoticon rejection. Callers
 * supply the call-site label (e.g. `手动表情`, `自动表情 [2/3]`,
 * `自动融入(表情)`) and pass the result to `appendLog`. The wording (and the
 * 🔒 prefix) is owned here so all three send paths stay in sync.
 *
 * Assumes `msg` is already known to be locked (callers should gate this on
 * `isLockedEmoticon`); the unlock requirement falls back to `权限不足` when
 * the cached emoticon is missing or carries no `unlock_show_text`.
 */
export function formatLockedEmoticonReject(msg: string, label: string): string {
  const reqText = findEmoticon(msg)?.unlock_show_text?.trim()
  const reason = reqText ? `需要 ${reqText}` : '权限不足'
  return `🔒 ${label}：${msg} 已被平台锁定（${reason}），已阻止发送`
}
