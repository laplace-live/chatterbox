import { describe, expect, test } from 'bun:test'

import type { BilibiliEmoticon, BilibiliEmoticonPackage, FavoriteEmote } from '../types'

import { isFavorite, resolveFavorite, toFavoriteSnapshot, toggleFavorite } from './emote-favorites'

/** Pure functions of (list, packages), so favorites logic is testable without a browser or GM storage. */

function emote(over: Partial<BilibiliEmoticon> & { emoticon_unique: string }): BilibiliEmoticon {
  return {
    emoji: '[233]',
    descript: '233',
    url: 'https://i0.hdslb.com/233.png',
    emoticon_id: 1,
    perm: 1,
    ...over,
  }
}

function pkg(emoticons: BilibiliEmoticon[]): BilibiliEmoticonPackage {
  return { pkg_id: 1, pkg_name: 'pack', pkg_type: 1, pkg_descript: '', emoticons }
}

describe('toFavoriteSnapshot', () => {
  test('keeps only the renderable fields, dropping volatile permission metadata', () => {
    const snap = toFavoriteSnapshot(
      emote({
        emoticon_unique: 'official_1',
        url: 'https://x/u.png',
        emoji: '[A]',
        descript: 'A',
        // Volatile: re-read from live cache so a favorited locked emote unlocks later.
        perm: 0,
        emoticon_id: 99,
        unlock_show_text: '舰长',
      })
    )

    expect(snap).toEqual({
      emoticon_unique: 'official_1',
      url: 'https://x/u.png',
      emoji: '[A]',
      descript: 'A',
    })
  })
})

describe('isFavorite', () => {
  const list: FavoriteEmote[] = [{ emoticon_unique: 'official_1', url: 'u', emoji: '[A]' }]

  test('true when the unique id is present', () => {
    expect(isFavorite(list, 'official_1')).toBe(true)
  })

  test('false when the unique id is absent', () => {
    expect(isFavorite(list, 'official_2')).toBe(false)
  })

  test('false for an empty list', () => {
    expect(isFavorite([], 'official_1')).toBe(false)
  })
})

describe('toggleFavorite', () => {
  test('appends a trimmed snapshot when the emote is not yet favorited', () => {
    const result = toggleFavorite([], emote({ emoticon_unique: 'official_1', emoji: '[A]', perm: 0 }))

    expect(result).toEqual([
      { emoticon_unique: 'official_1', url: 'https://i0.hdslb.com/233.png', emoji: '[A]', descript: '233' },
    ])
  })

  test('preserves insertion order, appending new favorites to the end', () => {
    const existing: FavoriteEmote[] = [{ emoticon_unique: 'official_1', url: 'u1', emoji: '[A]' }]
    const result = toggleFavorite(existing, emote({ emoticon_unique: 'official_2', emoji: '[B]' }))

    expect(result.map(f => f.emoticon_unique)).toEqual(['official_1', 'official_2'])
  })

  test('removes the entry when the emote is already favorited', () => {
    const existing: FavoriteEmote[] = [
      { emoticon_unique: 'official_1', url: 'u1', emoji: '[A]' },
      { emoticon_unique: 'official_2', url: 'u2', emoji: '[B]' },
    ]
    const result = toggleFavorite(existing, emote({ emoticon_unique: 'official_1' }))

    expect(result.map(f => f.emoticon_unique)).toEqual(['official_2'])
  })

  test('does not mutate the input list', () => {
    const existing: FavoriteEmote[] = [{ emoticon_unique: 'official_1', url: 'u1', emoji: '[A]' }]
    toggleFavorite(existing, emote({ emoticon_unique: 'official_2' }))

    expect(existing.map(f => f.emoticon_unique)).toEqual(['official_1'])
  })

  test('can remove a favorite given only its stored snapshot (the grayed-out case)', () => {
    // Un-favoriting must work from a stored snapshot, not just a live BilibiliEmoticon.
    const snap: FavoriteEmote = { emoticon_unique: 'room_999_1', url: 'u', emoji: '[X]' }
    const result = toggleFavorite([snap], snap)

    expect(result).toEqual([])
  })
})

describe('resolveFavorite', () => {
  const packages = [pkg([emote({ emoticon_unique: 'official_1' }), emote({ emoticon_unique: 'room_100_5', perm: 0 })])]

  test('available — returns the live emote when present in the current packages', () => {
    const { status, live } = resolveFavorite('official_1', packages)
    expect(status).toBe('available')
    expect(live?.emoticon_unique).toBe('official_1')
  })

  test('available — surfaces the LIVE permission state, not the frozen snapshot', () => {
    // room_100_5 is locked (perm 0) live; resolve must return the live object for the current lock badge.
    const { live } = resolveFavorite('room_100_5', packages)
    expect(live?.perm).toBe(0)
  })

  test('unavailable — a room emote absent from the loaded packages (gray it out)', () => {
    const { status, live } = resolveFavorite('room_777_9', packages)
    expect(status).toBe('unavailable')
    expect(live).toBeNull()
  })

  test('loading — empty packages must NOT gray favorites out (avoids startup flash)', () => {
    const { status, live } = resolveFavorite('official_1', [])
    expect(status).toBe('loading')
    expect(live).toBeNull()
  })
})
