import { useEffect } from 'preact/hooks'

import { startAutoBlend, stopAutoBlend } from '../lib/auto-blend'
import { startDanmakuDirect, stopDanmakuDirect } from '../lib/danmaku-direct'
import { loop } from '../lib/loop'
import { autoBlendEnabled, danmakuDirectMode, optimizeLayout } from '../lib/store'
import { startUserBlacklistHijack, stopUserBlacklistHijack } from '../lib/user-blacklist'
import { Configurator } from './configurator'
import { ToggleButton } from './toggle-button'
import { AlertDialog } from './ui/alert-dialog'

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
    if (autoBlendEnabled.value) {
      startAutoBlend()
    } else {
      stopAutoBlend()
    }
    return () => stopAutoBlend()
  }, [autoBlendEnabled.value])

  // Always-on: the "融入拉黑" toggle injected into B站's chat-item menu
  // should be available even when 自动融入 is currently off, so users can
  // pre-blacklist known spammers before flipping the switch.
  useEffect(() => {
    startUserBlacklistHijack()
    return () => stopUserBlacklistHijack()
  }, [])

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
      <Configurator />
      <AlertDialog />
    </>
  )
}
