import { useEffect } from 'preact/hooks'

import { startDanmakuDirect, stopDanmakuDirect } from '../danmaku-direct.js'
import { loop } from '../loop.js'
import { danmakuDirectMode, optimizeLayout } from '../store.js'
import { AlertDialog } from './AlertDialog.js'
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

  useEffect(() => {
    if (danmakuDirectMode.value) {
      startDanmakuDirect()
    } else {
      stopDanmakuDirect()
    }
    return () => stopDanmakuDirect()
  }, [danmakuDirectMode.value])

  useEffect(() => {
    const el = document.querySelector<HTMLElement>('.app-body')
    if (!el) return
    if (optimizeLayout.value) {
      el.style.marginLeft = '1rem'
    } else {
      el.style.marginLeft = ''
    }
  }, [optimizeLayout.value])

  return (
    <>
      <ToggleButton />
      <Dialog />
      <AlertDialog />
    </>
  )
}
