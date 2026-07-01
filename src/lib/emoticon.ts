/** Pure helpers (lookup / classification / log formatting) over the cached Bilibili emoticon list. */

import type { BilibiliEmoticon } from '../types'

import { cachedEmoticonPackages } from './store'

/** `true` when `msg` exactly matches the `emoticon_unique` of any cached emoticon. */
export function isEmoticonUnique(msg: string): boolean {
  return cachedEmoticonPackages.value.some(pkg => pkg.emoticons.some(e => e.emoticon_unique === msg))
}

/** Cached emoticon entry whose `emoticon_unique` matches `msg`, else `null`. */
export function findEmoticon(msg: string): BilibiliEmoticon | null {
  for (const pkg of cachedEmoticonPackages.value) {
    for (const e of pkg.emoticons) {
      if (e.emoticon_unique === msg) return e
    }
  }
  return null
}

/** `true` when `msg` is a known emoticon the user can't send (`perm === 0`); unknown/unlocked → `false`. */
export function isLockedEmoticon(msg: string): boolean {
  const emo = findEmoticon(msg)
  return emo !== null && emo.perm === 0
}

/**
 * Log line for a locked-emoticon rejection. Assumes `msg` is already known locked
 * (gate on `isLockedEmoticon`); reason falls back to `权限不足` without `unlock_show_text`.
 */
export function formatLockedEmoticonReject(msg: string, label: string): string {
  const reqText = findEmoticon(msg)?.unlock_show_text?.trim()
  const reason = reqText ? `需要 ${reqText}` : '权限不足'
  return `🔒 ${label}：${msg} 已被平台锁定（${reason}），已阻止发送`
}

// Heuristic for B站 emoticon_unique IDs (room_/official_/upower_ families). Conservative:
// false-match cost is a log instead of a send, and ID-shaped chat text is rare.
const EMOTICON_UNIQUE_PATTERN = /^[a-z]+(_\d+)+$/

/**
 * `true` when `msg` is ID-shaped but not in the room's cache — B站 echoes such a raw ID
 * as plain text instead of the emote. Empty cache → `false` (can't tell unavailable from still-loading).
 */
export function isUnavailableEmoticon(msg: string): boolean {
  if (!EMOTICON_UNIQUE_PATTERN.test(msg)) return false
  if (cachedEmoticonPackages.value.length === 0) return false
  return !isEmoticonUnique(msg)
}

/** Log line for an unavailable-emoticon rejection. */
export function formatUnavailableEmoticonReject(msg: string, label: string): string {
  return `🚫 ${label}：${msg} 不在当前房间表情包内，已阻止发送`
}
