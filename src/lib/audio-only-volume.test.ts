import { describe, expect, test } from 'bun:test'

import { volumeIconState } from './audio-only-volume'

/**
 * The audio-only controls show a single speaker icon whose glyph reflects
 * the current state. `volumeIconState` is the pure mapping the component
 * uses to pick between muted / low / high — split out from the Preact
 * component so the threshold logic is unit-testable without a DOM.
 *
 * Contract: mute always wins (an explicit mute reads as muted regardless
 * of the underlying volume), volume 0 reads as muted, and any non-finite
 * / negative volume degrades to muted rather than throwing.
 */
describe('volumeIconState', () => {
  describe('muted (explicit or effective)', () => {
    test.each([
      { label: 'explicit mute at full volume', volume: 1, muted: true },
      { label: 'explicit mute at low volume', volume: 0.2, muted: true },
      { label: 'volume 0 unmuted', volume: 0, muted: false },
      { label: 'negative volume (defensive)', volume: -0.5, muted: false },
      { label: 'NaN volume (defensive)', volume: Number.NaN, muted: false },
    ])('$label → muted', ({ volume, muted }) => {
      expect(volumeIconState(volume, muted)).toBe('muted')
    })
  })

  describe('low (audible, below half)', () => {
    test.each([
      { label: 'just above zero', volume: 0.01 },
      { label: 'quarter', volume: 0.25 },
      { label: 'just below half', volume: 0.49 },
    ])('$label → low', ({ volume }) => {
      expect(volumeIconState(volume, false)).toBe('low')
    })
  })

  describe('high (half and above)', () => {
    test.each([
      { label: 'exactly half', volume: 0.5 },
      { label: 'three quarters', volume: 0.75 },
      { label: 'full', volume: 1 },
    ])('$label → high', ({ volume }) => {
      expect(volumeIconState(volume, false)).toBe('high')
    })
  })
})
