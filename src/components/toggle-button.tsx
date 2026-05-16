import { cn } from '../lib/cn'
import { dialogOpen, sendMsg } from '../lib/store'
import { AudioOnlyButton } from './audio-only-button'

/**
 * Bottom-right corner cluster: the `弹幕助手` toggle (opens the floating
 * configurator) and any sibling buttons that need a stable, conflict-
 * free home outside bilibili's own player chrome.
 *
 * The flex row is anchored as a single fixed element so all buttons share
 * one z-index ceiling and one bottom-right offset — easier to keep the
 * group aligned than positioning each button independently.
 */
export function ToggleButton() {
  const toggle = () => {
    dialogOpen.value = !dialogOpen.value
  }

  return (
    <div class='lc-fixed lc-right-1 lc-bottom-1 lc-z-[2147483647] lc-flex lc-gap-1 lc-items-center'>
      <AudioOnlyButton />
      <button
        type='button'
        id='laplace-chatterbox-toggle'
        onClick={toggle}
        class={cn(
          'lc-appearance-none lc-outline-none lc-border-none',
          'lc-cursor-pointer lc-select-none',
          'lc-text-white lc-py-1.5 lc-px-2 lc-rounded',
          sendMsg.value ? 'lc-bg-[rgb(0_186_143)]' : 'lc-bg-[#777]'
        )}
      >
        弹幕助手
      </button>
    </div>
  )
}
