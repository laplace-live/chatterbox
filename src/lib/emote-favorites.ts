/**
 * Pure core for the emote favorites feature.
 *
 * The GM-persisted list itself (`favoriteEmotes`) lives in `./store`; this
 * module holds only the decisions made about it — membership, add/remove, and
 * the per-room availability that drives the grayed-out / unsendable state in
 * the favorites tab. Keeping these as pure functions of their arguments (rather
 * than reaching into the signal) lets them be unit-tested without a browser or
 * GM storage, mirroring the `auto-seek-rate` / `auto-seek` split.
 */

import type { BilibiliEmoticon, BilibiliEmoticonPackage, FavoriteEmote } from '../types'

/**
 * Project an emote down to the self-contained snapshot we persist. Accepts both
 * a live `BilibiliEmoticon` (the add-from-picker path) and an existing
 * `FavoriteEmote` (the remove-from-favorites-tab path) via structural typing.
 * Volatile unlock/permission fields (`perm`, `unlock_show_text`, …) are
 * deliberately dropped — they're re-read from the live cache so a favorited
 * locked emote unlocks correctly once the user qualifies.
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

/**
 * Toggle `emo`'s membership in `list`, returning a NEW array (never mutates the
 * input — `favoriteEmotes.value` is reassigned so the signal fires). Removes by
 * `emoticon_unique` when already present; otherwise appends a trimmed snapshot,
 * preserving insertion order so a user's favorites never reshuffle.
 */
export function toggleFavorite(list: FavoriteEmote[], emo: BilibiliEmoticon | FavoriteEmote): FavoriteEmote[] {
  if (isFavorite(list, emo.emoticon_unique)) {
    return list.filter(f => f.emoticon_unique !== emo.emoticon_unique)
  }
  return [...list, toFavoriteSnapshot(emo)]
}

/** Availability of a favorite relative to the room's currently-loaded packages. */
export type FavoriteStatus =
  /** Present in a loaded package — sendable; render the live emote. */
  | 'available'
  /** Not in any loaded package — a room emote from elsewhere; gray it out. */
  | 'unavailable'
  /** No packages loaded yet — can't classify; render normally to avoid a flash. */
  | 'loading'

/**
 * Resolve a favorite's `emoticon_unique` against the current room's packages.
 *
 * Returns the live emote when found (so the cell reflects fresh `perm` / lock
 * state rather than the frozen snapshot), `unavailable` when the cache is
 * loaded but the id is absent (a room-exclusive emote from another room — drawn
 * grayed and unsendable), and `loading` while the cache is empty so favorites
 * aren't briefly grayed during startup. The `loading`/`unavailable` split
 * matches the conservative stance in `isUnavailableEmoticon`.
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
