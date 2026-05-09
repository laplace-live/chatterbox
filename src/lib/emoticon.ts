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

/**
 * Heuristic regex for B站 `emoticon_unique` IDs: one or more lowercase
 * letters followed by one or more `_<digits>` segments. Catches the three
 * observed families:
 *
 * - `room_<roomId>_<emoticonId>`     room-exclusive (streamer's pack)
 * - `official_<emoticonId>`          site-wide (站内通用)
 * - `upower_<roomId>_<emoticonId>`   charge-tier emotes
 *
 * Conservative on purpose so regular chat — even text that happens to
 * contain underscores or digits — won't match: pure ID-shaped strings
 * (`abc_123`) are exceedingly rare in real Chinese-language chat, and the
 * cost of a false-match is "user gets a log instead of a send" rather than
 * a silent failure.
 */
const EMOTICON_UNIQUE_PATTERN = /^[a-z]+(_\d+)+$/

/**
 * `true` when `msg` looks like an `emoticon_unique` ID but isn't present in
 * the current room's cached emoticon packages. Sending such a string lands
 * as plain text — B站 just echoes the raw ID back into chat, so something
 * like `room_1713546334_108382` shows up verbatim instead of the intended
 * emote (almost always because the template was copied from another
 * streamer's room). All three send paths use this as a hard reject.
 *
 * Returns `false` when:
 * - the string is a known emoticon (`isEmoticonUnique` → true): the
 *   existing emoticon-send path already handles it correctly,
 * - the string doesn't match the ID shape: it's regular text, send as-is,
 * - the cache hasn't loaded yet (`cachedEmoticonPackages` empty): we can't
 *   distinguish "unavailable" from "still loading", so we let it through
 *   rather than false-reject legitimate room emotes during the brief
 *   startup window.
 */
export function isUnavailableEmoticon(msg: string): boolean {
  if (!EMOTICON_UNIQUE_PATTERN.test(msg)) return false
  if (cachedEmoticonPackages.value.length === 0) return false
  return !isEmoticonUnique(msg)
}

/**
 * Builds the user-facing log line for an unavailable-emoticon rejection.
 * Same call-site/label shape as `formatLockedEmoticonReject` so all three
 * send paths log consistently.
 */
export function formatUnavailableEmoticonReject(msg: string, label: string): string {
  return `🚫 ${label}：${msg} 不在当前房间表情包内，已阻止发送`
}
