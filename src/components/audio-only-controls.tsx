import { IconVolume, IconVolume2, IconVolumeOff } from '@tabler/icons-preact'

import { volumeIconState } from '../lib/audio-only-volume'
import { cn } from '../lib/cn'
import { audioOnlyEnabled, audioOnlyMuted, audioOnlyVolume } from '../lib/store'

/**
 * Playback controls for audio-only mode: a mute toggle whose volume slider
 * expands on hover / keyboard focus (YouTube-style), rendered in the
 * bottom-right corner cluster and only while audio-only is engaged.
 *
 * Why here instead of in bilibili's player controls? Audio-only mode calls
 * `livePlayer.stopPlayback()`, which tears down bilibili's entire
 * `.web-player-controller-wrap` subtree — so the native play/volume
 * controls are gone, and anything injected there would be destroyed with
 * it (see `lib/audio-only.ts`). Living in our own shadow-DOM cluster means
 * these are just signals wired to the hidden <audio> element, immune to
 * bilibili's re-renders and other userscripts stomping the player.
 *
 * Pure signal I/O: the component reads/writes `audioOnlyVolume` /
 * `audioOnlyMuted` and never touches the audio element directly — the
 * live-apply effect in `lib/audio-only.ts` owns that side, so the same
 * value also survives stream-URL refreshes for free.
 */
export function AudioOnlyControls() {
  // Only present while audio-only is engaged; in video mode bilibili's
  // own player controls are intact and these would be redundant. Reading
  // the signal here also makes the component appear/disappear reactively
  // as the user toggles the mode.
  if (!audioOnlyEnabled.value) return null

  const volume = audioOnlyVolume.value
  const muted = audioOnlyMuted.value
  const Icon = pickIcon(volume, muted)

  // The slider reads 0 while muted (matching the speaker glyph), like
  // YouTube — the pre-mute level is preserved in `audioOnlyVolume`, so
  // un-muting restores it without us tracking a separate "last volume".
  const sliderValue = muted ? 0 : volume

  const toggleMute = () => {
    audioOnlyMuted.value = !audioOnlyMuted.value
  }

  const onSlide = (next: number) => {
    audioOnlyVolume.value = next
    // Dragging the slider is an intent to set what you hear: any positive
    // value unmutes; dragging all the way to 0 reads as a mute.
    audioOnlyMuted.value = next <= 0
  }

  return (
    <div class={cn('group inline-flex h-8 select-none items-center rounded bg-ga6 text-white')}>
      <button
        type='button'
        id='laplace-audio-only-mute'
        onClick={toggleMute}
        title={muted ? '取消静音' : '静音'}
        aria-label={muted ? '取消静音' : '静音'}
        class={cn(
          'appearance-none border-none outline-none',
          'grid h-8 w-8 cursor-pointer place-items-center',
          'rounded-l hover:bg-white/10'
        )}
      >
        <Icon size={16} stroke={2} />
      </button>
      {/* Slider wrapper grows from zero width on hover / focus-within.
          `overflow-hidden` clips the slider (and its margins) when
          collapsed, so at rest the control is a tidy speaker-only chip;
          `focus-within` keeps it open for keyboard users who tab onto the
          range even though it's visually hidden at rest. */}
      <div
        class={cn(
          'flex items-center overflow-hidden',
          'w-0 group-focus-within:w-34 group-hover:w-34',
          'transition-[width] duration-200 ease-out'
        )}
      >
        <input
          type='range'
          min={0}
          max={1}
          step={0.01}
          value={sliderValue}
          onInput={e => onSlide(Number(e.currentTarget.value))}
          aria-label='音量'
          class={cn('mr-2 ml-1 w-30 cursor-pointer rounded-full accent-[#eee]')}
        />
      </div>
    </div>
  )
}

/** Map the volume/mute state to its Tabler speaker glyph. */
function pickIcon(volume: number, muted: boolean) {
  const state = volumeIconState(volume, muted)
  if (state === 'muted') return IconVolumeOff
  if (state === 'low') return IconVolume2
  return IconVolume
}
