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
    <div class='fixed right-1 bottom-1 z-2147483647 flex items-center gap-1'>
      <AudioOnlyButton />
      <button
        type='button'
        id='laplace-chatterbox-toggle'
        onClick={toggle}
        class={cn(
          'appearance-none border-none outline-none',
          'cursor-pointer select-none',
          'rounded px-2 py-1 text-white',
          sendMsg.value ? 'bg-brand' : 'bg-ga6'
        )}
      >
        弹幕助手
      </button>
    </div>
  )
}
