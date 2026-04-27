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

  // B站's SPA renders `.app-body` after our userscript has mounted and
  // also re-applies inline styles on it after hydration, which silently
  // overrode any plain CSS rule (or inline style we'd set imperatively)
  // once the page finished loading. Inject a <style> rule with !important
  // so the browser applies it whenever `.app-body` exists and B站's
  // post-hydration inline writes can't clobber it.
  useEffect(() => {
    // Clear stale inline margin left over from older versions of this
    // script that mutated `.app-body` directly. We only clear the exact
    // value the old code wrote ('1rem') so we never accidentally wipe a
    // margin B站 itself put there.
    const stale = document.querySelector<HTMLElement>('.app-body')
    if (stale?.style.marginLeft === '1rem') stale.style.marginLeft = ''

    if (!optimizeLayout.value) return
    const style = document.createElement('style')
    style.textContent = '.app-body { margin-left: 1rem !important; }'
    document.head.appendChild(style)
    return () => style.remove()
  }, [optimizeLayout.value])

  return (
    <>
      <ToggleButton />
      <Configurator />
      <AlertDialog />
    </>
  )
}
