import { cn } from '../lib/cn'
import { audioOnlyEnabled } from '../lib/store'

/**
 * Audio-only toggle, rendered as a sibling of `弹幕助手` in the bottom-
 * right corner of the page rather than inside bilibili's own player
 * controls.
 *
 * Why not inside the controls bar?
 *
 *  - `livePlayer.stopPlayback()` (the call that actually halts CDN
 *    bandwidth in audio-only mode) destroys the
 *    `.web-player-controller-wrap` subtree, taking any injected button
 *    with it.
 *  - Other userscripts in the wild (BLTH's auto-quality module, Pakku,
 *    etc.) also stomp on the controller subtree and would race with our
 *    MutationObserver re-injection.
 *  - Putting the button in OUR DOM means it's just a Preact component
 *    wired to `audioOnlyEnabled` directly — no clones, no observers,
 *    no Svelte-class chasing.
 *
 * The label flips with the signal so a single button serves both
 * directions: `仅音频` when in video mode (click to switch to audio),
 * `恢复视频` when in audio-only (click to come back to video). Same
 * pattern bilibili's mobile app uses on its audio-only toggle.
 */
export function AudioOnlyButton() {
  const active = audioOnlyEnabled.value
  const toggle = () => {
    audioOnlyEnabled.value = !audioOnlyEnabled.value
  }

  return (
    <button
      type='button'
      id='laplace-audio-only-toggle'
      onClick={toggle}
      title={active ? '点击恢复视频流' : '点击切换为仅音频模式（节省 ~90% 带宽）'}
      class={cn(
        'lc:appearance-none lc:outline-none lc:border-none',
        'lc:cursor-pointer lc:select-none',
        'lc:text-white lc:py-1.5 lc:px-2 lc:rounded',
        // Pink in audio-only mode (matches bilibili's brand accent and
        // the icon-fill we use elsewhere); muted gray otherwise so the
        // primary `弹幕助手` button keeps visual priority.
        active ? 'lc:bg-[#FF6699]' : 'lc:bg-[#777]'
      )}
    >
      {active ? '恢复视频' : '仅音频'}
    </button>
  )
}
