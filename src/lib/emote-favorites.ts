/** Pure core for emote favorites; the persisted list lives in `./store`. */

import type { BilibiliEmoticon, BilibiliEmoticonPackage, FavoriteEmote } from '../types'

/**
 * Project an emote down to the persisted snapshot.
 * Volatile unlock/permission fields (`perm`, `unlock_show_text`, …) are dropped so a favorited locked emote unlocks once re-read from the live cache.
 */
export function toFavoriteSnapshot(emo: {
  emoticon_unique: string
  url: string
  emoji: string
  descript?: string
}): FavoriteEmote {
  return {
    emoticon_unique: emo.emoticon_unique,
    url: emo.url,
    emoji: emo.emoji,
    descript: emo.descript,
  }
}

/** `true` when `unique` is already in the favorites `list`. */
export function isFavorite(list: FavoriteEmote[], unique: string): boolean {
  return list.some(f => f.emoticon_unique === unique)
}

/** Toggle `emo`'s membership in `list`, returning a new array (never mutates, so the signal fires on reassignment). Appends preserve insertion order. */
export function toggleFavorite(list: FavoriteEmote[], emo: BilibiliEmoticon | FavoriteEmote): FavoriteEmote[] {
  if (isFavorite(list, emo.emoticon_unique)) {
    return list.filter(f => f.emoticon_unique !== emo.emoticon_unique)
  }
  return [...list, toFavoriteSnapshot(emo)]
}

/** Availability of a favorite relative to the room's currently-loaded packages. */
export type FavoriteStatus =
  /** In a loaded package — sendable; render the live emote. */
  | 'available'
  /** In no loaded package — room emote from elsewhere; gray it out. */
  | 'unavailable'
  /** No packages loaded yet — render normally to avoid a flash. */
  | 'loading'

/**
 * Resolve a favorite's `emoticon_unique` against the room's packages.
 * Returns the live emote when found (fresh `perm`/lock state, not the snapshot); empty cache yields `loading`, not `unavailable`, so favorites aren't briefly grayed at startup.
 */
export function resolveFavorite(
  unique: string,
  packages: BilibiliEmoticonPackage[]
): { live: BilibiliEmoticon | null; status: FavoriteStatus } {
  if (packages.length === 0) return { live: null, status: 'loading' }
  for (const pkg of packages) {
    for (const e of pkg.emoticons) {
      if (e.emoticon_unique === unique) return { live: e, status: 'available' }
    }
  }
  return { live: null, status: 'unavailable' }
}
