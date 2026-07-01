import { cn } from '../lib/cn'
import { dialogOpen, sendMsg } from '../lib/store'

/**
 * Toggle that opens the floating configurator. Live-page only: its settings
 * tab reads live-room state absent on space pages. Layout owned by `<CornerCluster />`.
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
      直播助手
    </button>
  )
}
