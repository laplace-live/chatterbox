/**
 * Pure volume→icon mapping for the audio-only controls, split out from the
 * Preact component (`components/audio-only-controls.tsx`) so the threshold
 * logic is unit-testable without a DOM (see `audio-only-volume.test.ts`).
 */

/** Which speaker glyph the mute button shows. */
export type VolumeIconState = 'muted' | 'low' | 'high'

/** Volume at/above this (0–1) shows the "full" speaker; below it, "low". */
const HIGH_VOLUME_THRESHOLD = 0.5

/**
 * Pick the speaker glyph for the current state.
 *
 * Mute always wins — an explicitly muted player reads as muted no matter
 * the underlying volume. A zero (or, defensively, negative / NaN) volume
 * is effectively silent, so it reads as muted too rather than showing an
 * audible icon over silence.
 */
export function volumeIconState(volume: number, muted: boolean): VolumeIconState {
  // `!(volume > 0)` catches 0, negatives, and NaN in one shot (NaN > 0 is
  // false), so a garbage volume degrades to "muted" instead of throwing.
  if (muted || !(volume > 0)) return 'muted'
  if (volume < HIGH_VOLUME_THRESHOLD) return 'low'
  return 'high'
}
