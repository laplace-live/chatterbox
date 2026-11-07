import { IconVolume, IconVolume2, IconVolumeOff } from '@tabler/icons-preact'
import { cn } from 'cn'

import { volumeIconState } from '../lib/audio-only-volume'
import { audioOnlyActive, audioOnlyMuted, audioOnlyVolume } from '../lib/store'
import { STATUS_BAR_BUTTON_CLASS, StatusBarCollapsible, useStatusBarCompact } from './status-bar'

/**
 * Level restored when unmuting at 0. Dragging the slider to 0 destroys the
 * level, so unlike the mute button there is nothing to return to.
 */
const UNMUTE_FALLBACK_VOLUME = 0.5

/**
 * Audio-only mute toggle and volume slider (a vertical popup when compact), replacing the
 * controls `stopPlayback()` removes; writes only the volume/mute signals, never the audio element.
 */
export function AudioOnlyControls() {
  const compact = useStatusBarCompact()
  if (!audioOnlyActive.value) return null

  const volume = audioOnlyVolume.value
  const muted = audioOnlyMuted.value
  const Icon = pickIcon(volume, muted)

  // Reads 0 while muted; pre-mute level survives in `audioOnlyVolume` (no separate "last volume").
  const percent = muted ? 0 : Math.round(volume * 100)

  const toggleMute = () => {
    const nextMuted = !audioOnlyMuted.value
    // Unmuting at 0 would stay silent AND keep the muted glyph (`volumeIconState`
    // reads 0 as muted), so the button looks inert. Only reachable via the slider —
    // muting with this button leaves the level intact.
    if (!nextMuted && audioOnlyVolume.value <= 0) audioOnlyVolume.value = UNMUTE_FALLBACK_VOLUME
    audioOnlyMuted.value = nextMuted
  }

  const onSlide = (nextPercent: number) => {
    const next = nextPercent / 100
    audioOnlyVolume.value = next
    audioOnlyMuted.value = next <= 0
  }

  const renderSlider = (className: string) => (
    <input
      type='range'
      min={0}
      max={100}
      step={1}
      value={percent}
      onInput={e => onSlide(Number(e.currentTarget.value))}
      aria-label='音量'
      aria-valuetext={`${percent}%`}
      title={`音量 ${percent}%`}
      class={cn('cursor-pointer accent-[#eee]', className)}
    />
  )

  return (
    <div class='group/volume relative inline-flex h-8 items-center rounded bg-ga6 text-white select-none'>
      <button
        type='button'
        id='laplace-audio-only-mute'
        onClick={toggleMute}
        title={muted ? '取消静音' : '静音'}
        aria-label={muted ? '取消静音' : '静音'}
        class={cn(STATUS_BAR_BUTTON_CLASS, 'w-8 justify-center px-0 hover:bg-white/10')}
      >
        <Icon size={16} stroke={2} />
      </button>
      {compact && (
        // Follows the button in tab order; `:active` keeps it up mid-drag and the hide delay bridges brief exits.
        // Touch has no hover or focus-visible, so there a tapped (focused) control keeps it up instead.
        <div
          class={cn(
            'absolute bottom-full left-0 flex w-8 justify-center pb-1',
            'invisible opacity-0 transition-[opacity,visibility] delay-150',
            'group-hover/volume:visible group-hover/volume:opacity-100 group-hover/volume:delay-0',
            'group-has-focus-visible/volume:visible group-has-focus-visible/volume:opacity-100 group-has-focus-visible/volume:delay-0',
            'group-has-active/volume:visible group-has-active/volume:opacity-100',
            'pointer-coarse:group-focus-within/volume:visible pointer-coarse:group-focus-within/volume:opacity-100 pointer-coarse:group-focus-within/volume:delay-0'
          )}
        >
          <div class='flex flex-col items-center gap-1.5 rounded bg-ga6 px-1 pt-2 pb-1.5 shadow-md'>
            <span class='text-[11px] leading-none tabular-nums'>{percent}</span>
            {renderSlider('m-0 h-24 w-4 [direction:rtl] [writing-mode:vertical-lr]')}
          </div>
        </div>
      )}
      <StatusBarCollapsible>{renderSlider('mr-2 ml-1 w-20')}</StatusBarCollapsible>
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
