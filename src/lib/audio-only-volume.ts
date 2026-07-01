/** Pure volume→icon mapping for the audio-only controls, split out so it's unit-testable without a DOM. */

/** Which speaker glyph the mute button shows. */
export type VolumeIconState = 'muted' | 'low' | 'high'

/** Volume at/above this (0–1) shows the "full" speaker; below it, "low". */
const HIGH_VOLUME_THRESHOLD = 0.5

/** Pick the speaker glyph for the current state. Mute wins; 0/negative/NaN volume also reads as muted. */
export function volumeIconState(volume: number, muted: boolean): VolumeIconState {
  // `!(volume > 0)` catches 0, negatives, and NaN (NaN > 0 is false).
  if (muted || !(volume > 0)) return 'muted'
  if (volume < HIGH_VOLUME_THRESHOLD) return 'low'
  return 'high'
}
