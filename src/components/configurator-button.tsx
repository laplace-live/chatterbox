import { cn } from '../lib/cn'
import { dialogOpen, sendMsg } from '../lib/store'

/**
 * The 弹幕助手 toggle that opens the floating configurator. Live-page
 * only — the configurator's settings tab reads live-room state that
 * doesn't exist on space pages, so this button has no business
 * appearing there.
 *
 * Layout (fixed corner, z-index, spacing relative to siblings) is owned
 * by `<CornerCluster />`; this component only renders the button itself.
 */
export function ConfiguratorButton() {
  const toggle = () => {
    dialogOpen.value = !dialogOpen.value
  }

  return (
    <button
      type='button'
      id='laplace-chatterbox-toggle'
      onClick={toggle}
      class={cn(
        'appearance-none border-none outline-none',
        'cursor-pointer select-none',
        'h-8 rounded px-2 text-white',
        sendMsg.value ? 'bg-brand' : 'bg-ga6'
      )}
    >
      弹幕助手
    </button>
  )
}
