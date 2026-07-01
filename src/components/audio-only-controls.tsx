import { IconVolume, IconVolume2, IconVolumeOff } from '@tabler/icons-preact'

import { volumeIconState } from '../lib/audio-only-volume'
import { cn } from '../lib/cn'
import { audioOnlyEnabled, audioOnlyMuted, audioOnlyVolume } from '../lib/store'

/**
 * Audio-only mute toggle with hover/focus-expanding volume slider.
 * Lives in our own shadow-DOM cluster because audio-only mode calls
 * `stopPlayback()`, tearing down bilibili's native controls; pure signal
 * I/O into `audioOnlyVolume`/`audioOnlyMuted` (never the audio element).
 */
export function AudioOnlyControls() {
  if (!audioOnlyEnabled.value) return null

  const volume = audioOnlyVolume.value
  const muted = audioOnlyMuted.value
  const Icon = pickIcon(volume, muted)

  // Reads 0 while muted; pre-mute level survives in `audioOnlyVolume` (no separate "last volume").
  const sliderValue = muted ? 0 : volume

  const toggleMute = () => {
    audioOnlyMuted.value = !audioOnlyMuted.value
  }

  const onSlide = (next: number) => {
    audioOnlyVolume.value = next
    // Any positive value unmutes; dragging to 0 mutes.
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
      {/* Grows from zero width on hover/focus-within; `focus-within` keeps it open for keyboard tab-in. */}
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
