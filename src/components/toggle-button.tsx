import { cn } from '../lib/cn'
import { dialogOpen, sendMsg } from '../lib/store'

export function ToggleButton() {
  const toggle = () => {
    dialogOpen.value = !dialogOpen.value
  }

  return (
    <button
      type='button'
      id='laplace-chatterbox-toggle'
      onClick={toggle}
      class={cn(
        'lc-appearance-none lc-outline-none lc-border-none',
        'lc-fixed lc-right-1 lc-bottom-1 lc-z-[2147483647]',
        'lc-cursor-pointer lc-select-none',
        'lc-text-white lc-py-1.5 lc-px-2 lc-rounded',
        sendMsg.value ? 'lc-bg-[rgb(0_186_143)]' : 'lc-bg-[#777]'
      )}
    >
      弹幕助手
    </button>
  )
}
