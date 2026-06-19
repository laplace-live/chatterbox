import { useEffect, useRef } from 'preact/hooks'

import { startAiChatEngine, stopAiChatEngine } from '../lib/ai-chat'
import { startAudioOnly, stopAudioOnly } from '../lib/audio-only'
import { startAutoBlend, stopAutoBlend } from '../lib/auto-blend'
import { startAutoQuality, stopAutoQuality } from '../lib/auto-quality'
import { startAutoSeek, stopAutoSeek } from '../lib/auto-seek'
import { startDanmakuDirect, stopDanmakuDirect } from '../lib/danmaku-direct'
import { loop } from '../lib/loop'
import {
  aiChatEnabled,
  autoBlendEnabled,
  danmakuDirectMode,
  dialogOpen,
  dialogWidth,
  optimizeLayout,
} from '../lib/store'
import { startUserBlacklistHijack, stopUserBlacklistHijack } from '../lib/user-blacklist'
import { AudioOnlyButton } from './audio-only-button'
import { AudioOnlyControls } from './audio-only-controls'
import { Configurator, clampWidth } from './configurator'
import { ConfiguratorButton } from './configurator-button'
import { CornerCluster } from './corner-cluster'
import { InfoButton } from './info-button'
import { AlertDialog } from './ui/alert-dialog'

export function AppRoom() {
  useEffect(() => {
    void loop()
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

  // AI Chat engine — mirrors the autoBlend pattern above. Start/stop is
  // ref-counted inside the engine so a strict-mode double-effect can't
  // tear down a still-needed subscription. The cleanup on unmount runs
  // through `stopAiChatEngine` rather than no-op'ing so a HMR full
  // reload of <App /> doesn't leave a dangling danmaku-stream
  // subscription pointing at an old effect.
  useEffect(() => {
    if (aiChatEnabled.value) {
      startAiChatEngine()
    } else {
      stopAiChatEngine()
    }
    return () => stopAiChatEngine()
  }, [aiChatEnabled.value])

  // Always-on: the "融入黑名单" toggle injected into B站's chat-item menu
  // should be available even when 自动融入 is currently off, so users can
  // pre-blacklist known spammers before flipping the switch.
  useEffect(() => {
    startUserBlacklistHijack()
    return () => stopUserBlacklistHijack()
  }, [])

  // Always-on: the 仅音频 toggle injected next to 小窗模式 must exist whenever
  // the live page is loaded, regardless of the signal's current value —
  // turning the feature on/off is what the button is for. The module itself
  // is signal-driven and idempotent, so we mount it unconditionally.
  useEffect(() => {
    startAudioOnly()
    return () => stopAudioOnly()
  }, [])

  // Always-on mount: the auto-seek module is signal-driven (reads
  // `autoSeekEnabled` internally) and a no-op while the feature is off,
  // so mounting unconditionally lets the user flip the setting in the
  // configurator without a reload. Listeners are only attached when
  // enabled, so the always-on cost is one signal effect — basically free.
  useEffect(() => {
    startAutoSeek()
    return () => stopAutoSeek()
  }, [])

  // Auto-quality is a one-shot — it polls for `livePlayer`, switches to
  // 原画, and stops. Toggling the setting at runtime intentionally does
  // NOT re-fire (the change applies on next reload), matching the
  // "initial quality preference" mental model. The internal `started`
  // guard makes a strict-mode double-effect or HMR remount safe.
  useEffect(() => {
    startAutoQuality()
    return () => stopAutoQuality()
  }, [])

  // B站's SPA renders `.app-body` after our userscript has mounted and
  // also re-applies inline styles on it after hydration, which silently
  // overrode any plain CSS rule (or inline style we'd set imperatively)
  // once the page finished loading. Inject a <style> rule with !important
  // so the browser applies it whenever `.app-body` exists and B站's
  // post-hydration inline writes can't clobber it.
  //
  // The actual rule text is filled in by the effect below so we can update
  // it reactively (dialog open/close, width drag) by rewriting
  // `textContent` instead of churning a fresh <style> node per pointermove.
  const layoutStyleRef = useRef<HTMLStyleElement | null>(null)
  useEffect(() => {
    // Clear stale inline margin left over from older versions of this
    // script that mutated `.app-body` directly. We only clear the exact
    // value the old code wrote ('1rem') so we never accidentally wipe a
    // margin B站 itself put there.
    const stale = document.querySelector<HTMLElement>('.app-body')
    if (stale?.style.marginLeft === '1rem') stale.style.marginLeft = ''

    if (!optimizeLayout.value) return
    const style = document.createElement('style')
    layoutStyleRef.current = style
    document.head.appendChild(style)
    return () => {
      style.remove()
      layoutStyleRef.current = null
    }
  }, [optimizeLayout.value])

  // Keep `.app-body`'s reserved space in sync with the right-anchored
  // configurator dialog (`fixed right-1`) so page content never tucks under
  // the open panel.
  //
  // We cap `max-width` rather than adding `margin-right`: B站 pins
  // `.app-body`'s width via JS keyed to `window.innerWidth`, so a
  // margin-right is just absorbed as negative margin and frees no space —
  // capping the width is what actually reflows the content. Using
  // `calc(100% - …)` keeps the reserved strip responsive to viewport resizes
  // natively (the browser recomputes 100% on resize — no JS resize listener
  // needed); only the dialog-width term is re-injected here when the user
  // drags the resize handle. The +24 covers the dialog's `right-1` offset
  // plus a small breathing gap, and `clampWidth` is the same source of truth
  // the dialog renders with so the reserve can't drift from the panel.
  useEffect(() => {
    const style = layoutStyleRef.current
    if (!style) return
    const rules = ['margin-left: 1rem !important']
    if (dialogOpen.value) {
      rules.push(`max-width: calc(100% - ${clampWidth(dialogWidth.value) + 24}px) !important`)
    }
    style.textContent = `.app-body { ${rules.join('; ')}; }`
  }, [optimizeLayout.value, dialogOpen.value, dialogWidth.value])

  return (
    <>
      <CornerCluster>
        <InfoButton />
        <AudioOnlyControls />
        <AudioOnlyButton />
        <ConfiguratorButton />
      </CornerCluster>
      <Configurator />
      <AlertDialog />
    </>
  )
}
