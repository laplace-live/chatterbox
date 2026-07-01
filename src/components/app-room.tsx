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

  // Start/stop is ref-counted inside the engine so strict-mode double-effect can't
  // tear down a still-needed subscription; unmount stops (not no-op) so HMR reload
  // doesn't leak a danmaku-stream subscription on an old effect.
  useEffect(() => {
    if (aiChatEnabled.value) {
      startAiChatEngine()
    } else {
      stopAiChatEngine()
    }
    return () => stopAiChatEngine()
  }, [aiChatEnabled.value])

  // Always-on so users can pre-blacklist spammers via the chat-item menu even while 自动融入 is off.
  useEffect(() => {
    startUserBlacklistHijack()
    return () => stopUserBlacklistHijack()
  }, [])

  // Signal-driven and idempotent; mounted unconditionally so the 仅音频 toggle always exists.
  useEffect(() => {
    startAudioOnly()
    return () => stopAudioOnly()
  }, [])

  // Signal-driven (reads `autoSeekEnabled`) and a no-op while off; mounted unconditionally so the setting flips without a reload.
  useEffect(() => {
    startAutoSeek()
    return () => stopAutoSeek()
  }, [])

  // One-shot: polls for `livePlayer`, switches to 原画, stops. Runtime toggling intentionally
  // does NOT re-fire (applies on next reload); internal `started` guard makes remounts safe.
  useEffect(() => {
    startAutoQuality()
    return () => stopAutoQuality()
  }, [])

  // B站 re-applies inline styles on `.app-body` post-hydration, so use a !important <style>
  // rule its inline writes can't clobber; rule text is rewritten reactively via `textContent`.
  const layoutStyleRef = useRef<HTMLStyleElement | null>(null)
  useEffect(() => {
    // Clear stale inline margin from older versions; match the exact old value ('1rem') so we don't wipe one B站 set.
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

  // Cap `max-width`, not `margin-right`: B站 pins width via JS keyed to `window.innerWidth`, so a
  // margin frees no space. `calc(100% - …)` stays responsive without a resize listener; +24 covers
  // the dialog's `right-1` offset plus a gap, and `clampWidth` matches the dialog so reserve can't drift.
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
