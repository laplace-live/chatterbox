import { describe, expect, test } from 'bun:test'

import { applyAudioOnlyVolume, volumeIconState } from './audio-only-volume'
import { AUDIO_PREROLLING_ATTR } from './player-dom'

// Contract: mute wins over volume; 0 / non-finite / negative degrade to muted.
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

describe('applyAudioOnlyVolume', () => {
  function makeFakeAudio() {
    const attrs = new Set<string>()
    return {
      volume: 1,
      muted: false,
      attrs,
      toggleAttribute(name: string, force?: boolean): boolean {
        const next = force ?? !attrs.has(name)
        if (next) attrs.add(name)
        else attrs.delete(name)
        return next
      },
    }
  }

  test('marks audible prerolling <audio> with data-lc-prerolling at volume 0, then clears marker and restores volume', () => {
    const el = makeFakeAudio()
    applyAudioOnlyVolume(el, 0.75, false, true)
    expect(el.volume).toBe(0)
    expect(el.muted).toBe(false)
    expect(el.attrs.has(AUDIO_PREROLLING_ATTR)).toBe(true)

    applyAudioOnlyVolume(el, 0.75, false, false)
    expect(el.volume).toBe(0.75)
    expect(el.muted).toBe(false)
    expect(el.attrs.has(AUDIO_PREROLLING_ATTR)).toBe(false)
  })

  test('omits data-lc-prerolling during preroll when explicitly muted or volume is zero', () => {
    const el = makeFakeAudio()
    applyAudioOnlyVolume(el, 0.75, true, true)
    expect(el.muted).toBe(true)
    expect(el.attrs.has(AUDIO_PREROLLING_ATTR)).toBe(false)

    applyAudioOnlyVolume(el, 0, false, true)
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(0)
    expect(el.attrs.has(AUDIO_PREROLLING_ATTR)).toBe(false)
  })
})
