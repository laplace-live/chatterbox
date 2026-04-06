import { useComputed } from '@preact/signals'

import { dialogOpen, sendMsg } from '../store'

export function ToggleButton() {
  const bg = useComputed(() => (sendMsg.value ? 'rgb(0 186 143)' : '#777'))

  const toggle = () => {
    dialogOpen.value = !dialogOpen.value
  }

  return (
    <button
      type='button'
      id='laplace-chatterbox-toggle'
      onClick={toggle}
      style={{
        appearance: 'none',
        outline: 'none',
        border: 'none',
        position: 'fixed',
        right: '4px',
        bottom: '4px',
        zIndex: 2147483647,
        cursor: 'pointer',
        background: bg.value,
        color: 'white',
        padding: '6px 8px',
        borderRadius: '4px',
        userSelect: 'none',
      }}
    >
      弹幕助手
    </button>
  )
}
