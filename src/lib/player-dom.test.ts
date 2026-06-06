import { describe, expect, test } from 'bun:test'

import { isNativePlayerStreaming } from './player-dom'

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
