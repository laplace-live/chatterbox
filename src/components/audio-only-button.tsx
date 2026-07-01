import { cn } from '../lib/cn'
import { audioOnlyEnabled } from '../lib/store'

/**
 * Audio-only toggle; label flips with the signal so one button serves both directions.
 * Lives in our DOM, not the player controls: `stopPlayback()` destroys the controller subtree.
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
        'appearance-none border-none outline-none',
        'cursor-pointer select-none',
        'h-8 rounded px-2 text-white',
        // Gray otherwise so the primary `直播助手` button keeps visual priority.
        active ? 'bg-[#FF6699]' : 'bg-ga6'
      )}
    >
      {active ? '恢复视频' : '仅音频'}
    </button>
  )
}
