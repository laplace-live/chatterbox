/** Volume→icon mapping and `<audio>` volume/preroll sync for audio-only mode, split out for unit testing. */

import { AUDIO_PREROLLING_ATTR } from './player-dom'

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

/** Sync desired volume, mute, and `data-lc-prerolling` state onto the hidden `<audio>` element. */
export function applyAudioOnlyVolume(
  el: Pick<HTMLAudioElement, 'volume' | 'muted' | 'toggleAttribute'>,
  volume: number,
  muted: boolean,
  prerolling: boolean
): void {
  // Silenced via volume, not `muted`, during preroll: unmuting a muted element later can trip autoplay policy.
  el.toggleAttribute(AUDIO_PREROLLING_ATTR, prerolling && !muted && volume > 0.005)
  const level = prerolling ? 0 : volume
  if (Math.abs(el.volume - level) > 0.005) el.volume = level
  if (el.muted !== muted) el.muted = muted
}
