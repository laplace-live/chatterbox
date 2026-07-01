import { describe, expect, test } from 'bun:test'

import { isNativePlayerStreaming, resolveLivePlayer } from './player-dom'

/** Same-origin `Window` stand-in; `parent === self` marks the chain terminator. */
type FakeWin = { livePlayer?: unknown; parent?: FakeWin }

/** Signal is `<video>` src: `blob:` = streaming; post-`stopPlayback()` poster `.mp4` or empty = not. */
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

/** Walks the frame ancestor chain because `/blanc/<id>` iframes install `livePlayer` on the top frame; "ready" = callable `stopPlayback`. */
describe('resolveLivePlayer', () => {
  test('normal room: player on the starting window (depth 0)', () => {
    const player = { stopPlayback() {} }
    const win: FakeWin = { livePlayer: player }
    win.parent = win
    expect(resolveLivePlayer(win)).toBe(player)
  })

  test('promotion page: player one frame up (blanc iframe → top)', () => {
    const player = { stopPlayback() {} }
    const top: FakeWin = { livePlayer: player }
    top.parent = top
    const iframe: FakeWin = { parent: top }
    expect(resolveLivePlayer(iframe)).toBe(player)
  })

  test('no player anywhere in the chain → null', () => {
    const top: FakeWin = {}
    top.parent = top
    const iframe: FakeWin = { parent: top }
    expect(resolveLivePlayer(iframe)).toBeNull()
  })

  test('player present but stopPlayback not installed yet (JS-state lag) → null', () => {
    const win: FakeWin = { livePlayer: { quality: 10000 } }
    win.parent = win
    expect(resolveLivePlayer(win)).toBeNull()
  })

  test('skips a half-built local player to reach a ready ancestor', () => {
    const ready = { stopPlayback() {} }
    const top: FakeWin = { livePlayer: ready }
    top.parent = top
    const iframe: FakeWin = { livePlayer: {}, parent: top }
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
    const iframe: FakeWin = { parent: crossOrigin }
    expect(resolveLivePlayer(iframe)).toBeNull()
  })

  test('bounded depth: a parent cycle with no player terminates instead of spinning', () => {
    const a: FakeWin = {}
    const b: FakeWin = {}
    a.parent = b
    b.parent = a
    expect(resolveLivePlayer(a, 3)).toBeNull()
  })
})
