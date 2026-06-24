import { describe, expect, test } from 'bun:test'

import { isNativePlayerStreaming, resolveLivePlayer } from './player-dom'

/**
 * Minimal stand-in for a same-origin `Window` in the frame chain: just the
 * two properties `resolveLivePlayer` reads — an optional `livePlayer` and a
 * `parent` link. It structurally satisfies the function's parameter, so the
 * doubles pass straight in with no cast. Real top frames have
 * `parent === self`; we mirror that to mark the chain's terminator.
 */
type FakeWin = { livePlayer?: unknown; parent?: FakeWin }

/**
 * `isNativePlayerStreaming` centralizes the "is bilibili's native player
 * actively pulling the live stream?" check that audio-only's watchdog and
 * volume-restore both rely on. The signal is the `<video>` src: a `blob:`
 * URL means a MediaSource is attached and streaming; after
 * `stopPlayback()` the src reverts to a static poster `.mp4`, and an
 * un-mounted / reset element has an empty src.
 */
describe('isNativePlayerStreaming', () => {
  test('blob: src (MediaSource attached) → streaming', () => {
    expect(isNativePlayerStreaming({ src: 'blob:https://live.bilibili.com/abc-123' } as HTMLVideoElement)).toBe(true)
  })

  test('https poster .mp4 (post-stopPlayback) → not streaming', () => {
    expect(isNativePlayerStreaming({ src: 'https://i0.hdslb.com/bfs/live/poster.mp4' } as HTMLVideoElement)).toBe(false)
  })

  test('empty src (reset / unmounted element) → not streaming', () => {
    expect(isNativePlayerStreaming({ src: '' } as HTMLVideoElement)).toBe(false)
  })
})

/**
 * `resolveLivePlayer` finds bilibili's `livePlayer` control global by
 * walking up the frame ancestor chain. The walk exists because promotion /
 * activity pages run the room in a `/blanc/<id>` iframe while installing
 * `livePlayer` on the top frame — so the player the iframe needs is one (or
 * more) frames up. "Ready" is signalled by a callable `stopPlayback`.
 */
describe('resolveLivePlayer', () => {
  test('normal room: player on the starting window (depth 0)', () => {
    const player = { stopPlayback() {} }
    const win: FakeWin = { livePlayer: player }
    win.parent = win // top frame: parent === self
    expect(resolveLivePlayer(win)).toBe(player)
  })

  test('promotion page: player one frame up (blanc iframe → top)', () => {
    const player = { stopPlayback() {} }
    const top: FakeWin = { livePlayer: player }
    top.parent = top
    const iframe: FakeWin = { parent: top } // iframe itself has no livePlayer
    expect(resolveLivePlayer(iframe)).toBe(player)
  })

  test('no player anywhere in the chain → null', () => {
    const top: FakeWin = {}
    top.parent = top
    const iframe: FakeWin = { parent: top }
    expect(resolveLivePlayer(iframe)).toBeNull()
  })

  test('player present but stopPlayback not installed yet (JS-state lag) → null', () => {
    const win: FakeWin = { livePlayer: { quality: 10000 } } // no stopPlayback
    win.parent = win
    expect(resolveLivePlayer(win)).toBeNull()
  })

  test('skips a half-built local player to reach a ready ancestor', () => {
    const ready = { stopPlayback() {} }
    const top: FakeWin = { livePlayer: ready }
    top.parent = top
    const iframe: FakeWin = { livePlayer: {}, parent: top } // local player lacks stopPlayback
    expect(resolveLivePlayer(iframe)).toBe(ready)
  })

  test('cross-origin ancestor (reading globals throws) → stops, returns null', () => {
    const crossOrigin: FakeWin = {}
    Object.defineProperty(crossOrigin, 'livePlayer', {
      get() {
        throw new Error('blocked a frame with origin … from accessing a cross-origin frame')
      },
    })
    crossOrigin.parent = crossOrigin
    const iframe: FakeWin = { parent: crossOrigin } // same-origin self, no player
    expect(resolveLivePlayer(iframe)).toBeNull()
  })

  test('bounded depth: a parent cycle with no player terminates instead of spinning', () => {
    const a: FakeWin = {}
    const b: FakeWin = {}
    a.parent = b
    b.parent = a // cycle, neither is its own parent
    expect(resolveLivePlayer(a, 3)).toBeNull()
  })
})
