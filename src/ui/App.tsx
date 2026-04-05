import { useEffect } from 'preact/hooks'

import { loop } from '../loop.js'
import { Dialog } from './Dialog.js'
import { ToggleButton } from './ToggleButton.js'

export function App() {
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `
      #laplace-chatterbox-toggle,
      #laplace-chatterbox-dialog,
      #laplace-chatterbox-dialog * {
        font-size: 12px;
      }
      #laplace-chatterbox-dialog input {
        border: 1px solid;
        outline: none;
      }
    `
    document.head.appendChild(style)
    void loop()
    return () => style.remove()
  }, [])

  return (
    <>
      <ToggleButton />
      <Dialog />
    </>
  )
}
