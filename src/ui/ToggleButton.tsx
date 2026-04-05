import { useComputed } from '@preact/signals'

import { sendMsg } from '../store.js'

export function ToggleButton() {
  const bg = useComputed(() => (sendMsg.value ? 'rgb(0 186 143)' : '#777'))

  const toggle = () => {
    const dialog = document.getElementById('laplace-chatterbox-dialog')
    if (dialog) dialog.style.display = dialog.style.display === 'none' ? 'block' : 'none'
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
